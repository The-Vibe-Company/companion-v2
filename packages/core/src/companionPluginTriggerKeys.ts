import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { z } from "zod";

import { db, type Db } from "@companion/db";

import { assertMember, type ActorContext } from "./services";
import { encryptOpaqueValue, loadSecretsMasterKey, type OpaqueCiphertext } from "./secretsCrypto";
import { schema } from "@companion/db";

/**
 * Per-plugin trigger credentials: a second authentication a provider needs for webhook
 * registration when its MCP OAuth token cannot manage webhooks (Linear today). The plaintext is
 * accepted once on this write, envelope-encrypted like every other control-plane credential, and
 * never returned by any read.
 */
export const COMPANION_PLUGIN_TRIGGER_KEY_PURPOSE = "companion-plugin-trigger-key";

const TRIGGER_KEY_MAX_CHARACTERS = 256;

function parseTriggerKeyCredential(value: string): string {
  return value.trim().length === 0 || value.length > TRIGGER_KEY_MAX_CHARACTERS
    ? (() => { throw new Error("invalid Companion plugin trigger key"); })()
    : (/[\r\n\0]/.test(value)
      ? (() => { throw new Error("credential must be a single line"); })()
      : value);
}

/** Store (or rotate) the trigger key for this workspace's Linear plugin account. Owner of the account only. */
export async function saveCompanionPluginTriggerKey(input: {
  actor: ActorContext;
  orgId: string;
  provider: "linear";
  credential: string;
  masterKey?: Buffer;
  database?: Db;
}): Promise<void> {
  const database = input.database ?? db;
  const masterKey = input.masterKey ?? loadSecretsMasterKey();
  await assertMember(database, input.actor, input.orgId);
  const credential = parseTriggerKeyCredential(input.credential);
  const [account] = await database
    .select({ id: schema.companionMcpAccounts.id })
    .from(schema.companionMcpAccounts)
    .where(sql`${schema.companionMcpAccounts.orgId} = ${input.orgId}
      and ${schema.companionMcpAccounts.provider} = ${input.provider}
      and ${schema.companionMcpAccounts.ownerId} = ${input.actor.id}`);
  if (!account) throw new Error("plugin account not found");
  const generation = randomUUID();
  const envelope: OpaqueCiphertext = encryptOpaqueValue({
    orgId: input.orgId,
    purpose: COMPANION_PLUGIN_TRIGGER_KEY_PURPOSE,
    subjectId: `${account.id}:${generation}`,
    value: credential,
  }, masterKey);
  await database.execute(sql`
    select public.companion_api_set_plugin_trigger_key(
      ${input.orgId}::uuid,
      ${account.id}::uuid,
      ${input.provider},
      ${generation}::uuid,
      ${envelope.ciphertext},
      ${envelope.iv},
      ${envelope.authTag},
      ${envelope.wrappedDek},
      ${envelope.wrapIv},
      ${envelope.wrapAuthTag},
      ${envelope.keyId}
    )
  `);
}

export interface PluginTriggerKeyEnvelope {
  account_id: string;
  credential_generation: string;
  ciphertext: string;
  iv: string;
  auth_tag: string;
  wrapped_dek: string;
  wrap_iv: string;
  wrap_auth_tag: string;
  key_id: string;
}

/** Editor-gated raw envelope read for the registration path; null when no key is stored. */
export async function getCompanionPluginTriggerKeyEnvelope(input: {
  orgId: string;
  companionId: string;
  provider: string;
  database: Db;
}): Promise<PluginTriggerKeyEnvelope | null> {
  const result = await input.database.execute(sql`
    select public.companion_api_get_plugin_trigger_key(
      ${input.orgId}::uuid,
      ${input.companionId}::uuid,
      ${input.provider}
    ) as key
  `);
  // SAFETY: database.execute resolves to an iterable of rows; the RPC above returns exactly one key column.
  const [row] = Array.from(result as Iterable<{ key: unknown }>);
  const parsed = pluginTriggerKeySchema.safeParse(row?.key);
  return parsed.success ? parsed.data : null;
}

const pluginTriggerKeySchema = z.object({
  account_id: z.string(),
  credential_generation: z.string(),
  ciphertext: z.string(),
  iv: z.string(),
  auth_tag: z.string(),
  wrapped_dek: z.string(),
  wrap_iv: z.string(),
  wrap_auth_tag: z.string(),
  key_id: z.string(),
});
