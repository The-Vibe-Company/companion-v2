import { and, eq } from "drizzle-orm";
import { db, schema, type Db } from "@companion/db";
import type { ActivatedModels } from "@companion/contracts";
import { canManageOrg } from "./authz";
import { assertMember, type ActorContext } from "./services";

/**
 * Activated models: the short, curated lists the run launcher's picker shows instead of the full
 * models.dev catalog — a personal list per member plus a workspace-shared list owners/admins
 * curate. The effective set a member can run = personal ∪ org, enforced HARD in `createRun` (a
 * non-activated model is rejected even via the raw API). The catalog itself lives in
 * `packages/sandbox`, which core cannot import: model ids are validated against it at the API
 * layer on write and pruned against it at read time — this module is catalog-agnostic. Same
 * load-order reasoning as `./labels`: only imports `assertMember` (hoisted) + the `ActorContext`
 * type from `./services`.
 */

function normalizeModels(models: string[]): string[] {
  return [...new Set(models)].sort();
}

/**
 * Both lists for a member, with NO membership assert — for callers that already asserted
 * (`createRun`) or run as a system job. Queries are re-filtered in JS: the hand-rolled test
 * fakeDbs match conditions fuzzily, and the paranoia is free.
 */
export async function getActivatedModelSets(input: {
  database: Db;
  orgId: string;
  userId: string;
}): Promise<{ personal: string[]; org: string[] }> {
  const personalRows = await input.database
    .select()
    .from(schema.userModelPreferences)
    .where(
      and(
        eq(schema.userModelPreferences.orgId, input.orgId),
        eq(schema.userModelPreferences.userId, input.userId),
      ),
    );
  const personal = (Array.isArray(personalRows) ? personalRows : []).find(
    (row) => row.userId === input.userId && row.orgId === input.orgId,
  );
  const orgRows = await input.database
    .select()
    .from(schema.orgModelPreferences)
    .where(eq(schema.orgModelPreferences.orgId, input.orgId));
  const org = (Array.isArray(orgRows) ? orgRows : []).find((row) => row.orgId === input.orgId);
  return {
    personal: Array.isArray(personal?.activatedModels) ? personal.activatedModels : [],
    org: Array.isArray(org?.activatedModels) ? org.activatedModels : [],
  };
}

/** The caller's activated lists (personal + workspace) — any member. */
export async function getActivatedModels(input: {
  actor: ActorContext;
  orgId: string;
  database?: Db;
}): Promise<ActivatedModels> {
  const database = input.database ?? db;
  await assertMember(database, input.actor, input.orgId);
  return getActivatedModelSets({ database, orgId: input.orgId, userId: input.actor.id });
}

/** Replace the caller's personal activated-model list. */
export async function setUserActivatedModels(input: {
  actor: ActorContext;
  orgId: string;
  models: string[];
  database?: Db;
}): Promise<ActivatedModels> {
  const database = input.database ?? db;
  await assertMember(database, input.actor, input.orgId);
  const models = normalizeModels(input.models);
  await database
    .insert(schema.userModelPreferences)
    .values({ orgId: input.orgId, userId: input.actor.id, activatedModels: models })
    .onConflictDoUpdate({
      target: [schema.userModelPreferences.orgId, schema.userModelPreferences.userId],
      set: { activatedModels: models, updatedAt: new Date() },
    });
  return getActivatedModelSets({ database, orgId: input.orgId, userId: input.actor.id });
}

/** Replace the workspace-shared activated-model list — owner/admin only. */
export async function setOrgActivatedModels(input: {
  actor: ActorContext;
  orgId: string;
  models: string[];
  database?: Db;
}): Promise<ActivatedModels> {
  const database = input.database ?? db;
  const role = await assertMember(database, input.actor, input.orgId);
  if (!canManageOrg(role)) throw new Error("only workspace owners and admins can manage shared models");
  const models = normalizeModels(input.models);
  await database
    .insert(schema.orgModelPreferences)
    .values({ orgId: input.orgId, activatedModels: models, createdBy: input.actor.id })
    .onConflictDoUpdate({
      target: [schema.orgModelPreferences.orgId],
      set: { activatedModels: models, createdBy: input.actor.id, updatedAt: new Date() },
    });
  await database.insert(schema.auditLog).values({
    orgId: input.orgId,
    actorId: input.actor.id,
    action: "models.activate.org",
    targetType: "org",
    targetId: input.orgId,
    metadata: { count: models.length, models },
  });
  return getActivatedModelSets({ database, orgId: input.orgId, userId: input.actor.id });
}
