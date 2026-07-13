import { and, asc, eq, isNull, sql } from "drizzle-orm";
import {
  labelDisplayNameSchema,
  labelColorSchema,
  labelIconSchema,
  type LabelColor,
  type LabelIcon,
  type LabelsResponse,
} from "@companion/contracts";
import { db, schema, type Db } from "@companion/db";
import type { ActorContext } from "./services";
import { getOrgRole } from "./services";
import { assembleLabelsResponse, ancestorsOfPath, parseLabelPath, pathWithAncestors } from "./labels";
import { assertPersonalSkillsEntitled } from "./billing";

/**
 * Personal folders are the per-user counterpart to org {@link labels}: they organize a member's
 * private "My Skills" library. Same path / appearance model and tree-assembly (shared from `./labels`),
 * but every row is keyed by `(org_id, owner_id, path)` and scoped to `owner_id = actor.id`, so one
 * member's personal folders are never visible to another. Only authored personal skills can be filed
 * here (installed org skills stay unfiled). Org membership is the only role gate; ownership is enforced
 * by the `owner_id` scope on every query (and by user-scoped RLS as defense-in-depth).
 *
 * This module is framework-free (no Next.js) and shared by the web routes, REST gateway, and CLI.
 */

async function assertMember(database: Db, actor: ActorContext, orgId: string): Promise<void> {
  const role = await getOrgRole(orgId, actor.id, database);
  if (!role) throw new Error("not a member of this organization");
}

/** Resolve the actor's OWN authored personal skill by slug. Rejects org / others' / unknown skills. */
async function resolveOwnPersonalSkillId(
  database: Db,
  actor: ActorContext,
  orgId: string,
  slug: string,
): Promise<string> {
  const skill = await database.query.skills.findFirst({
    where: and(eq(schema.skills.orgId, orgId), eq(schema.skills.slug, slug)),
  });
  // A personal skill is private to its creator; an org skill is filed with org labels, not personal
  // ones. Either way a non-matching skill is "not found" (never reveal another member's private skill).
  if (!skill || skill.scope !== "personal" || skill.creatorId !== actor.id) {
    throw new Error("personal skill not found");
  }
  return skill.id;
}

/** The caller's personal folder tree + flat appearance. Counts drop archived skills, like org labels. */
export async function listPersonalLabels(input: {
  actor: ActorContext;
  orgId: string;
  database?: Db;
}): Promise<LabelsResponse> {
  const database = input.database ?? db;
  await assertMember(database, input.actor, input.orgId);
  await assertPersonalSkillsEntitled({ database, orgId: input.orgId });

  const labelRowsRaw = await database
    .select({
      path: schema.personalLabels.path,
      displayName: schema.personalLabels.displayName,
      color: schema.personalLabels.color,
      icon: schema.personalLabels.icon,
    })
    .from(schema.personalLabels)
    .where(and(eq(schema.personalLabels.orgId, input.orgId), eq(schema.personalLabels.ownerId, input.actor.id)))
    .orderBy(asc(schema.personalLabels.path));
  const labelRows = Array.isArray(labelRowsRaw) ? labelRowsRaw : [];

  const assignmentRowsRaw = await database
    .select({ skillId: schema.personalSkillLabels.skillId, path: schema.personalSkillLabels.path })
    .from(schema.personalSkillLabels)
    .innerJoin(
      schema.skills,
      and(
        eq(schema.skills.id, schema.personalSkillLabels.skillId),
        eq(schema.skills.orgId, schema.personalSkillLabels.orgId),
      ),
    )
    .where(
      and(
        eq(schema.personalSkillLabels.orgId, input.orgId),
        eq(schema.personalSkillLabels.ownerId, input.actor.id),
        isNull(schema.skills.archivedAt),
      ),
    );
  const assignmentRows = Array.isArray(assignmentRowsRaw) ? assignmentRowsRaw : [];

  return assembleLabelsResponse(labelRows, assignmentRows);
}

/** Create (upsert) a personal folder path + ancestors, optionally with appearance on the leaf. */
export async function createPersonalLabel(input: {
  actor: ActorContext;
  orgId: string;
  path: string;
  displayName?: string;
  color?: LabelColor | null;
  icon?: LabelIcon | null;
  database?: Db;
}): Promise<void> {
  const database = input.database ?? db;
  await assertMember(database, input.actor, input.orgId);
  await assertPersonalSkillsEntitled({ database, orgId: input.orgId });
  const path = parseLabelPath(input.path);
  const owner = input.actor.id;
  const displayName = input.displayName !== undefined ? labelDisplayNameSchema.parse(input.displayName) : undefined;
  const color = input.color !== undefined ? labelColorSchema.parse(input.color) : undefined;
  const icon = input.icon !== undefined ? labelIconSchema.parse(input.icon) : undefined;

  for (const ancestor of ancestorsOfPath(path)) {
    await database
      .insert(schema.personalLabels)
      .values({ orgId: input.orgId, ownerId: owner, path: ancestor })
      .onConflictDoNothing({
        target: [schema.personalLabels.orgId, schema.personalLabels.ownerId, schema.personalLabels.path],
      });
  }
  await database
    .insert(schema.personalLabels)
    .values({
      orgId: input.orgId,
      ownerId: owner,
      path,
      ...(displayName !== undefined ? { displayName } : {}),
      ...(color !== undefined ? { color } : {}),
      ...(icon !== undefined ? { icon } : {}),
    })
    .onConflictDoUpdate({
      target: [schema.personalLabels.orgId, schema.personalLabels.ownerId, schema.personalLabels.path],
      set: {
        ...(color !== undefined ? { color } : {}),
        ...(icon !== undefined ? { icon } : {}),
        ...(displayName !== undefined ? { displayName } : {}),
        updatedAt: new Date(),
      },
    });
}

/** Assign a personal folder to one of the caller's authored personal skills (upserts the folder). */
export async function assignPersonalLabel(input: {
  actor: ActorContext;
  orgId: string;
  slug: string;
  path: string;
  database?: Db;
}): Promise<void> {
  const database = input.database ?? db;
  await assertMember(database, input.actor, input.orgId);
  await assertPersonalSkillsEntitled({ database, orgId: input.orgId });
  const path = parseLabelPath(input.path);
  const owner = input.actor.id;
  const skillId = await resolveOwnPersonalSkillId(database, input.actor, input.orgId, input.slug);

  for (const p of pathWithAncestors(path)) {
    await database
      .insert(schema.personalLabels)
      .values({ orgId: input.orgId, ownerId: owner, path: p })
      .onConflictDoNothing({
        target: [schema.personalLabels.orgId, schema.personalLabels.ownerId, schema.personalLabels.path],
      });
  }
  await database
    .insert(schema.personalSkillLabels)
    .values({ orgId: input.orgId, ownerId: owner, skillId, path })
    .onConflictDoNothing({
      target: [
        schema.personalSkillLabels.orgId,
        schema.personalSkillLabels.ownerId,
        schema.personalSkillLabels.skillId,
        schema.personalSkillLabels.path,
      ],
    });
}

/** Remove a personal folder from one of the caller's skills (the folder itself stays). Idempotent. */
export async function unassignPersonalLabel(input: {
  actor: ActorContext;
  orgId: string;
  slug: string;
  path: string;
  database?: Db;
}): Promise<void> {
  const database = input.database ?? db;
  await assertMember(database, input.actor, input.orgId);
  await assertPersonalSkillsEntitled({ database, orgId: input.orgId });
  const path = parseLabelPath(input.path);
  const skillId = await resolveOwnPersonalSkillId(database, input.actor, input.orgId, input.slug);
  await database
    .delete(schema.personalSkillLabels)
    .where(
      and(
        eq(schema.personalSkillLabels.orgId, input.orgId),
        eq(schema.personalSkillLabels.ownerId, input.actor.id),
        eq(schema.personalSkillLabels.skillId, skillId),
        eq(schema.personalSkillLabels.path, path),
      ),
    );
}

/** Set (or clear, with `null`) a personal folder's color. */
export async function setPersonalLabelColor(input: {
  actor: ActorContext;
  orgId: string;
  path: string;
  color: LabelColor | null;
  database?: Db;
}): Promise<void> {
  await createPersonalLabel({ ...input });
}

/** Set (or clear, with `null`) a personal folder's icon. */
export async function setPersonalLabelIcon(input: {
  actor: ActorContext;
  orgId: string;
  path: string;
  icon: LabelIcon | null;
  database?: Db;
}): Promise<void> {
  await createPersonalLabel({ ...input });
}

/** Rename a personal folder path and its whole subtree (owner-scoped prefix UPDATE across both tables). */
export async function renamePersonalLabel(input: {
  actor: ActorContext;
  orgId: string;
  from: string;
  to: string;
  displayName?: string;
  database?: Db;
}): Promise<void> {
  const database = input.database ?? db;
  await assertMember(database, input.actor, input.orgId);
  await assertPersonalSkillsEntitled({ database, orgId: input.orgId });
  const from = parseLabelPath(input.from);
  const to = parseLabelPath(input.to);
  const owner = input.actor.id;
  const displayName = input.displayName !== undefined ? labelDisplayNameSchema.parse(input.displayName) : undefined;
  if (from === to) {
    if (displayName !== undefined) {
      await createPersonalLabel({ actor: input.actor, orgId: input.orgId, path: to, displayName, database });
    }
    return;
  }
  if (to === from || to.startsWith(`${from}/`)) {
    throw new Error("cannot move a label into its own subtree");
  }

  const fromPrefix = `${from}/`;
  const fromLen = from.length;

  await database.transaction(async (txDb) => {
    const tx = txDb as unknown as Db;
    const collisionRows = await tx
      .select({ path: schema.personalLabels.path })
      .from(schema.personalLabels)
      .where(
        and(
          eq(schema.personalLabels.orgId, input.orgId),
          eq(schema.personalLabels.ownerId, owner),
          sql`(${schema.personalLabels.path} = ${to} or ${schema.personalLabels.path} like ${`${to}/%`})`,
        ),
      );
    if ((Array.isArray(collisionRows) ? collisionRows : []).length > 0) {
      throw new Error("a label with that name already exists");
    }

    const now = new Date();
    const ownerScope = and(eq(schema.personalLabels.orgId, input.orgId), eq(schema.personalLabels.ownerId, owner));
    const edgeOwnerScope = and(
      eq(schema.personalSkillLabels.orgId, input.orgId),
      eq(schema.personalSkillLabels.ownerId, owner),
    );

    await tx
      .update(schema.personalLabels)
      .set({ path: to, ...(displayName !== undefined ? { displayName } : {}), updatedAt: now })
      .where(and(ownerScope, eq(schema.personalLabels.path, from)));
    await tx
      .update(schema.personalLabels)
      .set({
        path: sql`${to}::text || substring(${schema.personalLabels.path} from ${sql.raw(String(fromLen + 1))})`,
        updatedAt: now,
      })
      .where(and(ownerScope, sql`${schema.personalLabels.path} like ${`${fromPrefix}%`}`));
    await tx
      .update(schema.personalSkillLabels)
      .set({ path: to })
      .where(and(edgeOwnerScope, eq(schema.personalSkillLabels.path, from)));
    await tx
      .update(schema.personalSkillLabels)
      .set({
        path: sql`${to}::text || substring(${schema.personalSkillLabels.path} from ${sql.raw(String(fromLen + 1))})`,
      })
      .where(and(edgeOwnerScope, sql`${schema.personalSkillLabels.path} like ${`${fromPrefix}%`}`));

    if (displayName !== undefined) {
      await tx
        .insert(schema.personalLabels)
        .values({ orgId: input.orgId, ownerId: owner, path: to, displayName })
        .onConflictDoUpdate({
          target: [schema.personalLabels.orgId, schema.personalLabels.ownerId, schema.personalLabels.path],
          set: { displayName, updatedAt: now },
        });
    }
  });
}

/** Delete a personal folder path and its whole subtree across both tables (owner-scoped prefix DELETE). */
export async function deletePersonalLabel(input: {
  actor: ActorContext;
  orgId: string;
  path: string;
  database?: Db;
}): Promise<void> {
  const database = input.database ?? db;
  await assertMember(database, input.actor, input.orgId);
  await assertPersonalSkillsEntitled({ database, orgId: input.orgId });
  const path = parseLabelPath(input.path);
  const owner = input.actor.id;
  const prefix = `${path}/`;

  await database.transaction(async (txDb) => {
    const tx = txDb as unknown as Db;
    await tx
      .delete(schema.personalSkillLabels)
      .where(
        and(
          eq(schema.personalSkillLabels.orgId, input.orgId),
          eq(schema.personalSkillLabels.ownerId, owner),
          sql`(${schema.personalSkillLabels.path} = ${path} or ${schema.personalSkillLabels.path} like ${`${prefix}%`})`,
        ),
      );
    await tx
      .delete(schema.personalLabels)
      .where(
        and(
          eq(schema.personalLabels.orgId, input.orgId),
          eq(schema.personalLabels.ownerId, owner),
          sql`(${schema.personalLabels.path} = ${path} or ${schema.personalLabels.path} like ${`${prefix}%`})`,
        ),
      );
  });
}
