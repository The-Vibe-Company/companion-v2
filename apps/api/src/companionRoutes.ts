import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import {
  companionAttachmentKey,
  deleteStorageObject,
  getSkillArchive,
  isStoragePreconditionFailure,
  putSkillArchive,
} from "@companion/storage";
import {
  COMPANION_PLUGIN_OAUTH_SERVERS,
  CompanionNotFoundError,
  CompanionDeleteForbiddenError,
  CompanionDuplicateForbiddenError,
  CompanionPluginConflictError,
  CompanionPluginOAuthError,
  CompanionProviderOAuthError,
  COMPANION_PROVIDER_OAUTH_TTL_MS,
  beginAnthropicProviderOAuth,
  beginOpenAICodexProviderOAuth,
  beginCompanionPluginOAuth,
  completeAnthropicProviderOAuth,
  completeCompanionPluginOAuth,
  decryptOpaqueValue,
  encryptOpaqueValue,
  loadSecretsMasterKey,
  type OpaqueCiphertext,
  CompanionProviderError,
  CompanionProviderForbiddenError,
  CompanionRuntimeForbiddenError,
  CompanionRuntimeTransitionError,
  CompanionDecisionConflictError,
  CompanionDecisionNotFoundError,
  CompanionShareForbiddenError,
  CompanionSettingsForbiddenError,
  CompanionSkillSelectionError,
  CompanionPluginSelectionError,
  CompanionWriteSkillsForbiddenError,
  companionsAvailableToUser,
  companionsEnabled,
  companionCatalogModel,
  getCompanionProviderCatalog,
  answerCompanionConfigDecisionV2,
  answerCompanionDecisionV2,
  cancelCompanionTurnV2,
  createCompanionV2,
  duplicateCompanionV2,
  enqueueCompanionOperationV2,
  enqueueCompanionTurnV2,
  getCompanionDecisionV2,
  getCompanionV2,
  listCompanionsV2,
  readCompanionAttachmentV2,
  readCompanionThreadV2,
  retryCompanionTurnV2,
  setCompanionWorkspaceShareV2,
  setCompanionProviderV2,
  updateCompanionMemberStateV2,
  updateCompanionV2,
  deleteCompanionPlugin,
  deleteCompanionProvider,
  listCompanionShares,
  listCompanionProviders,
  listCompanionPlugins,
  pollOpenAICodexProviderOAuth,
  saveCompanionProvider,
  saveCompanionPlugin,
  saveCompanionOAuthPlugin,
  setDefaultCompanionProvider,
} from "@companion/core";
import {
  COMPANION_ATTACHMENT_MAX_BYTES,
  COMPANION_MESSAGE_ATTACHMENT_MAX_COUNT,
  type CompanionAttachmentUpload,
  type CompanionRuntimeSafeError,
  type CompanionThread,
  type CompanionTurn,
  type SendCompanionMessageInput,
  createCompanionInputSchema,
  declaredCompanionAttachmentContentType,
  isCompanionAttachmentImage,
  sanitizeCompanionAttachmentFilename,
  sniffCompanionAttachmentMime,
  cancelCompanionTurnInputSchema,
  companionProviderIdSchema,
  companionProviderOAuthCompleteInputSchema,
  companionProviderOAuthStartInputSchema,
  companionPluginOAuthStartInputSchema,
  decideCompanionDecisionInputSchema,
  saveCompanionProviderInputSchema,
  sendCompanionMessageInputSchema,
  setCompanionProviderInputSchema,
  setCompanionWorkspaceShareInputSchema,
  setDefaultCompanionProviderInputSchema,
  startCompanionRuntimeInputSchema,
  saveCompanionPluginInputSchema,
  updateCompanionInputSchema,
  updateCompanionMemberStateInputSchema,
  retryCompanionTurnInputSchema,
} from "@companion/contracts";
import {
  COMPANION_OPERATION_IDEMPOTENCY_HEADER,
  companionOperationRequestIdSchema,
  restartCompanionRuntimeInputSchema,
} from "@companion/contracts/companion-runtime";
import { withTenantContext, type Db } from "@companion/db";
import {
  actorFromContext,
  AuthenticationRequiredError,
  jsonError,
  orgIdFromContext,
  type ApiVariables,
} from "./context";
import { mintCompanionDesktop, RuntimeDesktopClientError } from "./runtimeDesktopClient";

const companionIdSchema = z.string().uuid();

const COMPANION_PLUGIN_OAUTH_FLOW_PURPOSE = "companion-mcp-oauth-flow";
const COMPANION_PLUGIN_OAUTH_TTL_MS = 10 * 60_000;
const COMPANION_PROVIDER_OAUTH_FLOW_PURPOSE = "companion-provider-oauth-flow";
const COMPANION_PROVIDER_OAUTH_COOKIE = "companion_provider_oauth";

const VIEWER_RUNTIME_ERROR: CompanionRuntimeSafeError = {
  code: "runtime_unavailable",
  message: "Companion runtime needs attention.",
  action: "none",
};

/**
 * A Viewer can follow durable progress, but runtime diagnostics and their recovery hints belong to
 * the Owner/Editor operating boundary. Keep the same turn shape so polling remains stable while
 * replacing both the turn-level and attempt-level error with one non-actionable projection.
 */
function projectThreadForHttp(thread: CompanionThread): CompanionThread {
  if (thread.access !== "viewer") return thread;

  const projectTurn = (turn: CompanionTurn | null): CompanionTurn | null => turn === null
    ? null
    : {
        ...turn,
        error: turn.error === null ? null : { ...VIEWER_RUNTIME_ERROR },
        latest_attempt: turn.latest_attempt === null
          ? null
          : {
              ...turn.latest_attempt,
              error: turn.latest_attempt.error === null
                ? null
                : { ...VIEWER_RUNTIME_ERROR },
            },
      };

  return {
    ...thread,
    active_turn: projectTurn(thread.active_turn),
    interrupted_turn: projectTurn(thread.interrupted_turn),
  };
}

type CompanionPluginOAuthState = {
  orgId: string;
  userId: string;
  nonce: string;
  expiresAt: number;
};

function companionPluginOAuthRedirectUri(env: NodeJS.ProcessEnv): string {
  const base = env.COMPANION_WEB_URL ?? "http://127.0.0.1:3000";
  return new URL("/v1/companion-plugins/oauth/callback", base).toString();
}

function companionPluginOAuthCookieName(nonce: string): string {
  return `companion_mcp_oauth_${nonce.replaceAll("-", "")}`;
}

function signCompanionPluginOAuthState(
  payload: CompanionPluginOAuthState,
  masterKey: Buffer,
): string {
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = createHmac("sha256", masterKey).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
}

function verifyCompanionPluginOAuthState(
  value: string,
  masterKey: Buffer,
): CompanionPluginOAuthState {
  const [encoded, signature] = value.split(".");
  if (!encoded || !signature) throw new Error("invalid OAuth state");
  const expected = createHmac("sha256", masterKey).update(encoded).digest();
  const actual = Buffer.from(signature, "base64url");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new Error("invalid OAuth state");
  }
  const parsed = JSON.parse(
    Buffer.from(encoded, "base64url").toString("utf8"),
  ) as CompanionPluginOAuthState;
  if (
    !parsed.orgId
    || !parsed.userId
    || !parsed.nonce
    || parsed.expiresAt < Date.now()
  ) {
    throw new Error("expired OAuth state");
  }
  return parsed;
}

function encodeCompanionPluginOAuthFlow(input: {
  orgId: string;
  nonce: string;
  value: unknown;
  masterKey: Buffer;
}): string {
  const encrypted = encryptOpaqueValue({
    orgId: input.orgId,
    purpose: COMPANION_PLUGIN_OAUTH_FLOW_PURPOSE,
    subjectId: input.nonce,
    value: JSON.stringify(input.value),
  }, input.masterKey);
  return Buffer.from(JSON.stringify(encrypted), "utf8").toString("base64url");
}

function decodeCompanionPluginOAuthFlow(input: {
  orgId: string;
  nonce: string;
  value: string;
  masterKey: Buffer;
}): { label: string; flow: Awaited<ReturnType<typeof beginCompanionPluginOAuth>>["flow"] } {
  const encrypted = JSON.parse(
    Buffer.from(input.value, "base64url").toString("utf8"),
  ) as OpaqueCiphertext;
  const plaintext = decryptOpaqueValue({
    orgId: input.orgId,
    purpose: COMPANION_PLUGIN_OAUTH_FLOW_PURPOSE,
    subjectId: input.nonce,
    ...encrypted,
  }, input.masterKey);
  return JSON.parse(plaintext) as {
    label: string;
    flow: Awaited<ReturnType<typeof beginCompanionPluginOAuth>>["flow"];
  };
}

type CompanionProviderOAuthCookie = {
  orgId: string;
  nonce: string;
  encrypted: OpaqueCiphertext;
};

function encodeCompanionProviderOAuthFlow(input: {
  orgId: string;
  userId: string;
  flow:
    | ReturnType<typeof beginAnthropicProviderOAuth>["flow"]
    | Awaited<ReturnType<typeof beginOpenAICodexProviderOAuth>>["flow"];
  masterKey: Buffer;
}): string {
  const nonce = randomUUID();
  const encrypted = encryptOpaqueValue({
    orgId: input.orgId,
    purpose: COMPANION_PROVIDER_OAUTH_FLOW_PURPOSE,
    subjectId: nonce,
    value: JSON.stringify({ userId: input.userId, flow: input.flow }),
  }, input.masterKey);
  return Buffer.from(JSON.stringify({ orgId: input.orgId, nonce, encrypted }), "utf8")
    .toString("base64url");
}

function decodeCompanionProviderOAuthFlow(input: {
  value: string;
  masterKey: Buffer;
}): {
  orgId: string;
  userId: string;
  flow:
    | ReturnType<typeof beginAnthropicProviderOAuth>["flow"]
    | Awaited<ReturnType<typeof beginOpenAICodexProviderOAuth>>["flow"];
} {
  const cookie = JSON.parse(
    Buffer.from(input.value, "base64url").toString("utf8"),
  ) as CompanionProviderOAuthCookie;
  const plaintext = decryptOpaqueValue({
    orgId: cookie.orgId,
    purpose: COMPANION_PROVIDER_OAUTH_FLOW_PURPOSE,
    subjectId: cookie.nonce,
    ...cookie.encrypted,
  }, input.masterKey);
  const pending = JSON.parse(plaintext) as {
    userId: string;
    flow:
      | ReturnType<typeof beginAnthropicProviderOAuth>["flow"]
      | Awaited<ReturnType<typeof beginOpenAICodexProviderOAuth>>["flow"];
  };
  if (!pending.userId || !pending.flow || pending.flow.expiresAt < Date.now()) {
    throw new CompanionProviderOAuthError("oauth_expired", "Provider sign-in expired. Start again.");
  }
  return { orgId: cookie.orgId, ...pending };
}

class CompanionAccessForbiddenError extends Error {
  constructor() {
    super("Companions access is not available for this user");
    this.name = "CompanionAccessForbiddenError";
  }
}

function databaseErrorCode(error: unknown): string | null {
  const seen = new Set<unknown>();
  let current = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    if ("code" in current && typeof current.code === "string") return current.code;
    current = "cause" in current ? current.cause : null;
  }
  return null;
}
function errorStatus(error: unknown): number {
  const databaseCode = databaseErrorCode(error);
  if (databaseCode === "42501") return 403;
  if (databaseCode === "P0002" || databaseCode === "02000") return 404;
  if (["23505", "40001", "55000"].includes(databaseCode ?? "")) return 409;
  if (error instanceof AuthenticationRequiredError) return 401;
  if (error instanceof CompanionAccessForbiddenError) return 403;
  if (error instanceof CompanionNotFoundError) return 404;
  if (error instanceof CompanionDecisionNotFoundError) return 404;
  if (error instanceof CompanionDecisionConflictError) return 409;
  if (error instanceof CompanionRuntimeForbiddenError) return 403;
  if (error instanceof CompanionSettingsForbiddenError) return 403;
  if (error instanceof CompanionSkillSelectionError) return 400;
  if (error instanceof CompanionPluginSelectionError) return 400;
  if (error instanceof CompanionWriteSkillsForbiddenError) return 403;
  if (error instanceof CompanionDeleteForbiddenError) return 403;
  if (error instanceof CompanionDuplicateForbiddenError) return 403;
  if (error instanceof CompanionProviderForbiddenError) return 403;
  if (error instanceof CompanionShareForbiddenError) return 403;
  if (error instanceof CompanionProviderError) return 422;
  if (error instanceof CompanionRuntimeTransitionError) return 409;
  if (error instanceof CompanionPluginConflictError) return 409;
  if (error instanceof CompanionPluginOAuthError) {
    if (error.code === "oauth_not_supported") return 400;
    if (error.code === "oauth_not_configured") return 503;
    return 502;
  }
  if (error instanceof CompanionProviderOAuthError) {
    return error.code === "oauth_unavailable" ? 502 : 400;
  }
  if (error instanceof RuntimeDesktopClientError) {
    if (error.code === "not_configured") return 503;
    if (error.code === "forbidden") return 403;
    return 502;
  }
  if (error instanceof z.ZodError) return 400;
  return 400;
}

function routeError(c: Context, error: unknown): Response {
  if (error instanceof CompanionProviderError) {
    return c.json({
      ok: false,
      error: error.message,
      code: error.code,
      provider_id: error.providerId,
    }, errorStatus(error) as never);
  }
  return jsonError(c, error, errorStatus(error));
}

/**
 * The largest multipart send body the API will read. It is the attachment budget plus room for the
 * form's own framing, so a request that would only be refused later is refused before it is buffered.
 */
const COMPANION_MESSAGE_UPLOAD_LIMIT_BYTES = 64 * 1024 * 1024;

/**
 * True for a failure raised by the object-storage client rather than by this route's own validation.
 * The AWS SDK stamps `$metadata` on every error it produces, which is what distinguishes it from a
 * `ZodError`, a domain error, or a database error.
 */
function isStorageFailure(error: unknown): boolean {
  return typeof error === "object" && error !== null && "$metadata" in error;
}

/** One text field of a multipart send, or null when the part is absent or is a file. */
function formField(form: FormData, name: string): string | undefined {
  const value = form.get(name);
  return typeof value === "string" ? value : undefined;
}

export function registerCompanionRoutes(
  app: Hono<{ Variables: ApiVariables }>,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!companionsEnabled(env)) return;

  async function tenant<T>(
    c: Context<{ Variables: ApiVariables }>,
    fn: (input: {
      actor: ReturnType<typeof actorFromContext>;
      orgId: string;
      database: Db;
    }) => Promise<T>,
  ): Promise<T> {
    const actor = actorFromContext(c);
    if (!companionsAvailableToUser(actor.email, env)) {
      throw new CompanionAccessForbiddenError();
    }
    const orgId = await orgIdFromContext(c);
    return withTenantContext({ orgId, userId: actor.id }, (database) =>
      fn({ actor, orgId, database }));
  }

  app.get("/v1/companions", async (c) => {
    try {
      // `preview=false` answers with the roster and nothing anyone said. It is for a caller that
      // needs names and attachments — the Skills page asking which Companions stage a skill — and
      // keeps chat text off a surface that displays none of it.
      const withLastMessage = c.req.query("preview") !== "false";
      const companions = await tenant(c, ({ actor, orgId, database }) =>
        listCompanionsV2({ actor, orgId, withLastMessage, database }));
      // The list carries each thread's last line now, so it is chat text and must not sit in a disk
      // cache after the session that read it, the way every other sensitive read here is treated.
      c.header("Cache-Control", "private, no-store");
      return c.json({ companions });
    } catch (error) {
      return jsonError(c, error, errorStatus(error));
    }
  });

  app.post("/v1/companions", async (c) => {
    try {
      const body = createCompanionInputSchema.parse(await c.req.json());
      const companion = await tenant(c, ({ actor, orgId, database }) =>
        createCompanionV2({
          actor,
          orgId,
          name: body.name,
          persona: body.persona,
          providerId: body.provider_id,
          modelId: body.model_id,
          selectedSkillIds: body.selected_skill_ids,
          selectedMcpAccountIds: body.selected_mcp_account_ids,
          database,
        }));
      return c.json({ companion }, 201);
    } catch (error) {
      return routeError(c, error);
    }
  });

  app.get("/v1/companion-providers", async (c) => {
    try {
      const providers = await tenant(c, ({ actor, orgId, database }) =>
        listCompanionProviders({ actor, orgId, database }));
      return c.json(providers);
    } catch (error) {
      return routeError(c, error);
    }
  });

  app.post("/v1/companion-providers/oauth/start", async (c) => {
    try {
      const body = companionProviderOAuthStartInputSchema.parse(await c.req.json());
      const context = await tenant(c, async ({ actor, orgId, database }) => {
        const providers = await listCompanionProviders({ actor, orgId, database });
        if (!providers.can_manage) throw new CompanionProviderForbiddenError();
        return { actor, orgId };
      });
      const masterKey = loadSecretsMasterKey(env.COMPANION_SECRETS_MASTER_KEY);
      const storePendingFlow = (
        flow: Parameters<typeof encodeCompanionProviderOAuthFlow>[0]["flow"],
      ) => {
        setCookie(c, COMPANION_PROVIDER_OAUTH_COOKIE, encodeCompanionProviderOAuthFlow({
          orgId: context.orgId,
          userId: context.actor.id,
          flow,
          masterKey,
        }), {
          path: "/v1/companion-providers/oauth",
          httpOnly: true,
          sameSite: "Lax",
          secure: env.NODE_ENV === "production",
          maxAge: COMPANION_PROVIDER_OAUTH_TTL_MS / 1000,
        });
      };
      if (body.provider_id === "anthropic") {
        const started = beginAnthropicProviderOAuth();
        storePendingFlow(started.flow);
        return c.json({
          flow: "authorization_code",
          provider_id: "anthropic",
          authorization_url: started.authorizationUrl,
        });
      }
      const started = await beginOpenAICodexProviderOAuth();
      storePendingFlow(started.flow);
      return c.json({
        flow: "device_code",
        provider_id: "openai-codex",
        verification_url: started.verificationUrl,
        user_code: started.userCode,
        poll_interval_seconds: started.pollIntervalSeconds,
        expires_at: new Date(started.flow.expiresAt).toISOString(),
      });
    } catch (error) {
      return routeError(c, error);
    }
  });

  app.post("/v1/companion-providers/oauth/complete", async (c) => {
    try {
      const body = companionProviderOAuthCompleteInputSchema.parse(await c.req.json());
      const context = await tenant(c, async ({ actor, orgId, database }) => {
        const providers = await listCompanionProviders({ actor, orgId, database });
        if (!providers.can_manage) throw new CompanionProviderForbiddenError();
        return { actor, orgId };
      });
      const masterKey = loadSecretsMasterKey(env.COMPANION_SECRETS_MASTER_KEY);
      const cookie = getCookie(c, COMPANION_PROVIDER_OAUTH_COOKIE);
      if (!cookie) {
        throw new CompanionProviderOAuthError("oauth_expired", "Provider sign-in expired. Start again.");
      }
      const pending = decodeCompanionProviderOAuthFlow({ value: cookie, masterKey });
      if (
        pending.userId !== context.actor.id
        || pending.orgId !== context.orgId
        || pending.flow.providerId !== "anthropic"
      ) {
        throw new CompanionProviderOAuthError("oauth_invalid", "Provider sign-in does not match this workspace.");
      }
      const credential = await completeAnthropicProviderOAuth({
        flow: pending.flow,
        authorizationInput: body.authorization_code,
      });
      const connection = await withTenantContext(
        { orgId: context.orgId, userId: context.actor.id },
        (database) => saveCompanionProvider({
          actor: context.actor,
          orgId: context.orgId,
          providerId: "anthropic",
          authMethod: "subscription",
          credential,
          masterKey,
          database,
        }),
      );
      setCookie(c, COMPANION_PROVIDER_OAUTH_COOKIE, "", {
        path: "/v1/companion-providers/oauth",
        maxAge: 0,
        httpOnly: true,
        sameSite: "Lax",
        secure: env.NODE_ENV === "production",
      });
      return c.json({ connection });
    } catch (error) {
      return routeError(c, error);
    }
  });

  app.post("/v1/companion-providers/oauth/poll", async (c) => {
    let clearCookieOnFailure = false;
    try {
      const context = await tenant(c, async ({ actor, orgId, database }) => {
        const providers = await listCompanionProviders({ actor, orgId, database });
        if (!providers.can_manage) throw new CompanionProviderForbiddenError();
        return { actor, orgId };
      });
      clearCookieOnFailure = true;
      const masterKey = loadSecretsMasterKey(env.COMPANION_SECRETS_MASTER_KEY);
      const cookie = getCookie(c, COMPANION_PROVIDER_OAUTH_COOKIE);
      if (!cookie) {
        throw new CompanionProviderOAuthError("oauth_expired", "Provider sign-in expired. Start again.");
      }
      const pending = decodeCompanionProviderOAuthFlow({ value: cookie, masterKey });
      if (
        pending.userId !== context.actor.id
        || pending.orgId !== context.orgId
        || pending.flow.providerId !== "openai-codex"
      ) {
        throw new CompanionProviderOAuthError("oauth_invalid", "Provider sign-in does not match this workspace.");
      }
      const result = await pollOpenAICodexProviderOAuth({ flow: pending.flow });
      if (result.status === "pending") return c.json({ status: "pending" }, 202);
      const connection = await withTenantContext(
        { orgId: context.orgId, userId: context.actor.id },
        (database) => saveCompanionProvider({
          actor: context.actor,
          orgId: context.orgId,
          providerId: "openai-codex",
          authMethod: "subscription",
          credential: result.credential,
          masterKey,
          database,
        }),
      );
      setCookie(c, COMPANION_PROVIDER_OAUTH_COOKIE, "", {
        path: "/v1/companion-providers/oauth",
        maxAge: 0,
        httpOnly: true,
        sameSite: "Lax",
        secure: env.NODE_ENV === "production",
      });
      return c.json({ status: "connected", connection });
    } catch (error) {
      if (
        clearCookieOnFailure
        && (!(error instanceof CompanionProviderOAuthError) || error.code !== "oauth_unavailable")
      ) {
        setCookie(c, COMPANION_PROVIDER_OAUTH_COOKIE, "", {
          path: "/v1/companion-providers/oauth",
          maxAge: 0,
          httpOnly: true,
          sameSite: "Lax",
          secure: env.NODE_ENV === "production",
        });
      }
      return routeError(c, error);
    }
  });

  app.get("/v1/companion-plugins", async (c) => {
    try {
      const accounts = await tenant(c, ({ actor, orgId, database }) =>
        listCompanionPlugins({ actor, orgId, database }));
      return c.json({ accounts });
    } catch (error) {
      return routeError(c, error);
    }
  });

  app.post("/v1/companion-plugins", async (c) => {
    try {
      const body = saveCompanionPluginInputSchema.parse(await c.req.json());
      const account = await tenant(c, ({ actor, orgId, database }) =>
        saveCompanionPlugin({ actor, orgId, plugin: body, database }));
      return c.json({ account }, 201);
    } catch (error) {
      return routeError(c, error);
    }
  });

  app.post("/v1/companion-plugins/oauth/start", async (c) => {
    try {
      const body = companionPluginOAuthStartInputSchema.parse(await c.req.json());
      const context = await tenant(c, async ({ actor, orgId, database }) => ({
        actor,
        orgId,
        accounts: await listCompanionPlugins({ actor, orgId, database }),
      }));
      const catalog = COMPANION_PLUGIN_OAUTH_SERVERS[body.server_name];
      if (context.accounts.some((account) =>
        account.provider === catalog.provider
        && account.label.toLocaleLowerCase("en-US") === body.label.toLocaleLowerCase("en-US"))) {
        throw new CompanionPluginConflictError();
      }
      const masterKey = loadSecretsMasterKey(env.COMPANION_SECRETS_MASTER_KEY);
      const nonce = randomUUID();
      const state = signCompanionPluginOAuthState({
        orgId: context.orgId,
        userId: context.actor.id,
        nonce,
        expiresAt: Date.now() + COMPANION_PLUGIN_OAUTH_TTL_MS,
      }, masterKey);
      const redirectUri = companionPluginOAuthRedirectUri(env);
      const started = await beginCompanionPluginOAuth({
        serverName: body.server_name,
        redirectUri,
        state,
        env,
      });
      setCookie(c, companionPluginOAuthCookieName(nonce), encodeCompanionPluginOAuthFlow({
        orgId: context.orgId,
        nonce,
        value: { label: body.label, flow: started.flow },
        masterKey,
      }), {
        path: "/v1/companion-plugins/oauth/callback",
        httpOnly: true,
        sameSite: "Lax",
        secure: env.NODE_ENV === "production",
        maxAge: COMPANION_PLUGIN_OAUTH_TTL_MS / 1000,
      });
      return c.json({ authorization_url: started.authorizationUrl });
    } catch (error) {
      return routeError(c, error);
    }
  });

  app.get("/v1/companion-plugins/oauth/callback", async (c) => {
    const web = env.COMPANION_WEB_URL ?? "http://127.0.0.1:3000";
    let cookieName: string | null = null;
    try {
      const actor = actorFromContext(c);
      if (!companionsAvailableToUser(actor.email, env)) {
        throw new CompanionAccessForbiddenError();
      }
      const masterKey = loadSecretsMasterKey(env.COMPANION_SECRETS_MASTER_KEY);
      const state = verifyCompanionPluginOAuthState(c.req.query("state") ?? "", masterKey);
      cookieName = companionPluginOAuthCookieName(state.nonce);
      if (actor.id !== state.userId) throw new Error("OAuth authorization session does not match");
      const cookie = getCookie(c, cookieName);
      if (!cookie) throw new Error("OAuth authorization session expired");
      if (c.req.query("error")) throw new Error("OAuth authorization was denied");
      const pending = decodeCompanionPluginOAuthFlow({
        orgId: state.orgId,
        nonce: state.nonce,
        value: cookie,
        masterKey,
      });
      const code = c.req.query("code");
      if (!code) throw new Error("OAuth provider did not return an authorization code");
      const credential = await completeCompanionPluginOAuth({
        flow: pending.flow,
        code,
        redirectUri: companionPluginOAuthRedirectUri(env),
      });
      await withTenantContext(
        { orgId: state.orgId, userId: actor.id },
        (database) => saveCompanionOAuthPlugin({
          actor,
          orgId: state.orgId,
          provider: pending.flow.provider,
          label: pending.label,
          remoteUrl: pending.flow.remoteUrl,
          credential,
          masterKey,
          database,
        }),
      );
      setCookie(c, "companion_org", state.orgId, {
        path: "/",
        sameSite: "Lax",
        secure: env.NODE_ENV === "production",
      });
      const target = new URL("/companions", web);
      target.searchParams.set("view", "plugins");
      target.searchParams.set("oauth", "connected");
      setCookie(c, cookieName, "", {
        path: "/v1/companion-plugins/oauth/callback",
        maxAge: 0,
        httpOnly: true,
        sameSite: "Lax",
        secure: env.NODE_ENV === "production",
      });
      return c.redirect(target.toString(), 303);
    } catch (error) {
      if (cookieName) {
        setCookie(c, cookieName, "", {
          path: "/v1/companion-plugins/oauth/callback",
          maxAge: 0,
          httpOnly: true,
          sameSite: "Lax",
          secure: env.NODE_ENV === "production",
        });
      }
      const target = new URL("/companions", web);
      target.searchParams.set("view", "plugins");
      target.searchParams.set(
        "oauth_error",
        error instanceof CompanionPluginConflictError ? "duplicate_label" : "authorization_failed",
      );
      return c.redirect(target.toString(), 303);
    }
  });

  app.delete("/v1/companion-plugins/:id", async (c) => {
    try {
      const accountId = companionIdSchema.parse(c.req.param("id"));
      await tenant(c, ({ actor, orgId, database }) =>
        deleteCompanionPlugin({ actor, orgId, accountId, database }));
      return c.json({ ok: true });
    } catch (error) {
      return routeError(c, error);
    }
  });

  app.put("/v1/companion-providers/default", async (c) => {
    try {
      const body = setDefaultCompanionProviderInputSchema.parse(await c.req.json());
      await tenant(c, ({ actor, orgId, database }) =>
        setDefaultCompanionProvider({
          actor,
          orgId,
          providerId: body.provider_id,
          database,
        }));
      return c.json({ ok: true });
    } catch (error) {
      return routeError(c, error);
    }
  });

  app.put("/v1/companion-providers/:provider", async (c) => {
    try {
      const providerId = companionProviderIdSchema.parse(c.req.param("provider"));
      const body = saveCompanionProviderInputSchema.parse(await c.req.json());
      const connection = await tenant(c, ({ actor, orgId, database }) =>
        saveCompanionProvider({
          actor,
          orgId,
          providerId,
          authMethod: body.auth_method,
          credential: body.credential,
          database,
        }));
      return c.json({ connection });
    } catch (error) {
      return routeError(c, error);
    }
  });

  app.delete("/v1/companion-providers/:provider", async (c) => {
    try {
      const providerId = companionProviderIdSchema.parse(c.req.param("provider"));
      await tenant(c, ({ actor, orgId, database }) =>
        deleteCompanionProvider({ actor, orgId, providerId, database }));
      return c.json({ ok: true });
    } catch (error) {
      return routeError(c, error);
    }
  });

  app.get("/v1/companions/:id", async (c) => {
    try {
      const companionId = companionIdSchema.parse(c.req.param("id"));
      const companion = await tenant(c, ({ actor, orgId, database }) =>
        getCompanionV2({ actor, orgId, companionId, withLastMessage: true, database }));
      c.header("Cache-Control", "private, no-store");
      return c.json({ companion });
    } catch (error) {
      return routeError(c, error);
    }
  });

  app.patch("/v1/companions/:id/member-state", async (c) => {
    try {
      const companionId = companionIdSchema.parse(c.req.param("id"));
      const patch = updateCompanionMemberStateInputSchema.parse(await c.req.json());
      const companion = await tenant(c, ({ actor, orgId, database }) =>
        updateCompanionMemberStateV2({ actor, orgId, companionId, patch, database }));
      return c.json({ companion });
    } catch (error) {
      return routeError(c, error);
    }
  });

  app.post("/v1/companions/:id/duplicate", async (c) => {
    try {
      const companionId = companionIdSchema.parse(c.req.param("id"));
      const companion = await tenant(c, ({ actor, orgId, database }) =>
        duplicateCompanionV2({ actor, orgId, companionId, database }));
      return c.json({ companion }, 201);
    } catch (error) {
      return routeError(c, error);
    }
  });

  app.patch("/v1/companions/:id", async (c) => {
    try {
      const companionId = companionIdSchema.parse(c.req.param("id"));
      const body = updateCompanionInputSchema.parse(await c.req.json());
      const patch: Record<string, unknown> = {};
      if (body.name !== undefined) patch.name = body.name;
      if (body.persona !== undefined) patch.persona = body.persona;
      if (body.provider_id !== undefined) patch.provider_id = body.provider_id;
      if (body.model_id !== undefined) patch.model_id = body.model_id;
      if (body.selected_skill_ids !== undefined) patch.selected_skill_ids = body.selected_skill_ids;
      if (body.selected_mcp_account_ids !== undefined) {
        patch.selected_mcp_account_ids = body.selected_mcp_account_ids;
      }
      const companion = await tenant(c, ({ actor, orgId, database }) =>
        updateCompanionV2({ actor, orgId, companionId, patch, database }));
      return c.json({ companion });
    } catch (error) {
      return routeError(c, error);
    }
  });

  app.delete("/v1/companions/:id", async (c) => {
    try {
      const companionId = companionIdSchema.parse(c.req.param("id"));
      const requestId = companionOperationRequestIdSchema.parse(
        c.req.header(COMPANION_OPERATION_IDEMPOTENCY_HEADER),
      );
      const accepted = await tenant(c, ({ orgId, database }) =>
        enqueueCompanionOperationV2({
          orgId,
          companionId,
          requestId,
          kind: "delete",
          clientSurface: "web",
          database,
        }));
      return c.json({ operation: accepted.operation }, 202);
    } catch (error) {
      return routeError(c, error);
    }
  });

  app.put("/v1/companions/:id/provider", async (c) => {
    try {
      const companionId = companionIdSchema.parse(c.req.param("id"));
      const body = setCompanionProviderInputSchema.parse(await c.req.json());
      const companion = await tenant(c, ({ actor, orgId, database }) =>
        setCompanionProviderV2({
          actor,
          orgId,
          companionId,
          providerId: body.provider_id,
          database,
        }));
      return c.json({ companion });
    } catch (error) {
      return routeError(c, error);
    }
  });

  app.get("/v1/companions/:id/shares", async (c) => {
    try {
      const companionId = companionIdSchema.parse(c.req.param("id"));
      const shares = await tenant(c, ({ actor, orgId, database }) =>
        listCompanionShares({ actor, orgId, companionId, database }));
      return c.json({ shares });
    } catch (error) {
      return routeError(c, error);
    }
  });

  app.put("/v1/companions/:id/shares/workspace", async (c) => {
    try {
      const companionId = companionIdSchema.parse(c.req.param("id"));
      const body = setCompanionWorkspaceShareInputSchema.parse(await c.req.json());
      const shares = await tenant(c, ({ actor, orgId, database }) =>
        setCompanionWorkspaceShareV2({ actor, orgId, companionId, role: body.role, database }));
      return c.json({ shares });
    } catch (error) {
      return routeError(c, error);
    }
  });

  app.get("/v1/companions/:id/thread", async (c) => {
    try {
      const companionId = companionIdSchema.parse(c.req.param("id"));
      const thread = await tenant(c, ({ actor, orgId, database }) =>
        readCompanionThreadV2({ actor, orgId, companionId, database }));
      c.header("Cache-Control", "private, no-store");
      return c.json({ thread: projectThreadForHttp(thread) });
    } catch (error) {
      return routeError(c, error);
    }
  });

  app.post(
    "/v1/companions/:id/messages",
    // Authenticate and, for a multipart send, authorize the Companion before the body-reading limit
    // middleware runs. A chunked request carries no Content-Length, so that middleware buffers the
    // entire body before it can measure it -- authorizing afterwards would let any authenticated
    // caller cost this process 64 MB of heap per in-flight request against a Companion they cannot
    // even see. A text-only send skips the extra read entirely.
    async (c, next) => {
      try {
        actorFromContext(c);
        if ((c.req.header("content-type") ?? "").includes("multipart/form-data")) {
          const companionId = companionIdSchema.parse(c.req.param("id"));
          const companion = await tenant(c, ({ actor, orgId, database }) =>
            getCompanionV2({ actor, orgId, companionId, database }));
          if (companion.access === "viewer") throw new CompanionRuntimeForbiddenError();
        }
      } catch (error) {
        return routeError(c, error);
      }
      await next();
    },
    // Five files at ten megabytes each, plus multipart overhead. A text-only send is orders of
    // magnitude under this and takes the JSON branch below.
    bodyLimit({
      maxSize: COMPANION_MESSAGE_UPLOAD_LIMIT_BYTES,
      onError: (c) => jsonError(c, "message exceeds the 64 MB upload limit", 413),
    }),
    async (c) => {
      const createdKeys: Array<{ key: string; etag?: string }> = [];
      try {
        const companionId = companionIdSchema.parse(c.req.param("id"));
        const contentType = c.req.header("content-type") ?? "";
        let attachments: CompanionAttachmentUpload[] = [];
        let body: SendCompanionMessageInput;

        if (contentType.includes("multipart/form-data")) {
          // Access was already decided by the middleware above, before the body was read. Resolve
          // the tenant again here for the key prefix; it is a cheap header/session read.
          const authorized = { orgId: await orgIdFromContext(c) };

          const form = await c.req.formData();
          body = sendCompanionMessageInputSchema.parse({
            content: formField(form, "content") ?? "",
            client_message_id: formField(form, "client_message_id"),
            ...(formField(form, "client_surface")
              ? { client_surface: formField(form, "client_surface") }
              : {}),
          });
          const files = form.getAll("file")
            .filter((part): part is Exclude<typeof part, string> => typeof part !== "string");
          if (files.length > COMPANION_MESSAGE_ATTACHMENT_MAX_COUNT) {
            throw new Error(
              `a message carries at most ${COMPANION_MESSAGE_ATTACHMENT_MAX_COUNT} attachments`,
            );
          }

          // Object writes happen outside any database transaction: a slow upload must not hold a
          // pooled connection open, and the enqueue below only persists metadata.
          for (const [position, file] of files.entries()) {
            if (file.size === 0) throw new Error("an attached file is empty");
            if (file.size > COMPANION_ATTACHMENT_MAX_BYTES) {
              throw new Error("each attachment must be 10 MB or smaller");
            }
            const bytes = Buffer.from(await file.arrayBuffer());
            // The stored type comes from the bytes, never from the declared MIME or the extension,
            // so a disguised file is refused before it is stored or staged for Pi to read.
            const resolved = sniffCompanionAttachmentMime(
              bytes,
              declaredCompanionAttachmentContentType({ type: file.type, name: file.name }),
            );
            if (!resolved) {
              throw new Error("attachments must be PNG, JPEG, WebP, GIF, PDF, CSV, text, Markdown, or JSON");
            }
            const sha256 = createHash("sha256").update(bytes).digest("hex");
            const key = companionAttachmentKey({
              kind: "message",
              orgId: authorized.orgId,
              companionId,
              clientMessageId: body.client_message_id,
              position,
              sha256,
            });
            try {
              const etag = await putSkillArchive({
                key,
                body: bytes,
                contentType: resolved,
                preventOverwrite: true,
              });
              // Remember the exact version this request wrote. If a concurrent request for the same
              // client_message_id adopts this key and commits a row for it, the delete below no
              // longer matches and is refused rather than stranding that row.
              createdKeys.push({ key, ...(etag ? { etag } : {}) });
            } catch (error) {
              // The object already exists. Because the key is the digest of these exact bytes, it
              // holds the same content -- almost always this request's own replay, whose turn is
              // already accepted. Adopt it, and never schedule it for cleanup: deleting it would
              // destroy the live bytes of an accepted message.
              if (!isStoragePreconditionFailure(error)) throw error;
            }
            attachments.push({
              storage_key: key,
              content_type: resolved,
              byte_size: bytes.length,
              sha256,
              filename: sanitizeCompanionAttachmentFilename({
                filename: file.name,
                position,
                contentType: resolved,
              }),
              position,
            });
          }
        } else {
          body = sendCompanionMessageInputSchema.parse(await c.req.json());
        }

        const accepted = await tenant(c, async ({ actor, orgId, database }) => {
          const { turn } = await enqueueCompanionTurnV2({
            actor,
            orgId,
            companionId,
            clientMessageId: body.client_message_id,
            content: body.content,
            clientSurface: body.client_surface,
            attachments,
            database,
          });
          return { turn };
        });
        c.header("Cache-Control", "private, no-store");
        return c.json(accepted, 202);
      } catch (error) {
        // The turn did not persist, so objects this request created belong to nothing.
        //
        // Two independent rules keep this from destroying an accepted message's bytes, because the
        // key is the digest of the content and is therefore identical to the key an accepted turn
        // already owns. First, the PUT above is create-only, so a key that already existed is never
        // in `createdKeys`. Second -- in case a self-hosted object store ignores the conditional
        // header -- a replay conflict is never cleaned up at all: that error means a turn with this
        // client_message_id is already accepted, and these are its files.
        if (databaseErrorCode(error) !== "23505") {
          await Promise.allSettled(createdKeys.map((created) => deleteStorageObject({
            key: created.key,
            ...(created.etag ? { ifMatch: created.etag } : {}),
          })));
        }
        // An object-storage failure names the bucket, and a connection failure names the internal
        // endpoint. Neither belongs in a reply to a member, so a storage fault answers with a fixed
        // line while the underlying error stays in this process's logs.
        if (isStorageFailure(error)) {
          return c.json({ ok: false, error: "the attachments could not be stored" }, 502);
        }
        return routeError(c, error);
      }
    },
  );

  /**
   * Serve one attachment to a reader who may read the thread. This is a PostgreSQL-plus-object-storage
   * read: it never wakes, observes, or otherwise contacts the Box, so a Viewer opening a thread costs
   * a sleeping Companion nothing.
   */
  app.get("/v1/companions/:id/attachments/:attachmentId", async (c) => {
    try {
      const companionId = companionIdSchema.parse(c.req.param("id"));
      const attachmentId = companionIdSchema.parse(c.req.param("attachmentId"));
      const asset = await tenant(c, ({ actor, orgId, database }) =>
        readCompanionAttachmentV2({ actor, orgId, companionId, attachmentId, database }));
      const bytes = await getSkillArchive({ key: asset.storageKey });
      return new Response(bytes, {
        headers: {
          "Content-Type": asset.contentType,
          // Access is re-decided on every request, so a cached copy must not outlive the access that
          // fetched it. An image still renders; it is simply revalidated.
          "Cache-Control": "private, no-cache",
          // User-uploaded and Pi-produced bytes alike: never let a browser sniff them into a type
          // that could execute.
          "X-Content-Type-Options": "nosniff",
          // An image belongs inline in the thread; anything else is a file the reader asked for.
          "Content-Disposition": isCompanionAttachmentImage(asset.contentType)
            ? `inline; filename="${asset.filename}"`
            : `attachment; filename="${asset.filename}"`,
        },
      });
    } catch (error) {
      // An unreadable thread, an unknown attachment, and a cross-tenant id are deliberately
      // indistinguishable to the request that asked for the bytes. The message is fixed rather than
      // the underlying one: object-storage errors name the storage key and the internal endpoint,
      // neither of which a reader may learn.
      return c.json(
        { ok: false, error: "attachment not found" },
        errorStatus(error) === 403 ? 403 : 404,
      );
    }
  });

  app.post("/v1/companions/:id/decisions/:requestId", async (c) => {
    try {
      const companionId = companionIdSchema.parse(c.req.param("id"));
      const requestId = z.string().min(1).max(200).parse(c.req.param("requestId"));
      const body = decideCompanionDecisionInputSchema.parse(await c.req.json());
      const thread = await tenant(c, async ({ actor, orgId, database }) => {
        const pending = await getCompanionDecisionV2({
          orgId,
          companionId,
          requestId,
          database,
        });
        if (pending.requestKind === "config_proposal") {
          if (body.action === "answer") {
            throw new Error("Companion config proposals cannot be answered with free text");
          }
          if (body.action === "allow" && pending.proposal?.model_id) {
            const companion = await getCompanionV2({ actor, orgId, companionId, database });
            const providerId = companion.runtime.provider_ids[0];
            const modelId = providerId
              ? companionCatalogModel(
                await getCompanionProviderCatalog(),
                providerId,
                pending.proposal.model_id,
              )
              : undefined;
            if (!modelId) {
              throw new CompanionProviderError(
                "provider_model_invalid",
                "The selected model is not available for this provider.",
                providerId ?? null,
              );
            }
          }
          await answerCompanionConfigDecisionV2({
            orgId,
            companionId,
            requestId,
            decision: body.action,
            database,
          });
        } else {
          await answerCompanionDecisionV2({
            orgId,
            companionId,
            requestId,
            decision: body.action,
            text: body.action === "answer" ? body.answer : undefined,
            database,
          });
        }
        return projectThreadForHttp(
          await readCompanionThreadV2({ actor, orgId, companionId, database }),
        );
      });
      return c.json({ thread }, 202);
    } catch (error) {
      return routeError(c, error);
    }
  });

  app.post("/v1/companions/:id/turns/:turnId/retry", async (c) => {
    try {
      const companionId = companionIdSchema.parse(c.req.param("id"));
      const turnId = companionIdSchema.parse(c.req.param("turnId"));
      const body = retryCompanionTurnInputSchema.parse(await c.req.json());
      const accepted = await tenant(c, ({ orgId, database }) => retryCompanionTurnV2({
        orgId,
        companionId,
        turnId,
        retryId: body.retry_id,
        clientSurface: "web",
        database,
      }));
      return c.json({ operation: accepted.operation }, 202);
    } catch (error) {
      return routeError(c, error);
    }
  });

  app.post("/v1/companions/:id/turns/:turnId/cancel", async (c) => {
    try {
      const companionId = companionIdSchema.parse(c.req.param("id"));
      const turnId = companionIdSchema.parse(c.req.param("turnId"));
      cancelCompanionTurnInputSchema.parse(await c.req.json().catch(() => ({})));
      const accepted = await tenant(c, async ({ actor, orgId, database }) => {
        const turn = await cancelCompanionTurnV2({ orgId, companionId, turnId, database });
        const thread = await readCompanionThreadV2({ actor, orgId, companionId, database });
        return { turn, thread: projectThreadForHttp(thread) };
      });
      return c.json(accepted, 202);
    } catch (error) {
      return routeError(c, error);
    }
  });

  app.get("/v1/companions/:id/runtime", async (c) => {
    try {
      const companionId = companionIdSchema.parse(c.req.param("id"));
      const companion = await tenant(c, ({ actor, orgId, database }) =>
        getCompanionV2({ actor, orgId, companionId, withLastMessage: true, database }));
      c.header("Cache-Control", "private, no-store");
      return c.json({ companion });
    } catch (error) {
      return routeError(c, error);
    }
  });

  async function enqueueLifecycle(
    c: Context<{ Variables: ApiVariables }>,
    companionId: string,
    requestId: string,
    kind: "start" | "stop" | "restart_pi" | "restart_box",
    clientSurface: "web" | "mobile_web" | "native_mobile" = "web",
  ) {
    return tenant(c, ({ orgId, database }) => enqueueCompanionOperationV2({
      orgId,
      companionId,
      requestId,
      kind,
      clientSurface,
      database,
    }));
  }

  app.post("/v1/companions/:id/runtime/start", async (c) => {
    try {
      const companionId = companionIdSchema.parse(c.req.param("id"));
      const body = startCompanionRuntimeInputSchema.parse(await c.req.json().catch(() => ({})));
      const requestId = companionOperationRequestIdSchema.parse(
        c.req.header(COMPANION_OPERATION_IDEMPOTENCY_HEADER),
      );
      const accepted = await enqueueLifecycle(c, companionId, requestId, "start", body.client_surface);
      return c.json({ operation: accepted.operation }, 202);
    } catch (error) {
      return routeError(c, error);
    }
  });

  app.post("/v1/companions/:id/runtime/restart", async (c) => {
    try {
      const companionId = companionIdSchema.parse(c.req.param("id"));
      const body = restartCompanionRuntimeInputSchema.parse(await c.req.json());
      const requestId = companionOperationRequestIdSchema.parse(
        c.req.header(COMPANION_OPERATION_IDEMPOTENCY_HEADER),
      );
      const accepted = await enqueueLifecycle(
        c,
        companionId,
        requestId,
        body.target === "pi" ? "restart_pi" : "restart_box",
      );
      return c.json({ operation: accepted.operation }, 202);
    } catch (error) {
      return routeError(c, error);
    }
  });

  app.post("/v1/companions/:id/runtime/stop", async (c) => {
    try {
      const companionId = companionIdSchema.parse(c.req.param("id"));
      const requestId = companionOperationRequestIdSchema.parse(
        c.req.header(COMPANION_OPERATION_IDEMPOTENCY_HEADER),
      );
      const accepted = await enqueueLifecycle(c, companionId, requestId, "stop");
      return c.json({ operation: accepted.operation }, 202);
    } catch (error) {
      return routeError(c, error);
    }
  });

  app.post("/v1/companions/:id/runtime/desktop", async (c) => {
    try {
      const companionId = companionIdSchema.parse(c.req.param("id"));
      const resolved = await tenant(c, async ({ actor, orgId, database }) => ({
        actor,
        orgId,
        companion: await getCompanionV2({ actor, orgId, companionId, database }),
      }));
      if (resolved.companion.access === "viewer") throw new CompanionRuntimeForbiddenError();
      const desktop = await mintCompanionDesktop({
        env,
        actorId: resolved.actor.id,
        orgId: resolved.orgId,
        companionId,
      });
      c.header("Cache-Control", "private, no-store");
      return c.json(desktop);
    } catch (error) {
      return routeError(c, error);
    }
  });

}
