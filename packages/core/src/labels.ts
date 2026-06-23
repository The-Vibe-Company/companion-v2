import { and, asc, eq, isNull, sql } from "drizzle-orm";
import {
  labelPathSchema,
  labelDisplayNameSchema,
  labelColorSchema,
  labelIconSchema,
  type LabelColor,
  type LabelIcon,
  type LabelsResponse,
  type LabelTreeNode,
  type LabelVM,
} from "@companion/contracts";
import { db, schema, type Db } from "@companion/db";
import type { ActorContext } from "./services";
import { getOrgRole } from "./services";

/**
 * Labels ("folders") are the org-wide shared way to organize skills. There is NO owner / visibility
 * axis: every skill is visible to every member, and any member may create / assign / rename /
 * recolor / delete labels. The only authorization is org membership (`assertMember`).
 *
 * A label is identified by its slash-separated `path` (e.g. `marketing/seo`). Intermediate parents
 * are DERIVED (split on `/`), never stored. The path string lives directly on `skill_labels` (no FK
 * to a label id), so rename = a prefix `UPDATE` and delete = a prefix `DELETE` across both tables,
 * and roll-up counts need no join. The `(org_id, path)` `text_pattern_ops` index keeps the prefix
 * `LIKE path || '/%'` lookups index-friendly.
 *
 * This module is framework-free (no Next.js) and shared by the web routes, REST gateway, and CLI.
 */

/** Assert the actor is a member of the org; returns nothing (the role itself does not gate labels). */
async function assertMember(database: Db, actor: ActorContext, orgId: string): Promise<void> {
  const role = await getOrgRole(orgId, actor.id, database);
  if (!role) throw new Error("not a member of this organization");
}

/** Validate + normalize a label path (throws on an invalid path). */
function parsePath(path: string): string {
  return labelPathSchema.parse(path);
}

/** All proper-ancestor paths of `path`, root-first. `marketing/seo/local` → [marketing, marketing/seo]. */
function ancestorsOf(path: string): string[] {
  const segments = path.split("/");
  const out: string[] = [];
  for (let i = 1; i < segments.length; i++) {
    out.push(segments.slice(0, i).join("/"));
  }
  return out;
}

/** A path + all of its ancestors, root-first, de-duped (the set a create/assign must materialize). */
function pathWithAncestors(path: string): string[] {
  return [...ancestorsOf(path), path];
}

/**
 * Build the derived label tree + flat appearance list. A node exists if a `labels` row declares its
 * exact path (`explicit`), OR a skill is assigned a path at/under it (derived parent), OR it is an
 * ancestor of either. `count` is the de-duped roll-up of skills filed at the node OR any descendant.
 */
export async function listLabels(input: {
  actor: ActorContext;
  orgId: string;
  database?: Db;
}): Promise<LabelsResponse> {
  const database = input.database ?? db;
  await assertMember(database, input.actor, input.orgId);

  const labelRowsRaw = await database
    .select({
      path: schema.labels.path,
      displayName: schema.labels.displayName,
      color: schema.labels.color,
      icon: schema.labels.icon,
    })
    .from(schema.labels)
    .where(eq(schema.labels.orgId, input.orgId))
    .orderBy(asc(schema.labels.path));
  const labelRows = Array.isArray(labelRowsRaw) ? labelRowsRaw : [];

  // Roll-up counts must match the folder lists in `/v1/skills`, which exclude archived skills — so
  // join `skills` and drop archived assignments (an explicit `labels` row keeps the folder visible at
  // count 0 even when its only skills are archived).
  const assignmentRowsRaw = await database
    .select({ skillId: schema.skillLabels.skillId, path: schema.skillLabels.path })
    .from(schema.skillLabels)
    .innerJoin(
      schema.skills,
      and(eq(schema.skills.id, schema.skillLabels.skillId), eq(schema.skills.orgId, schema.skillLabels.orgId)),
    )
    .where(and(eq(schema.skillLabels.orgId, input.orgId), isNull(schema.skills.archivedAt)));
  const assignmentRows = Array.isArray(assignmentRowsRaw) ? assignmentRowsRaw : [];

  // Appearance per explicit path (only `labels` rows carry color/icon).
  const appearance = new Map<string, { displayName: string | null; color: LabelColor | null; icon: LabelIcon | null }>();
  for (const r of labelRows) {
    appearance.set(r.path, {
      displayName: r.displayName ?? null,
      color: (r.color as LabelColor | null) ?? null,
      icon: (r.icon as LabelIcon | null) ?? null,
    });
  }

  // The set of every node path: explicit labels, assigned paths, and all their ancestors.
  const explicit = new Set(labelRows.map((r) => r.path));
  const allPaths = new Set<string>();
  for (const path of explicit) for (const p of pathWithAncestors(path)) allPaths.add(p);
  for (const a of assignmentRows) for (const p of pathWithAncestors(a.path)) allPaths.add(p);

  // De-duped roll-up counts: a skill assigned `marketing/seo` counts toward `marketing` and
  // `marketing/seo`. Track the distinct skill ids per node so a skill with two sub-paths under the
  // same parent isn't double-counted.
  const skillsByNode = new Map<string, Set<string>>();
  for (const a of assignmentRows) {
    for (const p of pathWithAncestors(a.path)) {
      const set = skillsByNode.get(p) ?? new Set<string>();
      set.add(a.skillId);
      skillsByNode.set(p, set);
    }
  }

  // Assemble nodes, then link children by parent path. Sort each level lexicographically so the
  // serialized tree is stable (avoids client hydration mismatches).
  const nodeByPath = new Map<string, LabelTreeNode>();
  for (const path of allPaths) {
    const segments = path.split("/");
    const ap = appearance.get(path);
    nodeByPath.set(path, {
      path,
      name: segments[segments.length - 1] ?? path,
      displayName: ap?.displayName ?? null,
      color: ap?.color ?? null,
      icon: ap?.icon ?? null,
      count: skillsByNode.get(path)?.size ?? 0,
      explicit: explicit.has(path),
      children: [],
    });
  }

  const roots: LabelTreeNode[] = [];
  for (const path of [...allPaths].sort((a, b) => a.localeCompare(b))) {
    const node = nodeByPath.get(path)!;
    const slash = path.lastIndexOf("/");
    if (slash === -1) {
      roots.push(node);
    } else {
      const parent = nodeByPath.get(path.slice(0, slash));
      // A parent always exists (we materialized every ancestor); fall back defensively.
      if (parent) parent.children.push(node);
      else roots.push(node);
    }
  }

  const flat: LabelVM[] = labelRows.map((r) => ({
    path: r.path,
    displayName: r.displayName ?? null,
    color: (r.color as LabelColor | null) ?? null,
    icon: (r.icon as LabelIcon | null) ?? null,
  }));

  return { tree: roots, flat };
}

/**
 * Create (upsert) a label path + all of its ancestors, optionally with appearance on the leaf.
 * Idempotent: re-creating an existing path keeps it (and updates supplied color/icon). Any member.
 */
export async function createLabel(input: {
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
  const path = parsePath(input.path);
  const displayName = input.displayName !== undefined ? labelDisplayNameSchema.parse(input.displayName) : undefined;
  const color = input.color !== undefined ? labelColorSchema.parse(input.color) : undefined;
  const icon = input.icon !== undefined ? labelIconSchema.parse(input.icon) : undefined;

  // Materialize ancestors first (no appearance), then the leaf (with any supplied appearance).
  for (const ancestor of ancestorsOf(path)) {
    await database
      .insert(schema.labels)
      .values({ orgId: input.orgId, path: ancestor, createdBy: input.actor.id })
      .onConflictDoNothing({ target: [schema.labels.orgId, schema.labels.path] });
  }
  await database
    .insert(schema.labels)
    .values({
      orgId: input.orgId,
      path,
      ...(displayName !== undefined ? { displayName } : {}),
      ...(color !== undefined ? { color } : {}),
      ...(icon !== undefined ? { icon } : {}),
      createdBy: input.actor.id,
    })
    .onConflictDoUpdate({
      target: [schema.labels.orgId, schema.labels.path],
      // Only overwrite appearance fields the caller actually supplied.
      set: {
        ...(color !== undefined ? { color } : {}),
        ...(icon !== undefined ? { icon } : {}),
        ...(displayName !== undefined ? { displayName } : {}),
        updatedAt: new Date(),
      },
    });
}

/** Create a sublabel under `parent` (e.g. `addSublabel(marketing, seo)` → `marketing/seo`). */
export async function addSublabel(input: {
  actor: ActorContext;
  orgId: string;
  parent: string;
  name: string;
  database?: Db;
}): Promise<{ path: string }> {
  const parent = parsePath(input.parent);
  // Validate the child by validating the full path; a bad segment throws via the path schema.
  const path = parsePath(`${parent}/${input.name.trim()}`);
  await createLabel({ actor: input.actor, orgId: input.orgId, path, database: input.database });
  return { path };
}

/** Resolve a skill id from a slug within the org (labels target the skill by id). */
async function resolveSkillId(database: Db, orgId: string, slug: string): Promise<string> {
  const skill = await database.query.skills.findFirst({
    where: and(eq(schema.skills.orgId, orgId), eq(schema.skills.slug, slug)),
  });
  if (!skill) throw new Error("skill not found");
  return skill.id;
}

/**
 * Assign a label path to a skill (one `skill_labels` row). Upserts the path + its ancestors into
 * `labels` so the folder exists in the tree. Idempotent. Any member.
 */
export async function assignLabel(input: {
  actor: ActorContext;
  orgId: string;
  slug: string;
  path: string;
  database?: Db;
}): Promise<void> {
  const database = input.database ?? db;
  await assertMember(database, input.actor, input.orgId);
  const path = parsePath(input.path);
  const skillId = await resolveSkillId(database, input.orgId, input.slug);

  // Ensure the folder (and ancestors) exist so the tree shows it even before any other assignment.
  for (const p of pathWithAncestors(path)) {
    await database
      .insert(schema.labels)
      .values({ orgId: input.orgId, path: p, createdBy: input.actor.id })
      .onConflictDoNothing({ target: [schema.labels.orgId, schema.labels.path] });
  }
  await database
    .insert(schema.skillLabels)
    .values({ orgId: input.orgId, skillId, path, createdBy: input.actor.id })
    .onConflictDoNothing({
      target: [schema.skillLabels.orgId, schema.skillLabels.skillId, schema.skillLabels.path],
    });
}

/** Remove a label path from a skill (one `skill_labels` row). The folder itself stays. Idempotent. */
export async function unassignLabel(input: {
  actor: ActorContext;
  orgId: string;
  slug: string;
  path: string;
  database?: Db;
}): Promise<void> {
  const database = input.database ?? db;
  await assertMember(database, input.actor, input.orgId);
  const path = parsePath(input.path);
  const skillId = await resolveSkillId(database, input.orgId, input.slug);
  await database
    .delete(schema.skillLabels)
    .where(
      and(
        eq(schema.skillLabels.orgId, input.orgId),
        eq(schema.skillLabels.skillId, skillId),
        eq(schema.skillLabels.path, path),
      ),
    );
}

/** Set (or clear, with `null`) a path's color. Upserts the `labels` row + ancestors. Any member. */
export async function setLabelColor(input: {
  actor: ActorContext;
  orgId: string;
  path: string;
  color: LabelColor | null;
  database?: Db;
}): Promise<void> {
  await createLabel({
    actor: input.actor,
    orgId: input.orgId,
    path: input.path,
    color: input.color,
    database: input.database,
  });
}

/** Set (or clear, with `null`) a path's icon. Upserts the `labels` row + ancestors. Any member. */
export async function setLabelIcon(input: {
  actor: ActorContext;
  orgId: string;
  path: string;
  icon: LabelIcon | null;
  database?: Db;
}): Promise<void> {
  await createLabel({
    actor: input.actor,
    orgId: input.orgId,
    path: input.path,
    icon: input.icon,
    database: input.database,
  });
}

/**
 * Rename a label path and its whole subtree. `marketing` → `growth` rewrites `marketing`,
 * `marketing/seo`, … to `growth`, `growth/seo`, … across BOTH `labels` and `skill_labels` in one
 * transaction. Rejected when `to` (or any path the move would produce) already exists as a distinct
 * label, to avoid silently merging two folders. Any member.
 */
export async function renameLabel(input: {
  actor: ActorContext;
  orgId: string;
  from: string;
  to: string;
  displayName?: string;
  database?: Db;
}): Promise<void> {
  const database = input.database ?? db;
  await assertMember(database, input.actor, input.orgId);
  const from = parsePath(input.from);
  const to = parsePath(input.to);
  const displayName = input.displayName !== undefined ? labelDisplayNameSchema.parse(input.displayName) : undefined;
  if (from === to) {
    if (displayName !== undefined) {
      await createLabel({ actor: input.actor, orgId: input.orgId, path: to, displayName, database });
    }
    return;
  }

  // A move into one's own subtree (e.g. `a` → `a/b`) would recursively rewrite the rows it just
  // created — reject it outright.
  if (to === from || to.startsWith(`${from}/`)) {
    throw new Error("cannot move a label into its own subtree");
  }

  // Prefix pattern: the path itself OR any descendant (`from/...`). Bound params; `_` and `%` are
  // not produced by the kebab path validator, so no LIKE-escaping is needed for the suffix.
  const fromPrefix = `${from}/`;
  // The substring length to strip when rewriting `from`-prefixed paths to `to`-prefixed paths.
  const fromLen = from.length;

  await database.transaction(async (tx) => {
    // Collision check: any existing `labels` row at `to` or under `to/` (other than ones this move
    // produces) means the target tree already exists → reject rather than merge.
    const collisionRows = await tx
      .select({ path: schema.labels.path })
      .from(schema.labels)
      .where(
        and(
          eq(schema.labels.orgId, input.orgId),
          sql`(${schema.labels.path} = ${to} or ${schema.labels.path} like ${`${to}/%`})`,
        ),
      );
    if ((Array.isArray(collisionRows) ? collisionRows : []).length > 0) {
      throw new Error("a label with that name already exists");
    }

    const now = new Date();

    await tx
      .update(schema.labels)
      .set({
        path: to,
        ...(displayName !== undefined ? { displayName } : {}),
        updatedAt: now,
      })
      .where(and(eq(schema.labels.orgId, input.orgId), eq(schema.labels.path, from)));

    await tx
      .update(schema.labels)
      .set({
        path: sql`${to}::text || substring(${schema.labels.path} from ${sql.raw(String(fromLen + 1))})`,
        updatedAt: now,
      })
      .where(and(eq(schema.labels.orgId, input.orgId), sql`${schema.labels.path} like ${`${fromPrefix}%`}`));

    await tx
      .update(schema.skillLabels)
      .set({ path: to })
      .where(and(eq(schema.skillLabels.orgId, input.orgId), eq(schema.skillLabels.path, from)));

    await tx
      .update(schema.skillLabels)
      .set({
        path: sql`${to}::text || substring(${schema.skillLabels.path} from ${sql.raw(String(fromLen + 1))})`,
      })
      .where(
        and(eq(schema.skillLabels.orgId, input.orgId), sql`${schema.skillLabels.path} like ${`${fromPrefix}%`}`),
      );

    if (displayName !== undefined) {
      await tx
        .insert(schema.labels)
        .values({ orgId: input.orgId, path: to, displayName, createdBy: input.actor.id })
        .onConflictDoUpdate({
          target: [schema.labels.orgId, schema.labels.path],
          set: { displayName, updatedAt: now },
        });
    }
  });
}

/**
 * Delete a label path and its whole subtree across both tables (prefix `DELETE`). Removes the
 * folder rows and every assignment under it; skills themselves are untouched. Any member.
 */
export async function deleteLabel(input: {
  actor: ActorContext;
  orgId: string;
  path: string;
  database?: Db;
}): Promise<void> {
  const database = input.database ?? db;
  await assertMember(database, input.actor, input.orgId);
  const path = parsePath(input.path);
  const prefix = `${path}/`;

  await database.transaction(async (tx) => {
    await tx
      .delete(schema.skillLabels)
      .where(
        and(
          eq(schema.skillLabels.orgId, input.orgId),
          sql`(${schema.skillLabels.path} = ${path} or ${schema.skillLabels.path} like ${`${prefix}%`})`,
        ),
      );
    await tx
      .delete(schema.labels)
      .where(
        and(
          eq(schema.labels.orgId, input.orgId),
          sql`(${schema.labels.path} = ${path} or ${schema.labels.path} like ${`${prefix}%`})`,
        ),
      );
  });
}
