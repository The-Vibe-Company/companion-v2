import { describe, expect, it } from "vitest";
import { schema, type Db } from "@companion/db";
import type { LabelTreeNode } from "@companion/contracts";
import {
  assignLabel,
  createLabel,
  deleteLabel,
  listLabels,
  renameLabel,
  setLabelColor,
  setLabelIcon,
  unassignLabel,
  type ActorContext,
} from "../src/services";

/**
 * A behavioral in-memory fakeDb for the label service. The two label tables are modeled as plain
 * arrays; every builder call is dispatched by TABLE IDENTITY (the service passes `schema.labels` /
 * `schema.skillLabels` / `schema.skills`, never a bare column).
 *
 * Plain `eq`-driven reads/writes are applied straight from the `.values()` payload. The `sql` prefix
 * cascades (`path = $p or path like $p/%`) and the exact-row delete can't be evaluated as opaque SQL,
 * so we recover their bound PATH params from the captured where-expression with `pathParams` — a
 * walker that filters out the fixed set of column / type / uuid noise so only the real path values
 * survive, in order. This lets us assert the genuine rename/delete CASCADE + collision behavior, not
 * merely that a method was called.
 */
const ORG = "00000000-0000-0000-0000-0000000000aa";
const OTHER_ORG = "00000000-0000-0000-0000-0000000000bb";
const actor: ActorContext = { id: "user-1", email: "user@example.com", name: "User One" };

interface LabelRow {
  orgId: string;
  path: string;
  displayName?: string | null;
  color: string | null;
  icon: string | null;
}
interface SkillLabelRow {
  orgId: string;
  skillId: string;
  path: string;
}

/** Known column / type / function tokens that share the kebab-ish shape but are NOT bound values. */
const PARAM_NOISE = new Set([
  "org_id",
  "path",
  "display_name",
  "displayName",
  "color",
  "icon",
  "created_by",
  "created_at",
  "updated_at",
  "skill_id",
  "string",
  "date",
  "now()",
]);

/**
 * Recover the bound path-shaped params from a drizzle where-/set-expression, in walk order. Keeps
 * kebab/slash values (optionally a trailing `/%` from a LIKE prefix), drops column names (underscores),
 * type tags, and uuid org ids.
 */
function pathParams(expr: unknown): string[] {
  const found: string[] = [];
  const seen = new Set<unknown>();
  const walk = (n: unknown) => {
    if (typeof n === "string") {
      if (
        /^[a-z0-9-]+(?:\/[a-z0-9-]+)*\/?%?$/.test(n) &&
        !PARAM_NOISE.has(n) &&
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

/** The base path of a prefix predicate: the bound value WITHOUT a trailing `%`. */
function prefixBase(expr: unknown): string | null {
  return pathParams(expr).find((p) => !p.includes("%")) ?? null;
}
const underPrefix = (path: string, base: string) => path === base || path.startsWith(`${base}/`);

/**
 * Recover the bound org-id uuid from a where-expression — the inverse of `pathParams`, which drops it.
 * Lets the fake builders honor the real `eq(org_id, …)` predicate instead of a hardcoded ORG, so a
 * cross-tenant test actually fails if production ever stops scoping by org.
 */
function orgParam(expr: unknown): string | null {
  let found: string | null = null;
  const seen = new Set<unknown>();
  const walk = (n: unknown) => {
    if (found !== null) return;
    if (typeof n === "string") {
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(n)) found = n;
      return;
    }
    if (n === null || typeof n !== "object" || seen.has(n)) return;
    seen.add(n);
    for (const v of Object.values(n as Record<string, unknown>)) walk(v);
  };
  walk(expr);
  return found;
}
const sameOrg = (rowOrg: string, queryOrg: string | null) => queryOrg == null || rowOrg === queryOrg;

interface FakeOptions {
  role?: "owner" | "admin" | "developer" | null;
  labels?: LabelRow[];
  skillLabels?: SkillLabelRow[];
  /** Skill ids that are archived — `listLabels` joins `skills` and excludes their assignments from counts. */
  archivedSkillIds?: string[];
  /** slug → skill id for `resolveSkillId`; map a slug to `null` to model "not found". */
  skillBySlug?: Record<string, string | null>;
  /** Slugs whose resolved skill is PERSONAL-scoped (org labels must reject these). Default: org. */
  personalSlugs?: string[];
}

function fakeDb(opts: FakeOptions = {}) {
  const labels: LabelRow[] = (opts.labels ?? []).map((r) => ({ ...r }));
  const skillLabels: SkillLabelRow[] = (opts.skillLabels ?? []).map((r) => ({ ...r }));
  const archivedSet = new Set(opts.archivedSkillIds ?? []);
  const role = opts.role === undefined ? "developer" : opts.role;
  const findLabel = (org: string, path: string) => labels.find((l) => l.orgId === org && l.path === path);

  // ---- select (listLabels reads both tables; rename collision probe reads labels in a tx) --------
  const selectBuilder = (cols: Record<string, unknown>) => {
    let table: unknown;
    let where: unknown;
    const rows = () => {
      const org = orgParam(where);
      if (table === schema.labels || "color" in cols) {
        // The rename collision probe selects {path} from labels with a prefix predicate.
        const base = "color" in cols ? null : prefixBase(where);
        const all = labels.filter((l) => sameOrg(l.orgId, org));
        const scoped = base == null ? all : all.filter((l) => underPrefix(l.path, base));
        return scoped.map((l) => ({ path: l.path, displayName: l.displayName, color: l.color, icon: l.icon }));
      }
      // Mirrors the production innerJoin(skills) + isNull(archived_at): archived skills drop out of counts.
      const params = pathParams(where);
      const base = params.some((p) => p.includes("%")) ? prefixBase(where) : null;
      return skillLabels
        .filter((l) => sameOrg(l.orgId, org) && !archivedSet.has(l.skillId) && (base == null || underPrefix(l.path, base)))
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

  // ---- insert (label upserts; assignment edge) ---------------------------------------------------
  const insertBuilder = (table: unknown) => {
    let pending: Record<string, unknown> | null = null;
    const api: Record<string, unknown> = {
      values(v: Record<string, unknown>) {
        pending = v;
        return api;
      },
      onConflictDoNothing() {
        if (pending && table === schema.labels && !findLabel(pending.orgId as string, pending.path as string)) {
          labels.push({
            orgId: pending.orgId as string,
            path: pending.path as string,
            displayName: (pending.displayName as string | undefined) ?? null,
            color: (pending.color as string | undefined) ?? null,
            icon: (pending.icon as string | undefined) ?? null,
          });
        } else if (pending && table === schema.skillLabels) {
          const dup = skillLabels.some(
            (l) => l.orgId === pending!.orgId && l.skillId === pending!.skillId && l.path === pending!.path,
          );
          if (!dup) {
            skillLabels.push({
              orgId: pending.orgId as string,
              skillId: pending.skillId as string,
              path: pending.path as string,
            });
          }
        }
        return Promise.resolve(undefined);
      },
      onConflictDoUpdate(conf: { set?: Record<string, unknown> }) {
        if (pending && table === schema.labels) {
          const existing = findLabel(pending.orgId as string, pending.path as string);
          if (existing) {
            if (conf.set && "color" in conf.set) existing.color = (conf.set.color as string | null) ?? null;
            if (conf.set && "icon" in conf.set) existing.icon = (conf.set.icon as string | null) ?? null;
            if (conf.set && "displayName" in conf.set) {
              existing.displayName = (conf.set.displayName as string | null) ?? null;
            }
          } else {
            labels.push({
              orgId: pending.orgId as string,
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

  // ---- delete (unassign = exact eq row; deleteLabel = prefix cascade) ----------------------------
  const deleteBuilder = (table: unknown) => ({
    where(expr: unknown) {
      const params = pathParams(expr);
      const org = orgParam(expr);
      const hasPrefix = params.some((p) => p.includes("%"));
      if (table === schema.skillLabels && !hasPrefix) {
        // unassignLabel: eq(skillId) + eq(path) — params are [skillId, path].
        const [skillId, path] = params;
        for (let i = skillLabels.length - 1; i >= 0; i--) {
          const r = skillLabels[i]!;
          if (sameOrg(r.orgId, org) && r.skillId === skillId && r.path === path) skillLabels.splice(i, 1);
        }
        return Promise.resolve(undefined);
      }
      // deleteLabel prefix cascade across either table.
      const base = prefixBase(expr);
      if (base == null) return Promise.resolve(undefined);
      const store = table === schema.labels ? labels : skillLabels;
      for (let i = store.length - 1; i >= 0; i--) {
        const r = store[i] as LabelRow | SkillLabelRow;
        if (sameOrg(r.orgId, org) && underPrefix((r as { path: string }).path, base)) store.splice(i, 1);
      }
      return Promise.resolve(undefined);
    },
  });

  // ---- transaction handle (rename + delete cascades) ---------------------------------------------
  const txHandle = {
    select: selectBuilder,
    insert: insertBuilder,
    delete: deleteBuilder,
    update: (table: unknown) => {
      let rewritePaths: string[] = [];
      let patch: Record<string, unknown> = {};
      const api: Record<string, unknown> = {
        set(p: Record<string, unknown>) {
          // The rewrite CASE carries `from` and `to`; the where clause supplies the moved base path.
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
          const target = rewritePaths.find((p) => p !== base) ?? rewritePaths[0] ?? null;
          if (base != null && target != null) {
            const store = table === schema.labels ? labels : table === schema.skillLabels ? skillLabels : null;
            if (store) {
              for (const row of store as Array<{ orgId: string; path: string }>) {
                const matches = hasPrefix ? underPrefix(row.path, base) : row.path === base;
                if (sameOrg(row.orgId, org) && matches) {
                  row.path = hasPrefix ? target + row.path.slice(base.length) : target;
                }
              }
            }
          }
          if (table === schema.labels && base != null && "displayName" in patch) {
            const displayPath = typeof patch.path === "string" ? patch.path : base;
            for (const row of labels) {
              if (sameOrg(row.orgId, org) && row.path === displayPath) {
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
          const personal = new Set(opts.personalSlugs ?? []);
          const scopeFor = (slug: string) => (personal.has(slug) ? ("personal" as const) : ("org" as const));
          const map = opts.skillBySlug;
          if (map) {
            for (const [slug, id] of Object.entries(map)) {
              if (params.includes(slug)) return id == null ? undefined : { id, scope: scopeFor(slug) };
            }
            return undefined;
          }
          const slug = params[0];
          return slug ? { id: `skill-${slug}`, scope: scopeFor(slug) } : undefined;
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

/** Flatten a derived tree into a path → node map for assertions. */
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

describe("listLabels — tree derivation + roll-up counts", () => {
  it("derives intermediate parents and rolls up de-duped skill counts", async () => {
    const { database } = fakeDb({
      labels: [{ orgId: ORG, path: "marketing/seo", color: null, icon: null }],
      skillLabels: [
        { orgId: ORG, skillId: "s1", path: "marketing/seo" },
        { orgId: ORG, skillId: "s2", path: "marketing/seo" },
        // s1 also filed under a sibling subpath — must NOT be double-counted toward `marketing`.
        { orgId: ORG, skillId: "s1", path: "marketing/ads" },
      ],
    });
    const { tree } = await listLabels({ actor, orgId: ORG, database });
    const map = nodesByPath(tree);
    expect(map.get("marketing")).toBeDefined(); // derived parent
    expect(map.get("marketing")!.count).toBe(2); // s1 + s2 de-duped
    expect(map.get("marketing/seo")!.count).toBe(2);
    expect(map.get("marketing/ads")!.count).toBe(1);
    expect(map.get("marketing")!.explicit).toBe(false); // derived parent only
    expect(map.get("marketing/seo")!.explicit).toBe(true); // a labels row exists
  });

  it("keeps an empty explicit folder in the tree with count 0", async () => {
    const { database } = fakeDb({ labels: [{ orgId: ORG, path: "growth", color: null, icon: null }] });
    const { tree, flat } = await listLabels({ actor, orgId: ORG, database });
    expect(nodesByPath(tree).get("growth")).toMatchObject({ count: 0, explicit: true });
    expect(flat).toEqual([{ path: "growth", displayName: null, color: null, icon: null }]);
  });

  it("excludes archived skills from roll-up counts (matches the folder list)", async () => {
    const { database } = fakeDb({
      labels: [{ orgId: ORG, path: "marketing", color: null, icon: null }],
      skillLabels: [
        { orgId: ORG, skillId: "live", path: "marketing" },
        { orgId: ORG, skillId: "gone", path: "marketing" },
      ],
      archivedSkillIds: ["gone"],
    });
    const { tree } = await listLabels({ actor, orgId: ORG, database });
    // The archived "gone" assignment is excluded, so the folder counts only the live skill but the
    // explicit folder still appears.
    expect(nodesByPath(tree).get("marketing")).toMatchObject({ count: 1, explicit: true });
  });

  it("denies non-members", async () => {
    const { database } = fakeDb({ role: null });
    await expect(listLabels({ actor, orgId: ORG, database })).rejects.toThrow("not a member of this organization");
  });
});

describe("createLabel — upsert path + ancestors", () => {
  it("materializes the leaf and every ancestor", async () => {
    const { database, labels } = fakeDb();
    await createLabel({ actor, orgId: ORG, path: "marketing/seo/local", database });
    expect(labels.map((l) => l.path).sort()).toEqual(["marketing", "marketing/seo", "marketing/seo/local"]);
  });

  it("stores a display name on the explicitly created label", async () => {
    const { database, labels } = fakeDb();
    await createLabel({ actor, orgId: ORG, path: "dev", displayName: "Dev", database });
    expect(labels.find((l) => l.path === "dev")!.displayName).toBe("Dev");
  });

  it("only overwrites appearance fields that are supplied", async () => {
    const { database, labels } = fakeDb({
      labels: [{ orgId: ORG, path: "growth", color: "oklch(0.56 0.13 250)", icon: "rocket" }],
    });
    await createLabel({ actor, orgId: ORG, path: "growth", icon: "star", database });
    const row = labels.find((l) => l.path === "growth")!;
    expect(row.icon).toBe("star");
    expect(row.color).toBe("oklch(0.56 0.13 250)"); // untouched
  });

  it("rejects an invalid path", async () => {
    const { database } = fakeDb();
    await expect(createLabel({ actor, orgId: ORG, path: "Bad Path", database })).rejects.toThrow();
  });
});

describe("assignLabel / unassignLabel", () => {
  it("assigns a path (idempotent) and upserts the folder + ancestors", async () => {
    const { database, labels, skillLabels } = fakeDb({ skillBySlug: { "incident-summary": "skill-1" } });
    await assignLabel({ actor, orgId: ORG, slug: "incident-summary", path: "marketing/seo", database });
    await assignLabel({ actor, orgId: ORG, slug: "incident-summary", path: "marketing/seo", database }); // idempotent
    expect(skillLabels.filter((l) => l.skillId === "skill-1" && l.path === "marketing/seo")).toHaveLength(1);
    expect(labels.map((l) => l.path).sort()).toEqual(["marketing", "marketing/seo"]);
  });

  it("unassigns a single path, leaving the folder and other assignments intact", async () => {
    const { database, labels, skillLabels } = fakeDb({
      skillBySlug: { "incident-summary": "skill-1" },
      labels: [{ orgId: ORG, path: "marketing/seo", color: null, icon: null }],
      skillLabels: [
        { orgId: ORG, skillId: "skill-1", path: "marketing/seo" },
        { orgId: ORG, skillId: "skill-2", path: "marketing/seo" },
      ],
    });
    await unassignLabel({ actor, orgId: ORG, slug: "incident-summary", path: "marketing/seo", database });
    expect(skillLabels).toEqual([{ orgId: ORG, skillId: "skill-2", path: "marketing/seo" }]);
    expect(labels.some((l) => l.path === "marketing/seo")).toBe(true); // folder survives
  });

  it("throws when the skill slug does not resolve", async () => {
    const { database } = fakeDb({ skillBySlug: { ghost: null } });
    await expect(assignLabel({ actor, orgId: ORG, slug: "ghost", path: "growth", database })).rejects.toThrow(
      "skill not found",
    );
  });

  it("rejects org labels on a PERSONAL skill (no leak into the shared folder tree)", async () => {
    const { database, skillLabels } = fakeDb({ skillBySlug: { "my-draft": "skill-p" }, personalSlugs: ["my-draft"] });
    await expect(assignLabel({ actor, orgId: ORG, slug: "my-draft", path: "growth", database })).rejects.toThrow(
      "skill not found",
    );
    await expect(unassignLabel({ actor, orgId: ORG, slug: "my-draft", path: "growth", database })).rejects.toThrow(
      "skill not found",
    );
    expect(skillLabels).toHaveLength(0);
  });
});

describe("setLabelColor / setLabelIcon", () => {
  it("sets and clears the color (null) on the path", async () => {
    const { database, labels } = fakeDb();
    await setLabelColor({ actor, orgId: ORG, path: "growth", color: "oklch(0.62 0.16 145)", database });
    expect(labels.find((l) => l.path === "growth")!.color).toBe("oklch(0.62 0.16 145)");
    await setLabelColor({ actor, orgId: ORG, path: "growth", color: null, database });
    expect(labels.find((l) => l.path === "growth")!.color).toBeNull();
  });

  it("sets the icon on the path", async () => {
    const { database, labels } = fakeDb();
    await setLabelIcon({ actor, orgId: ORG, path: "growth", icon: "flame", database });
    expect(labels.find((l) => l.path === "growth")!.icon).toBe("flame");
  });
});

describe("renameLabel — prefix cascade + collision reject", () => {
  it("renames a subtree across both labels and skill_labels", async () => {
    const { database, labels, skillLabels } = fakeDb({
      labels: [
        { orgId: ORG, path: "marketing", color: null, icon: null },
        { orgId: ORG, path: "marketing/seo", color: null, icon: null },
      ],
      skillLabels: [
        { orgId: ORG, skillId: "s1", path: "marketing" },
        { orgId: ORG, skillId: "s2", path: "marketing" },
        { orgId: ORG, skillId: "s3", path: "marketing/seo" },
        { orgId: ORG, skillId: "s4", path: "marketing/seo" },
      ],
    });
    await renameLabel({ actor, orgId: ORG, from: "marketing", to: "growth", database });
    expect(labels.map((l) => l.path).sort()).toEqual(["growth", "growth/seo"]);
    expect(labels.some((l) => l.path === "marketing" || l.path === "marketing/seo")).toBe(false);
    expect(skillLabels.map((l) => `${l.skillId}:${l.path}`).sort()).toEqual([
      "s1:growth",
      "s2:growth",
      "s3:growth/seo",
      "s4:growth/seo",
    ]);
    expect(skillLabels.some((l) => l.path === "marketing" || l.path === "marketing/seo")).toBe(false);
  });

  it("renames a nested label with direct and descendant skill assignments", async () => {
    const { database, labels, skillLabels } = fakeDb({
      labels: [
        { orgId: ORG, path: "marketing", color: null, icon: null },
        { orgId: ORG, path: "marketing/seo", color: null, icon: null },
        { orgId: ORG, path: "marketing/seo/local", color: null, icon: null },
      ],
      skillLabels: [
        { orgId: ORG, skillId: "s1", path: "marketing" },
        { orgId: ORG, skillId: "s2", path: "marketing/seo" },
        { orgId: ORG, skillId: "s3", path: "marketing/seo/local" },
      ],
    });
    await renameLabel({ actor, orgId: ORG, from: "marketing/seo", to: "marketing/growth", database });
    expect(labels.map((l) => l.path).sort()).toEqual(["marketing", "marketing/growth", "marketing/growth/local"]);
    expect(labels.some((l) => l.path === "marketing/seo" || l.path === "marketing/seo/local")).toBe(false);
    expect(skillLabels.map((l) => `${l.skillId}:${l.path}`).sort()).toEqual([
      "s1:marketing",
      "s2:marketing/growth",
      "s3:marketing/growth/local",
    ]);
    expect(skillLabels.some((l) => l.path === "marketing/seo" || l.path === "marketing/seo/local")).toBe(false);
  });

  it("renames a nested label path and stores the moved root display name", async () => {
    const { database, labels, skillLabels } = fakeDb({
      labels: [
        { orgId: ORG, path: "marketing", color: null, icon: null },
        { orgId: ORG, path: "marketing/seo", color: null, icon: null },
        { orgId: ORG, path: "marketing/seo/local", color: null, icon: null },
      ],
      skillLabels: [{ orgId: ORG, skillId: "s1", path: "marketing/seo/local" }],
    });
    await renameLabel({
      actor,
      orgId: ORG,
      from: "marketing/seo",
      to: "marketing/growth-team",
      displayName: "Growth Team",
      database,
    });
    expect(labels.find((l) => l.path === "marketing/growth-team")!.displayName).toBe("Growth Team");
    expect(labels.map((l) => l.path).sort()).toEqual(["marketing", "marketing/growth-team", "marketing/growth-team/local"]);
    expect(skillLabels.map((l) => l.path)).toEqual(["marketing/growth-team/local"]);
  });

  it("stores a display name when renaming an implicit label", async () => {
    const { database, labels, skillLabels } = fakeDb({
      labels: [],
      skillLabels: [{ orgId: ORG, skillId: "s1", path: "engineering/tools" }],
    });
    await renameLabel({ actor, orgId: ORG, from: "engineering", to: "dev", displayName: "Dev", database });
    expect(labels).toContainEqual({ orgId: ORG, path: "dev", displayName: "Dev", color: null, icon: null });
    expect(skillLabels.map((l) => l.path)).toEqual(["dev/tools"]);
  });

  it("updates the display name when the canonical path is unchanged", async () => {
    const { database, labels } = fakeDb({
      labels: [{ orgId: ORG, path: "dev", color: null, icon: null }],
    });
    await renameLabel({ actor, orgId: ORG, from: "dev", to: "dev", displayName: "Dev", database });
    expect(labels.find((l) => l.path === "dev")!.displayName).toBe("Dev");
  });

  it("rejects a rename whose target already exists (no silent merge)", async () => {
    const { database } = fakeDb({
      labels: [
        { orgId: ORG, path: "marketing", color: null, icon: null },
        { orgId: ORG, path: "growth", color: null, icon: null },
      ],
    });
    await expect(renameLabel({ actor, orgId: ORG, from: "marketing", to: "growth", database })).rejects.toThrow(
      "a label with that name already exists",
    );
  });

  it("rejects moving a label into its own subtree", async () => {
    const { database } = fakeDb({ labels: [{ orgId: ORG, path: "marketing", color: null, icon: null }] });
    await expect(renameLabel({ actor, orgId: ORG, from: "marketing", to: "marketing/seo", database })).rejects.toThrow(
      "cannot move a label into its own subtree",
    );
  });
});

describe("deleteLabel — prefix cascade", () => {
  it("removes the folder + its subtree across both tables; sibling folders survive", async () => {
    const { database, labels, skillLabels } = fakeDb({
      labels: [
        { orgId: ORG, path: "marketing", color: null, icon: null },
        { orgId: ORG, path: "marketing/seo", color: null, icon: null },
        { orgId: ORG, path: "growth", color: null, icon: null },
      ],
      skillLabels: [
        { orgId: ORG, skillId: "s1", path: "marketing/seo" },
        { orgId: ORG, skillId: "s2", path: "growth" },
      ],
    });
    await deleteLabel({ actor, orgId: ORG, path: "marketing", database });
    expect(labels.map((l) => l.path).sort()).toEqual(["growth"]);
    expect(skillLabels.map((l) => l.path).sort()).toEqual(["growth"]);
  });
});

describe("empty label survives removing a skill's last assignment", () => {
  it("keeps the (now empty) explicit folder after unassigning the sole skill", async () => {
    const { database, labels, skillLabels } = fakeDb({
      skillBySlug: { solo: "skill-solo" },
      labels: [{ orgId: ORG, path: "marketing/seo", color: null, icon: null }],
      skillLabels: [{ orgId: ORG, skillId: "skill-solo", path: "marketing/seo" }],
    });
    await unassignLabel({ actor, orgId: ORG, slug: "solo", path: "marketing/seo", database });
    expect(skillLabels).toHaveLength(0);
    expect(labels.some((l) => l.path === "marketing/seo")).toBe(true);
    const { tree } = await listLabels({ actor, orgId: ORG, database });
    expect(nodesByPath(tree).get("marketing/seo")).toMatchObject({ count: 0, explicit: true });
  });
});

describe("cross-tenant isolation", () => {
  it("listLabels only returns the queried org's labels", async () => {
    const { database } = fakeDb({
      labels: [
        { orgId: ORG, path: "mine", color: null, icon: null },
        { orgId: OTHER_ORG, path: "theirs", color: null, icon: null },
      ],
      skillLabels: [
        { orgId: ORG, skillId: "s1", path: "mine" },
        { orgId: OTHER_ORG, skillId: "s9", path: "theirs" },
      ],
    });
    const { tree } = await listLabels({ actor, orgId: ORG, database });
    const map = nodesByPath(tree);
    expect(map.has("mine")).toBe(true);
    expect(map.has("theirs")).toBe(false);
  });

  it("deleteLabel never touches another org's identically-named rows", async () => {
    const { database, labels } = fakeDb({
      labels: [
        { orgId: ORG, path: "marketing", color: null, icon: null },
        { orgId: OTHER_ORG, path: "marketing", color: null, icon: null },
      ],
    });
    await deleteLabel({ actor, orgId: ORG, path: "marketing", database });
    expect(labels.map((l) => `${l.orgId}:${l.path}`)).toEqual([`${OTHER_ORG}:marketing`]);
  });
});
