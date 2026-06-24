import { describe, expect, it } from "vitest";
import { schema, type Db } from "@companion/db";
import type { LabelTreeNode } from "@companion/contracts";
import {
  assignPersonalLabel,
  createPersonalLabel,
  deletePersonalLabel,
  listPersonalLabels,
  renamePersonalLabel,
  unassignPersonalLabel,
  type ActorContext,
} from "../src/services";

/**
 * In-memory fakeDb for the PERSONAL folder service. Mirrors the org-label fakeDb (skillLabels.test.ts)
 * but every row and predicate carries `owner_id`: a member's personal folders are never visible to
 * another member. Builders are dispatched by table identity (`schema.personalLabels` /
 * `schema.personalSkillLabels` / `schema.skills`). `sql` prefix cascades are recovered from the bound
 * path params; the owner id is recovered separately so the fakes honor the real `eq(owner_id, …)` scope
 * — a cross-owner test actually fails if production ever stops scoping by owner.
 */
const ORG = "00000000-0000-0000-0000-0000000000aa";
const OTHER_ORG = "00000000-0000-0000-0000-0000000000bb";
const userA: ActorContext = { id: "user-a", email: "a@example.com", name: "User A" };
const userB: ActorContext = { id: "user-b", email: "b@example.com", name: "User B" };

interface PLabelRow {
  orgId: string;
  ownerId: string;
  path: string;
  displayName?: string | null;
  color: string | null;
  icon: string | null;
}
interface PSkillLabelRow {
  orgId: string;
  ownerId: string;
  skillId: string;
  path: string;
}

/** The owner ids the tests use — excluded from path extraction (they share the kebab shape). */
const OWNER_IDS = new Set(["user-a", "user-b"]);
const PARAM_NOISE = new Set([
  "org_id",
  "owner_id",
  "path",
  "display_name",
  "displayName",
  "color",
  "icon",
  "created_at",
  "updated_at",
  "skill_id",
  "scope",
  "personal",
  "org",
  "string",
  "date",
  "now()",
]);

/** Recover bound path-shaped params (kebab/slash, optional trailing `/%`), dropping owner ids + noise. */
function pathParams(expr: unknown): string[] {
  const found: string[] = [];
  const seen = new Set<unknown>();
  const walk = (n: unknown) => {
    if (typeof n === "string") {
      if (
        /^[a-z0-9-]+(?:\/[a-z0-9-]+)*\/?%?$/.test(n) &&
        !PARAM_NOISE.has(n) &&
        !OWNER_IDS.has(n) &&
        !(n.length >= 30 && (n.match(/-/g)?.length ?? 0) >= 4)
      ) {
        found.push(n);
      }
      return;
    }
    if (n === null || typeof n !== "object" || seen.has(n)) return;
    seen.add(n);
    for (const v of Object.values(n as Record<string, unknown>)) walk(v);
  };
  walk(expr);
  return found;
}
function prefixBase(expr: unknown): string | null {
  return pathParams(expr).find((p) => !p.includes("%")) ?? null;
}
const underPrefix = (path: string, base: string) => path === base || path.startsWith(`${base}/`);

function paramFinder(re: RegExp) {
  return (expr: unknown): string | null => {
    let found: string | null = null;
    const seen = new Set<unknown>();
    const walk = (n: unknown) => {
      if (found !== null) return;
      if (typeof n === "string") {
        if (re.test(n)) found = n;
        return;
      }
      if (n === null || typeof n !== "object" || seen.has(n)) return;
      seen.add(n);
      for (const v of Object.values(n as Record<string, unknown>)) walk(v);
    };
    walk(expr);
    return found;
  };
}
const orgParam = paramFinder(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
const ownerParam = paramFinder(/^user-[ab]$/);
const sameOrg = (rowOrg: string, q: string | null) => q == null || rowOrg === q;
const sameOwner = (rowOwner: string, q: string | null) => q == null || rowOwner === q;

interface FakeOptions {
  role?: "owner" | "admin" | "developer" | null;
  labels?: PLabelRow[];
  skillLabels?: PSkillLabelRow[];
  archivedSkillIds?: string[];
  /** slug → { id, scope, creatorId } for resolveOwnPersonalSkillId; omit a slug to model "not found". */
  skillBySlug?: Record<string, { id: string; scope: "personal" | "org"; creatorId: string } | null>;
}

function fakeDb(opts: FakeOptions = {}) {
  const labels: PLabelRow[] = (opts.labels ?? []).map((r) => ({ ...r }));
  const skillLabels: PSkillLabelRow[] = (opts.skillLabels ?? []).map((r) => ({ ...r }));
  const archivedSet = new Set(opts.archivedSkillIds ?? []);
  const role = opts.role === undefined ? "developer" : opts.role;
  const findLabel = (org: string, owner: string, path: string) =>
    labels.find((l) => l.orgId === org && l.ownerId === owner && l.path === path);

  const selectBuilder = (cols: Record<string, unknown>) => {
    let table: unknown;
    let where: unknown;
    const rows = () => {
      const org = orgParam(where);
      const owner = ownerParam(where);
      if (table === schema.personalLabels || "color" in cols) {
        const base = "color" in cols ? null : prefixBase(where);
        const all = labels.filter((l) => sameOrg(l.orgId, org) && sameOwner(l.ownerId, owner));
        const scoped = base == null ? all : all.filter((l) => underPrefix(l.path, base));
        return scoped.map((l) => ({ path: l.path, displayName: l.displayName, color: l.color, icon: l.icon }));
      }
      const params = pathParams(where);
      const base = params.some((p) => p.includes("%")) ? prefixBase(where) : null;
      return skillLabels
        .filter(
          (l) =>
            sameOrg(l.orgId, org) &&
            sameOwner(l.ownerId, owner) &&
            !archivedSet.has(l.skillId) &&
            (base == null || underPrefix(l.path, base)),
        )
        .map((l) => ({ skillId: l.skillId, path: l.path }));
    };
    const builder: Record<string, unknown> = {
      from(t: unknown) {
        table = t;
        return builder;
      },
      innerJoin() {
        return builder;
      },
      where(expr: unknown) {
        where = expr;
        return builder;
      },
      orderBy() {
        return Promise.resolve(rows());
      },
      then(resolve: (v: unknown) => unknown) {
        return Promise.resolve(rows()).then(resolve);
      },
    };
    return builder;
  };

  const insertBuilder = (table: unknown) => {
    let pending: Record<string, unknown> | null = null;
    const api: Record<string, unknown> = {
      values(v: Record<string, unknown>) {
        pending = v;
        return api;
      },
      onConflictDoNothing() {
        if (
          pending &&
          table === schema.personalLabels &&
          !findLabel(pending.orgId as string, pending.ownerId as string, pending.path as string)
        ) {
          labels.push({
            orgId: pending.orgId as string,
            ownerId: pending.ownerId as string,
            path: pending.path as string,
            displayName: (pending.displayName as string | undefined) ?? null,
            color: (pending.color as string | undefined) ?? null,
            icon: (pending.icon as string | undefined) ?? null,
          });
        } else if (pending && table === schema.personalSkillLabels) {
          const dup = skillLabels.some(
            (l) =>
              l.orgId === pending!.orgId &&
              l.ownerId === pending!.ownerId &&
              l.skillId === pending!.skillId &&
              l.path === pending!.path,
          );
          if (!dup) {
            skillLabels.push({
              orgId: pending.orgId as string,
              ownerId: pending.ownerId as string,
              skillId: pending.skillId as string,
              path: pending.path as string,
            });
          }
        }
        return Promise.resolve(undefined);
      },
      onConflictDoUpdate(conf: { set?: Record<string, unknown> }) {
        if (pending && table === schema.personalLabels) {
          const existing = findLabel(pending.orgId as string, pending.ownerId as string, pending.path as string);
          if (existing) {
            if (conf.set && "color" in conf.set) existing.color = (conf.set.color as string | null) ?? null;
            if (conf.set && "icon" in conf.set) existing.icon = (conf.set.icon as string | null) ?? null;
            if (conf.set && "displayName" in conf.set) existing.displayName = (conf.set.displayName as string | null) ?? null;
          } else {
            labels.push({
              orgId: pending.orgId as string,
              ownerId: pending.ownerId as string,
              path: pending.path as string,
              displayName: (pending.displayName as string | undefined) ?? null,
              color: (pending.color as string | undefined) ?? null,
              icon: (pending.icon as string | undefined) ?? null,
            });
          }
        }
        return Promise.resolve(undefined);
      },
    };
    return api;
  };

  const deleteBuilder = (table: unknown) => ({
    where(expr: unknown) {
      const params = pathParams(expr);
      const org = orgParam(expr);
      const owner = ownerParam(expr);
      const hasPrefix = params.some((p) => p.includes("%"));
      if (table === schema.personalSkillLabels && !hasPrefix) {
        const [skillId, path] = params;
        for (let i = skillLabels.length - 1; i >= 0; i--) {
          const r = skillLabels[i]!;
          if (sameOrg(r.orgId, org) && sameOwner(r.ownerId, owner) && r.skillId === skillId && r.path === path) {
            skillLabels.splice(i, 1);
          }
        }
        return Promise.resolve(undefined);
      }
      const base = prefixBase(expr);
      if (base == null) return Promise.resolve(undefined);
      const store = table === schema.personalLabels ? labels : skillLabels;
      for (let i = store.length - 1; i >= 0; i--) {
        const r = store[i] as PLabelRow | PSkillLabelRow;
        if (sameOrg(r.orgId, org) && sameOwner(r.ownerId, owner) && underPrefix((r as { path: string }).path, base)) {
          store.splice(i, 1);
        }
      }
      return Promise.resolve(undefined);
    },
  });

  const txHandle = {
    select: selectBuilder,
    insert: insertBuilder,
    delete: deleteBuilder,
    update: (table: unknown) => {
      let rewritePaths: string[] = [];
      let patch: Record<string, unknown> = {};
      const api: Record<string, unknown> = {
        set(p: Record<string, unknown>) {
          patch = p;
          rewritePaths = pathParams(patch);
          return api;
        },
        where(expr: unknown) {
          const params = pathParams(expr);
          const whereParams = params.filter((p) => !p.includes("%"));
          const likeParam = params.find((p) => p.includes("%"));
          const hasPrefix = likeParam != null;
          const base = hasPrefix ? likeParam.replace(/\/?%$/, "") : whereParams[whereParams.length - 1] ?? null;
          const org = orgParam(expr);
          const owner = ownerParam(expr);
          const target = rewritePaths.find((p) => p !== base) ?? rewritePaths[0] ?? null;
          if (base != null && target != null) {
            const store =
              table === schema.personalLabels ? labels : table === schema.personalSkillLabels ? skillLabels : null;
            if (store) {
              for (const row of store as Array<{ orgId: string; ownerId: string; path: string }>) {
                const matches = hasPrefix ? underPrefix(row.path, base) : row.path === base;
                if (sameOrg(row.orgId, org) && sameOwner(row.ownerId, owner) && matches) {
                  row.path = hasPrefix ? target + row.path.slice(base.length) : target;
                }
              }
            }
          }
          if (table === schema.personalLabels && base != null && "displayName" in patch) {
            const displayPath = typeof patch.path === "string" ? patch.path : base;
            for (const row of labels) {
              if (sameOrg(row.orgId, org) && sameOwner(row.ownerId, owner) && row.path === displayPath) {
                row.displayName = (patch.displayName as string | null) ?? null;
              }
            }
          }
          return Promise.resolve(undefined);
        },
      };
      return api;
    },
  };

  const database = {
    query: {
      memberships: { findFirst: async () => (role === null ? null : { orgRole: role }) },
      skills: {
        findFirst: async (q?: { where?: unknown }) => {
          const params = pathParams(q?.where);
          const map = opts.skillBySlug;
          if (!map) {
            const slug = params[0];
            return slug ? { id: `skill-${slug}`, scope: "personal", creatorId: userA.id } : undefined;
          }
          for (const [slug, row] of Object.entries(map)) {
            if (params.includes(slug)) return row == null ? undefined : { ...row, slug };
          }
          return undefined;
        },
      },
    },
    select: selectBuilder,
    insert: insertBuilder,
    delete: deleteBuilder,
    transaction: async (cb: (tx: typeof txHandle) => unknown) => cb(txHandle),
  };

  return { database: database as unknown as Db, labels, skillLabels };
}

function nodesByPath(tree: LabelTreeNode[]): Map<string, LabelTreeNode> {
  const map = new Map<string, LabelTreeNode>();
  const walk = (nodes: LabelTreeNode[]) => {
    for (const n of nodes) {
      map.set(n.path, n);
      walk(n.children);
    }
  };
  walk(tree);
  return map;
}

const own = (slug: string, owner: ActorContext) =>
  ({ [slug]: { id: `skill-${slug}`, scope: "personal" as const, creatorId: owner.id } });

describe("listPersonalLabels — owner-scoped tree + roll-up counts", () => {
  it("derives parents and rolls up de-duped counts for the owner only", async () => {
    const { database } = fakeDb({
      labels: [{ orgId: ORG, ownerId: userA.id, path: "drafts/research", color: null, icon: null }],
      skillLabels: [
        { orgId: ORG, ownerId: userA.id, skillId: "s1", path: "drafts/research" },
        { orgId: ORG, ownerId: userA.id, skillId: "s2", path: "drafts/research" },
        { orgId: ORG, ownerId: userA.id, skillId: "s1", path: "drafts/notes" },
        // Another member's identically-named personal folder must NOT leak into A's counts.
        { orgId: ORG, ownerId: userB.id, skillId: "s9", path: "drafts/research" },
      ],
    });
    const { tree } = await listPersonalLabels({ actor: userA, orgId: ORG, database });
    const map = nodesByPath(tree);
    expect(map.get("drafts")!.count).toBe(2); // s1 + s2, B's s9 excluded
    expect(map.get("drafts/research")!.count).toBe(2);
    expect(map.get("drafts/notes")!.count).toBe(1);
    expect(map.get("drafts/research")!.explicit).toBe(true);
  });

  it("never returns another member's personal folders", async () => {
    const { database } = fakeDb({
      labels: [
        { orgId: ORG, ownerId: userA.id, path: "mine", color: null, icon: null },
        { orgId: ORG, ownerId: userB.id, path: "theirs", color: null, icon: null },
      ],
    });
    const { tree } = await listPersonalLabels({ actor: userA, orgId: ORG, database });
    const map = nodesByPath(tree);
    expect(map.has("mine")).toBe(true);
    expect(map.has("theirs")).toBe(false);
  });

  it("excludes archived skills from counts", async () => {
    const { database } = fakeDb({
      labels: [{ orgId: ORG, ownerId: userA.id, path: "drafts", color: null, icon: null }],
      skillLabels: [
        { orgId: ORG, ownerId: userA.id, skillId: "live", path: "drafts" },
        { orgId: ORG, ownerId: userA.id, skillId: "gone", path: "drafts" },
      ],
      archivedSkillIds: ["gone"],
    });
    const { tree } = await listPersonalLabels({ actor: userA, orgId: ORG, database });
    expect(nodesByPath(tree).get("drafts")).toMatchObject({ count: 1, explicit: true });
  });

  it("denies non-members", async () => {
    const { database } = fakeDb({ role: null });
    await expect(listPersonalLabels({ actor: userA, orgId: ORG, database })).rejects.toThrow(
      "not a member of this organization",
    );
  });
});

describe("createPersonalLabel — owner-scoped upsert", () => {
  it("materializes the leaf and every ancestor under the actor", async () => {
    const { database, labels } = fakeDb();
    await createPersonalLabel({ actor: userA, orgId: ORG, path: "drafts/research/q3", database });
    expect(labels.map((l) => l.path).sort()).toEqual(["drafts", "drafts/research", "drafts/research/q3"]);
    expect(labels.every((l) => l.ownerId === userA.id)).toBe(true);
  });
});

describe("assignPersonalLabel — only the actor's own authored personal skill", () => {
  it("files the actor's personal skill and upserts the folder", async () => {
    const { database, labels, skillLabels } = fakeDb({ skillBySlug: own("pdf-extractor", userA) });
    await assignPersonalLabel({ actor: userA, orgId: ORG, slug: "pdf-extractor", path: "drafts/research", database });
    expect(skillLabels).toEqual([
      { orgId: ORG, ownerId: userA.id, skillId: "skill-pdf-extractor", path: "drafts/research" },
    ]);
    expect(labels.map((l) => l.path).sort()).toEqual(["drafts", "drafts/research"]);
  });

  it("rejects filing an ORG skill into a personal folder", async () => {
    const { database } = fakeDb({
      skillBySlug: { "brand-linter": { id: "skill-bl", scope: "org", creatorId: userA.id } },
    });
    await expect(
      assignPersonalLabel({ actor: userA, orgId: ORG, slug: "brand-linter", path: "drafts", database }),
    ).rejects.toThrow("personal skill not found");
  });

  it("rejects filing ANOTHER member's personal skill", async () => {
    const { database } = fakeDb({ skillBySlug: own("secret", userB) });
    await expect(
      assignPersonalLabel({ actor: userA, orgId: ORG, slug: "secret", path: "drafts", database }),
    ).rejects.toThrow("personal skill not found");
  });
});

describe("renamePersonalLabel / deletePersonalLabel — owner-scoped cascade", () => {
  it("renames a subtree across both personal tables for the owner only", async () => {
    const { database, labels, skillLabels } = fakeDb({
      labels: [
        { orgId: ORG, ownerId: userA.id, path: "drafts", color: null, icon: null },
        { orgId: ORG, ownerId: userA.id, path: "drafts/research", color: null, icon: null },
        // B has an identically-named folder that must be left untouched.
        { orgId: ORG, ownerId: userB.id, path: "drafts", color: null, icon: null },
      ],
      skillLabels: [
        { orgId: ORG, ownerId: userA.id, skillId: "s1", path: "drafts" },
        { orgId: ORG, ownerId: userA.id, skillId: "s2", path: "drafts/research" },
        { orgId: ORG, ownerId: userB.id, skillId: "s9", path: "drafts" },
      ],
    });
    await renamePersonalLabel({ actor: userA, orgId: ORG, from: "drafts", to: "archive", database });
    expect(labels.filter((l) => l.ownerId === userA.id).map((l) => l.path).sort()).toEqual(["archive", "archive/research"]);
    expect(labels.find((l) => l.ownerId === userB.id)!.path).toBe("drafts"); // B untouched
    expect(skillLabels.filter((l) => l.ownerId === userA.id).map((l) => l.path).sort()).toEqual(["archive", "archive/research"]);
    expect(skillLabels.find((l) => l.ownerId === userB.id)!.path).toBe("drafts");
  });

  it("deletes a personal folder subtree for the owner; another member's folder survives", async () => {
    const { database, labels } = fakeDb({
      labels: [
        { orgId: ORG, ownerId: userA.id, path: "drafts", color: null, icon: null },
        { orgId: ORG, ownerId: userA.id, path: "drafts/research", color: null, icon: null },
        { orgId: ORG, ownerId: userB.id, path: "drafts", color: null, icon: null },
      ],
    });
    await deletePersonalLabel({ actor: userA, orgId: ORG, path: "drafts", database });
    expect(labels.map((l) => `${l.ownerId}:${l.path}`)).toEqual([`${userB.id}:drafts`]);
  });

  it("unassign removes one of the actor's edges only", async () => {
    const { database, skillLabels } = fakeDb({
      skillBySlug: own("pdf-extractor", userA),
      labels: [{ orgId: ORG, ownerId: userA.id, path: "drafts", color: null, icon: null }],
      skillLabels: [{ orgId: ORG, ownerId: userA.id, skillId: "skill-pdf-extractor", path: "drafts" }],
    });
    await unassignPersonalLabel({ actor: userA, orgId: ORG, slug: "pdf-extractor", path: "drafts", database });
    expect(skillLabels).toHaveLength(0);
  });
});

describe("cross-tenant isolation", () => {
  it("listPersonalLabels only returns the queried org's folders", async () => {
    const { database } = fakeDb({
      labels: [
        { orgId: ORG, ownerId: userA.id, path: "mine", color: null, icon: null },
        { orgId: OTHER_ORG, ownerId: userA.id, path: "elsewhere", color: null, icon: null },
      ],
    });
    const { tree } = await listPersonalLabels({ actor: userA, orgId: ORG, database });
    const map = nodesByPath(tree);
    expect(map.has("mine")).toBe(true);
    expect(map.has("elsewhere")).toBe(false);
  });
});
