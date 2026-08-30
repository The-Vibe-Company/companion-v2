import { sql } from "drizzle-orm";
import { z } from "zod";

import { sanitizeCompanionRuntimeError } from "./companionRuntimeErrors";
import {
  CompanionRuntimeCredentialError,
  decryptCompanionMcpRuntimeCredential,
} from "./companionRuntimeCredentials";
import { decryptOpaqueValue } from "./secretsCrypto";
import {
  COMPANION_PLUGIN_TRIGGER_KEY_PURPOSE,
  getCompanionPluginTriggerKeyEnvelope,
} from "./companionPluginTriggerKeys";
import type { Db } from "@companion/db";

/**
 * Provider-side webhook wiring for zero-friction triggers. Creation and chat approval invoke this
 * synchronously: GitHub reuses an attached MCP OAuth credential, while Linear uses its minimal
 * encrypted webhook key until its MCP authorization can cover remote registration.
 */
export class CompanionTriggerRegistrationError extends Error {
  constructor(
    readonly code:
      | "trigger_not_found"
      | "target_required"
      | "provider_unwired"
      | "plugin_not_attached"
      | "provider_account_ambiguous"
      | "plugin_auth_invalid"
      | "provider_rejected",
    message: string,
  ) {
    super(message);
    this.name = "CompanionTriggerRegistrationError";
  }
}

const GITHUB_API = "https://api.github.com";
const LINEAR_API = "https://api.linear.app/graphql";

/** The raw secret row the registration path needs: the secret doubles as the provider HMAC key. */
const registrationTriggerSchema = z.object({
  id: z.string().uuid(),
  companion_id: z.string().uuid(),
  name: z.string(),
  provider: z.enum(["webhook", "linear", "github", "custom"]),
  provider_account_id: z.string().uuid().nullable().default(null),
  target: z.object({ repo: z.string().optional(), events: z.array(z.string()).optional() })
    .nullable()
    .default(null),
  webhook_url: z.string().url(),
  secret: z.string().regex(/^[0-9a-f]{32,128}$/),
  remote_hook_id: z.string().nullable(),
  remote_hook_account_id: z.string().uuid().nullable().default(null),
});

type RegistrationTrigger = z.infer<typeof registrationTriggerSchema>;

async function loadRegistrationTrigger(input: {
  orgId: string;
  companionId: string;
  triggerId: string;
  webhookBaseUrl: string;
  database: Db;
}): Promise<RegistrationTrigger> {
  const result = await input.database.execute(sql`
    select public.companion_api_get_trigger_for_registration(
      ${input.orgId}::uuid,
      ${input.companionId}::uuid,
      ${input.triggerId}::uuid,
      ${input.webhookBaseUrl.replace(/\/+$/, "")}
    ) as trigger
  `);
  // SAFETY: database.execute resolves to an iterable of rows; the RPC above returns exactly one trigger column.
  const [row] = Array.from(result as Iterable<{ trigger: unknown }>);
  const parsed = registrationTriggerSchema.safeParse(row?.trigger);
  if (!parsed.success) {
    throw new CompanionTriggerRegistrationError("trigger_not_found", "companion trigger not found");
  }
  return parsed.data;
}

interface AttachedGithubQueryRow {
  id: unknown;
  credential_generation: unknown;
  ciphertext: unknown;
  iv: unknown;
  auth_tag: unknown;
  wrapped_dek: unknown;
  wrap_iv: unknown;
  wrap_auth_tag: unknown;
  key_id: unknown;
}

interface AttachedGithubAccount {
  id: string;
  credentialGeneration: string;
  envelope: {
    ciphertext: string;
    iv: string;
    authTag: string;
    wrappedDek: string;
    wrapIv: string;
    wrapAuthTag: string;
    keyId: string;
  };
}

async function loadAttachedGithubAccount(input: {
  orgId: string;
  companionId: string;
  providerAccountId?: string | null;
  database: Db;
}): Promise<AttachedGithubAccount> {
  const result = await input.database.execute(sql`
    select account.id, account.credential_generation,
           account.ciphertext, account.iv, account.auth_tag,
           account.wrapped_dek, account.wrap_iv, account.wrap_auth_tag, account.key_id
    from public.companions companion
    join public.companion_mcp_accounts account
      on account.org_id = companion.org_id
     and COALESCE(companion.selected_mcp_account_ids, '[]'::jsonb) ? account.id::text
    where companion.org_id = ${input.orgId}::uuid
      and companion.id = ${input.companionId}::uuid
      and account.provider = 'github'
      and (${input.providerAccountId ?? null}::uuid is null
        or account.id = ${input.providerAccountId ?? null}::uuid)
    order by account.updated_at desc
    limit 2
  `);
  // SAFETY: database.execute resolves to an iterable of rows; this query selects exactly the AttachedGithubQueryRow columns above.
  const found = Array.from(result as Iterable<AttachedGithubQueryRow>);
  const [row] = found;
  if (!row) {
    throw new CompanionTriggerRegistrationError(
      "plugin_not_attached",
      "the github plugin must be attached before registering webhooks",
    );
  }
  if (found.length > 1) {
    throw new CompanionTriggerRegistrationError(
      "provider_account_ambiguous",
      "multiple attached github accounts are eligible; choose provider_account_id",
    );
  }
  return {
    id: String(row.id),
    credentialGeneration: String(row.credential_generation),
    envelope: {
      ciphertext: String(row.ciphertext),
      iv: String(row.iv),
      authTag: String(row.auth_tag),
      wrappedDek: String(row.wrapped_dek),
      wrapIv: String(row.wrap_iv),
      wrapAuthTag: String(row.wrap_auth_tag),
      keyId: String(row.key_id),
    },
  };
}

function githubTokenOf(account: AttachedGithubAccount, orgId: string, masterKey: Buffer): string {
  try {
    const credential = decryptCompanionMcpRuntimeCredential({
      orgId,
      accountId: account.id,
      credentialGeneration: account.credentialGeneration,
      envelope: account.envelope,
    }, masterKey);
    if (credential.kind !== "oauth") throw new Error("expected an oauth credential");
    return credential.credential.accessToken;
  } catch (error) {
    if (error instanceof CompanionRuntimeCredentialError) {
      throw new CompanionTriggerRegistrationError(
        "plugin_auth_invalid",
        "the github plugin credential is unreadable; reconnect the plugin",
      );
    }
    throw error;
  }
}

async function persistRegistration(input: {
  orgId: string;
  companionId: string;
  triggerId: string;
  accountId: string | null;
  remoteHookId: string | null;
  status: "manual" | "registered" | "failed";
  error: string | null;
  database: Db;
}): Promise<void> {
  await input.database.execute(sql`
    select public.companion_api_set_trigger_registration(
      ${input.orgId}::uuid,
      ${input.companionId}::uuid,
      ${input.triggerId}::uuid,
      ${input.accountId}::uuid,
      ${input.remoteHookId},
      ${input.status},
      ${input.error}
    )
  `);
}

export type CompanionTriggerRegistrationOutcome =
  | { status: "registered"; remote_hook_id: string }
  | { status: "failed"; error: string }
  | { status: "manual" };

const LINEAR_CREATE_MUTATION = `
  mutation WebhookCreate($input: WebhookSubscriptionCreateInput!) {
    webhookSubscriptionCreate(input: $input) {
      success
      webhookSubscription { id }
    }
  }
`;

const LINEAR_DELETE_MUTATION = `
  mutation WebhookDelete($id: String!) {
    webhookSubscriptionDelete(id: $id) { success }
  }
`;

async function linearTriggerKeyToken(input: {
  orgId: string;
  companionId: string;
  masterKey: Buffer;
  database: Db;
}): Promise<{ accountId: string; token: string }> {
  const envelope = await getCompanionPluginTriggerKeyEnvelope({
    orgId: input.orgId,
    companionId: input.companionId,
    provider: "linear",
    database: input.database,
  });
  if (!envelope) {
    throw new CompanionTriggerRegistrationError(
      "provider_unwired",
      "linear registration needs the minimal encrypted webhook credential",
    );
  }
  let token: string;
  try {
    token = decryptOpaqueValue({
      orgId: input.orgId,
      purpose: COMPANION_PLUGIN_TRIGGER_KEY_PURPOSE,
      subjectId: `${envelope.account_id}:${envelope.credential_generation}`,
      ciphertext: envelope.ciphertext,
      iv: envelope.iv,
      authTag: envelope.auth_tag,
      wrappedDek: envelope.wrapped_dek,
      wrapIv: envelope.wrap_iv,
      wrapAuthTag: envelope.wrap_auth_tag,
      keyId: envelope.key_id,
    }, input.masterKey);
  } catch {
    throw new CompanionTriggerRegistrationError(
      "plugin_auth_invalid",
      "the Linear trigger key is unreadable; store it again",
    );
  }
  return { accountId: envelope.account_id, token };
}

async function registerLinearTriggerWebhook(
  input: Parameters<typeof loadRegistrationTrigger>[0] & { masterKey: Buffer; fetch?: typeof globalThis.fetch },
  trigger: RegistrationTrigger,
): Promise<CompanionTriggerRegistrationOutcome> {
  const key = await linearTriggerKeyToken(input);
  const doFetch = input.fetch ?? globalThis.fetch;
  let response: Response;
  try {
    response = await doFetch(LINEAR_API, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: key.token.trim(),
      },
      body: JSON.stringify({
        query: LINEAR_CREATE_MUTATION,
        variables: {
          input: { url: trigger.webhook_url, secret: trigger.secret, allTeams: true },
        },
      }),
    });
  } catch {
    return persistLinearFailure(input, "linear webhook registration could not reach the provider");
  }
  const payload = z.object({
    data: z.object({
      webhookSubscriptionCreate: z.object({
        success: z.boolean(),
        webhookSubscription: z.object({ id: z.string() }).nullable(),
      }).optional(),
    }).optional(),
    errors: z.array(z.object({ message: z.string() })).optional(),
  }).safeParse(await response.json().catch(() => null));
  const created = payload.success
    ? payload.data.data?.webhookSubscriptionCreate
    : undefined;
  if (!response.ok || !created?.success || !created.webhookSubscription) {
    await persistRegistration({
      orgId: input.orgId,
      companionId: input.companionId,
      triggerId: input.triggerId,
      accountId: null,
      remoteHookId: null,
      status: "failed",
      error: sanitizeCompanionRuntimeError(
        `linear rejected the webhook (${response.status})`,
      ).slice(0, 500),
      database: input.database,
    });
    return { status: "failed", error: `linear rejected the webhook (${response.status})` };
  }
  const remoteHookId = created.webhookSubscription.id;
  await persistRegistration({
    orgId: input.orgId,
    companionId: input.companionId,
    triggerId: input.triggerId,
    accountId: key.accountId,
    remoteHookId,
    status: "registered",
    error: null,
    database: input.database,
  });
  return { status: "registered", remote_hook_id: remoteHookId };
}

async function persistLinearFailure(
  input: { orgId: string; companionId: string; triggerId: string; database: Db },
  message: string,
): Promise<{ status: "failed"; error: string }> {
  await persistRegistration({
    orgId: input.orgId,
    companionId: input.companionId,
    triggerId: input.triggerId,
    accountId: null,
    remoteHookId: null,
    status: "failed",
    error: sanitizeCompanionRuntimeError(message).slice(0, 500),
    database: input.database,
  });
  return { status: "failed", error: message };
}

/**
 * Attempt the provider-side wiring. Provider rejection is a recorded outcome (`failed`), never an
 * exception: the failure row must survive the caller's transaction. Missing, ambiguous, revoked,
 * or insufficient credentials are persisted as failed registration state for an explicit retry.
 */
export async function registerCompanionTriggerWebhookV2(input: {
  orgId: string;
  companionId: string;
  triggerId: string;
  webhookBaseUrl: string;
  masterKey: Buffer;
  database: Db;
  fetch?: typeof globalThis.fetch;
}): Promise<CompanionTriggerRegistrationOutcome> {
  const trigger = await loadRegistrationTrigger(input);
  if (trigger.provider === "linear") {
    try {
      return await registerLinearTriggerWebhook(input, trigger);
    } catch (error) {
      const message = error instanceof CompanionTriggerRegistrationError
        ? error.message
        : "linear credential could not be resolved";
      return persistLinearFailure(input, message);
    }
  }
  if (trigger.provider === "custom") {
    return { status: "manual" };
  }
  if (trigger.provider === "webhook") {
    return { status: "manual" };
  }
  if (!trigger.target?.repo || !trigger.target.events?.length) {
    const message = "a github trigger needs a target repo and at least one event before registration";
    await persistRegistration({
      ...input,
      accountId: trigger.provider_account_id,
      remoteHookId: null,
      status: "failed",
      error: message,
    });
    return { status: "failed", error: message };
  }

  let account: AttachedGithubAccount;
  let token: string;
  try {
    account = await loadAttachedGithubAccount({
      ...input,
      providerAccountId: trigger.provider_account_id,
    });
    token = githubTokenOf(account, input.orgId, input.masterKey);
  } catch (error) {
    const message = error instanceof CompanionTriggerRegistrationError
      ? error.message
      : "github credential could not be resolved";
    await persistRegistration({
      ...input,
      accountId: trigger.provider_account_id,
      remoteHookId: null,
      status: "failed",
      error: sanitizeCompanionRuntimeError(message).slice(0, 500),
    });
    return { status: "failed", error: message };
  }
  const doFetch = input.fetch ?? globalThis.fetch;
  // Encode each path segment separately so the owner/repo slash survives.
  const repoPath = trigger.target.repo.split("/").map(encodeURIComponent).join("/");
  let response: Response;
  try {
    response = await doFetch(
      `${GITHUB_API}/repos/${repoPath}/hooks`,
      {
        method: "POST",
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "user-agent": "companion-github-sync",
          "x-github-api-version": "2022-11-28",
        },
        body: JSON.stringify({
          name: "web",
          active: true,
          events: trigger.target.events,
          config: {
            url: trigger.webhook_url,
            content_type: "json",
            secret: trigger.secret,
          },
        }),
      },
    );
  } catch (error) {
    await persistRegistration({
      ...input,
      accountId: account.id,
      remoteHookId: null,
      status: "failed",
      error: sanitizeCompanionRuntimeError(
        error instanceof Error ? error.message : "github webhook registration failed",
      ).slice(0, 500),
    });
    return { status: "failed", error: "github webhook registration could not reach the provider" };
  }
  if (!response.ok) {
    // The provider has the final word on unknown event names and missing permissions.
    const message = sanitizeCompanionRuntimeError(
      `github rejected the webhook (${response.status})`,
    ).slice(0, 500);
    await persistRegistration({
      ...input,
      accountId: account.id,
      remoteHookId: null,
      status: "failed",
      error: message,
    });
    return { status: "failed", error: message };
  }
  const created = z.object({ id: z.number().int() }).safeParse(await response.json().catch(() => null));
  if (!created.success) {
    await persistRegistration({
      ...input,
      accountId: account.id,
      remoteHookId: null,
      status: "failed",
      error: "github returned an unreadable webhook payload",
    });
    return { status: "failed", error: "github returned an unreadable webhook payload" };
  }
  const remoteHookId = String(created.data.id);
  await persistRegistration({
    ...input,
    accountId: account.id,
    remoteHookId,
    status: "registered",
    error: null,
  });
  return { status: "registered", remote_hook_id: remoteHookId };
}

export async function unregisterCompanionTriggerWebhookV2(input: {
  orgId: string;
  companionId: string;
  triggerId: string;
  webhookBaseUrl: string;
  masterKey: Buffer;
  database: Db;
  fetch?: typeof globalThis.fetch;
}): Promise<void> {
  const trigger = await loadRegistrationTrigger(input);
  if (trigger.provider === "linear") {
    if (!trigger.remote_hook_id) {
      await persistRegistration({
        ...input,
        accountId: null,
        remoteHookId: null,
        status: "manual",
        error: null,
      });
      return;
    }
    const key = await linearTriggerKeyToken(input);
    const doFetch = input.fetch ?? globalThis.fetch;
    let response: Response;
    try {
      response = await doFetch(LINEAR_API, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: key.token.trim() },
        body: JSON.stringify({
          query: LINEAR_DELETE_MUTATION,
          variables: { id: trigger.remote_hook_id },
        }),
      });
    } catch {
      throw new CompanionTriggerRegistrationError(
        "provider_rejected",
        "linear webhook removal could not reach the provider; the registration is kept",
      );
    }
    if (!response.ok) {
      throw new CompanionTriggerRegistrationError(
        "provider_rejected",
        `linear refused to remove the webhook (${response.status})`,
      );
    }
    await persistRegistration({
      ...input,
      accountId: null,
      remoteHookId: null,
      status: "manual",
      error: null,
    });
    return;
  }
  if (trigger.provider !== "github" || !trigger.target?.repo || !trigger.remote_hook_id) {
    await persistRegistration({
      ...input,
      accountId: null,
      remoteHookId: null,
      status: "manual",
      error: null,
    });
    return;
  }
  const account = await loadAttachedGithubAccount({
    ...input,
    providerAccountId: trigger.remote_hook_account_id ?? trigger.provider_account_id,
  });
  const token = githubTokenOf(account, input.orgId, input.masterKey);
  const doFetch = input.fetch ?? globalThis.fetch;
  const repoPath = trigger.target.repo.split("/").map(encodeURIComponent).join("/");
  let response: Response | null;
  try {
    response = await doFetch(
      `${GITHUB_API}/repos/${repoPath}/hooks/${encodeURIComponent(trigger.remote_hook_id)}`,
      {
        method: "DELETE",
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${token}`,
          "user-agent": "companion-github-sync",
          "x-github-api-version": "2022-11-28",
        },
      },
    );
  } catch {
    // A transport failure leaves the remote hook live: keep the local wiring so the removal can
    // be retried instead of orphaning a webhook nobody remembers.
    throw new CompanionTriggerRegistrationError(
      "provider_rejected",
      "github webhook removal could not reach the provider; the registration is kept",
    );
  }
  if (!response.ok && response.status !== 404) {
    throw new CompanionTriggerRegistrationError(
      "provider_rejected",
      `github refused to remove the webhook (${response.status})`,
    );
  }
  await persistRegistration({
    ...input,
    accountId: null,
    remoteHookId: null,
    status: "manual",
    error: null,
  });
}
