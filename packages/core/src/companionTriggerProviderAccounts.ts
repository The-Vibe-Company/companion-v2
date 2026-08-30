import { randomUUID } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";

import {
  companionTriggerProviderAccountSchema,
  type CompanionTriggerProviderAccount,
  type CreateCompanionTriggerProviderAccountInput,
} from "@companion/contracts";
import { db, schema, type Db } from "@companion/db";

import { CompanionNotFoundError } from "./companions";
import { encryptOpaqueValue, loadSecretsMasterKey } from "./secretsCrypto";
import { assertMember, type ActorContext } from "./services";

export const COMPANION_TRIGGER_PROVIDER_CREDENTIAL_PURPOSE = "companion-trigger-provider-credential";

function projectAccount(
  row: typeof schema.companionTriggerProviderAccounts.$inferSelect,
  dependentTriggerCount: number,
): CompanionTriggerProviderAccount {
  return companionTriggerProviderAccountSchema.parse({
    id: row.id,
    provider: row.provider,
    label: row.label,
    credential_source: row.credentialSource,
    mcp_account_id: row.mcpAccountId,
    status: row.status,
    dependent_trigger_count: dependentTriggerCount,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  });
}

/** List the current member's provider authority once; it applies to every accessible Companion. */
export async function listCompanionTriggerProviderAccounts(input: {
  actor: ActorContext;
  orgId: string;
  database?: Db;
}): Promise<CompanionTriggerProviderAccount[]> {
  const database = input.database ?? db;
  await assertMember(database, input.actor, input.orgId);
  const rows = await database
    .select({
      account: schema.companionTriggerProviderAccounts,
      dependentTriggerCount: sql<number>`count(${schema.companionTriggers.id})::integer`,
    })
    .from(schema.companionTriggerProviderAccounts)
    .leftJoin(
      schema.companionTriggers,
      and(
        eq(schema.companionTriggers.orgId, schema.companionTriggerProviderAccounts.orgId),
        eq(schema.companionTriggers.providerAccountId, schema.companionTriggerProviderAccounts.id),
      ),
    )
    .where(and(
      eq(schema.companionTriggerProviderAccounts.orgId, input.orgId),
      eq(schema.companionTriggerProviderAccounts.ownerId, input.actor.id),
    ))
    .groupBy(schema.companionTriggerProviderAccounts.id)
    .orderBy(
      asc(schema.companionTriggerProviderAccounts.provider),
      asc(schema.companionTriggerProviderAccounts.label),
    );
  return rows.map((row) => projectAccount(row.account, row.dependentTriggerCount));
}

/** Materialize trigger authority from an OAuth MCP account without copying its credential. */
export async function ensureOAuthCompanionTriggerProviderAccount(input: {
  actor: ActorContext;
  orgId: string;
  mcpAccountId: string;
  provider: string;
  label: string;
  database?: Db;
}): Promise<CompanionTriggerProviderAccount | null> {
  if (input.provider !== "github" && input.provider !== "sentry") return null;
  const database = input.database ?? db;
  await assertMember(database, input.actor, input.orgId);
  const [existing] = await database
    .select()
    .from(schema.companionTriggerProviderAccounts)
    .where(and(
      eq(schema.companionTriggerProviderAccounts.orgId, input.orgId),
      eq(schema.companionTriggerProviderAccounts.ownerId, input.actor.id),
      eq(schema.companionTriggerProviderAccounts.provider, input.provider),
      sql`lower(${schema.companionTriggerProviderAccounts.label}) = lower(${input.label})`,
    ));
  const [row] = existing
    ? await database.update(schema.companionTriggerProviderAccounts).set({
        credentialSource: "mcp_oauth",
        mcpAccountId: input.mcpAccountId,
        credentialGeneration: null,
        ciphertext: null,
        iv: null,
        authTag: null,
        wrappedDek: null,
        wrapIv: null,
        wrapAuthTag: null,
        keyId: null,
        status: "connected",
        disconnectedAt: null,
        updatedAt: new Date(),
      }).where(eq(schema.companionTriggerProviderAccounts.id, existing.id)).returning()
    : await database.insert(schema.companionTriggerProviderAccounts).values({
        orgId: input.orgId,
        ownerId: input.actor.id,
        provider: input.provider,
        label: input.label,
        credentialSource: "mcp_oauth",
        mcpAccountId: input.mcpAccountId,
      }).returning();
  if (!row) throw new Error("failed to save trigger provider account");
  return projectAccount(row, 0);
}

/** Store or reconnect a provider API key. Plaintext is write-only and never projected back. */
export async function saveCompanionTriggerProviderAccount(input: {
  actor: ActorContext;
  orgId: string;
  account: CreateCompanionTriggerProviderAccountInput;
  masterKey?: Buffer;
  database?: Db;
}): Promise<CompanionTriggerProviderAccount> {
  const database = input.database ?? db;
  await assertMember(database, input.actor, input.orgId);
  const [existing] = await database
    .select()
    .from(schema.companionTriggerProviderAccounts)
    .where(and(
      eq(schema.companionTriggerProviderAccounts.orgId, input.orgId),
      eq(schema.companionTriggerProviderAccounts.ownerId, input.actor.id),
      eq(schema.companionTriggerProviderAccounts.provider, input.account.provider),
      sql`lower(${schema.companionTriggerProviderAccounts.label}) = lower(${input.account.label})`,
    ));
  const id = existing?.id ?? randomUUID();
  const generation = randomUUID();
  const envelope = encryptOpaqueValue({
    orgId: input.orgId,
    purpose: COMPANION_TRIGGER_PROVIDER_CREDENTIAL_PURPOSE,
    subjectId: `${id}:${generation}`,
    value: input.account.credential,
  }, input.masterKey ?? loadSecretsMasterKey());
  const values = {
    credentialSource: "api_key",
    mcpAccountId: null,
    credentialGeneration: generation,
    ...envelope,
    status: "connected",
    disconnectedAt: null,
    updatedAt: new Date(),
  } as const;
  const [row] = existing
    ? await database.update(schema.companionTriggerProviderAccounts).set(values)
        .where(eq(schema.companionTriggerProviderAccounts.id, existing.id)).returning()
    : await database.insert(schema.companionTriggerProviderAccounts).values({
        id,
        orgId: input.orgId,
        ownerId: input.actor.id,
        provider: input.account.provider,
        label: input.account.label,
        ...values,
      }).returning();
  if (!row) throw new Error("failed to save trigger provider account");
  return projectAccount(row, 0);
}

/** Soft-disconnect authority and erase any dedicated API key; DB triggers degrade all dependents. */
export async function disconnectCompanionTriggerProviderAccount(input: {
  actor: ActorContext;
  orgId: string;
  accountId: string;
  database?: Db;
}): Promise<CompanionTriggerProviderAccount> {
  const database = input.database ?? db;
  await assertMember(database, input.actor, input.orgId);
  const [existing] = await database.select().from(schema.companionTriggerProviderAccounts).where(and(
    eq(schema.companionTriggerProviderAccounts.id, input.accountId),
    eq(schema.companionTriggerProviderAccounts.orgId, input.orgId),
    eq(schema.companionTriggerProviderAccounts.ownerId, input.actor.id),
  ));
  if (!existing) throw new CompanionNotFoundError();
  if (existing.mcpAccountId) {
    await database.delete(schema.companionMcpAccounts).where(and(
      eq(schema.companionMcpAccounts.id, existing.mcpAccountId),
      eq(schema.companionMcpAccounts.orgId, input.orgId),
      eq(schema.companionMcpAccounts.ownerId, input.actor.id),
    ));
  } else {
    await database.update(schema.companionTriggerProviderAccounts).set({
      credentialGeneration: null,
      ciphertext: null,
      iv: null,
      authTag: null,
      wrappedDek: null,
      wrapIv: null,
      wrapAuthTag: null,
      keyId: null,
      status: "disconnected",
      disconnectedAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(schema.companionTriggerProviderAccounts.id, existing.id));
  }
  const [row] = await database.select().from(schema.companionTriggerProviderAccounts)
    .where(eq(schema.companionTriggerProviderAccounts.id, existing.id));
  if (!row) throw new CompanionNotFoundError();
  const [countRow] = await database.select({ count: sql<number>`count(*)::integer` })
    .from(schema.companionTriggers)
    .where(and(
      eq(schema.companionTriggers.orgId, input.orgId),
      eq(schema.companionTriggers.providerAccountId, row.id),
    ));
  return projectAccount(row, countRow?.count ?? 0);
}
