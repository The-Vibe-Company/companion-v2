import { describe, expect, it } from "vitest";
import { schema, type Db } from "@companion/db";
import { buildSkillSharePlan, shareSkill, type ActorContext } from "../src/services";

const ORG = "00000000-0000-0000-0000-0000000000aa";
const owner: ActorContext = { id: "user-owner", email: "o@example.com", name: "Owner" };
const other: ActorContext = { id: "user-other", email: "x@example.com", name: "Other" };

interface SkillRow {
  id: string;
  orgId: string;
  slug: string;
  scope: "personal" | "org";
  creatorId: string;
  currentVersionId: string | null;
  archivedAt: Date | null;
}

interface EdgeRow {
  skillVersionId: string;
  skillId: string;
  dependsOnSlug: string;
  dependsOnSkillId: string | null;
}

function skill(slug: string, overrides: Partial<SkillRow> = {}): SkillRow {
  return {
    id: `skill-${slug}`,
    orgId: ORG,
    slug,
    scope: "personal",
    creatorId: owner.id,
    currentVersionId: `version-${slug}`,
    archivedAt: null,
    ...overrides,
  };
}

function edge(from: SkillRow, toSlug: string, to?: SkillRow): EdgeRow {
  return {
    skillVersionId: from.currentVersionId ?? `version-${from.slug}`,
    skillId: from.id,
    dependsOnSlug: toSlug,
    dependsOnSkillId: to?.id ?? null,
  };
}

function fakeDb(opts: {
  role?: "owner" | "admin" | "developer" | null;
  skills?: SkillRow[];
  root?: SkillRow | null;
  edges?: EdgeRow[];
  migrationSlugs?: string[];
  failOnUpdate?: boolean;
}) {
  const role = opts.role === undefined ? "developer" : opts.role;
  const skills = opts.skills ?? (opts.root ? [opts.root] : []);
  const root = opts.root === undefined ? skills[0] ?? null : opts.root;
  const edges = opts.edges ?? [];
  const migrationSlugs = new Set(opts.migrationSlugs ?? (root ? [root.slug] : []));
  const captured = {
    scopeUpdates: 0,
    personalLabelsCleared: false,
    audit: null as Record<string, unknown> | null,
  };

  const handle = {
    query: {
      memberships: { findFirst: async () => (role === null ? null : { orgRole: role }) },
      skills: { findFirst: async () => root ?? undefined },
    },
    select: () => ({
      from(table: unknown) {
        if (table === schema.skills) {
          return {
            leftJoin: () => ({
              where: async () =>
                skills.map((s) => ({
                  id: s.id,
                  slug: s.slug,
                  scope: s.scope,
                  creatorId: s.creatorId,
                  archivedAt: s.archivedAt,
                  currentVersionId: s.currentVersionId,
                  currentVersion: s.currentVersionId ? "1.0.0" : null,
                })),
            }),
            where: async () =>
              skills.filter((s) => s.scope === "personal" && s.creatorId === owner.id && migrationSlugs.has(s.slug)),
          };
        }
        if (table === schema.skillVersionDependencies) {
          return { where: async () => edges };
        }
        return { where: async () => [] };
      },
    }),
    update: (table: unknown) => ({
      set(patch: Record<string, unknown>) {
        if (table === schema.skills && "scope" in patch) captured.scopeUpdates += 1;
        return {
          where: async () => {
            if (opts.failOnUpdate) throw new Error("update failed");
          },
        };
      },
    }),
    delete: (table: unknown) => ({
      where: async () => {
        if (table === schema.personalSkillLabels) captured.personalLabelsCleared = true;
      },
    }),
    insert: (table: unknown) => ({
      values: async (v: Record<string, unknown>) => {
        if (table === schema.auditLog) captured.audit = v;
      },
    }),
  };

  const database = {
    ...handle,
    transaction: async (cb: (tx: typeof handle) => unknown) => cb(handle),
  };

  return { database: database as unknown as Db, captured };
}

const personalSkill = skill("pdf-extractor");

describe("shareSkill — move a personal skill into the org library", () => {
  it("flips scope personal → org, clears personal folders, and audits (owner)", async () => {
    const { database, captured } = fakeDb({ root: personalSkill, migrationSlugs: ["pdf-extractor"] });
    const result = await shareSkill({ actor: owner, orgId: ORG, slug: "pdf-extractor", database });
    expect(result).toEqual({ scope: "org", shared_dependencies: [] });
    expect(captured.scopeUpdates).toBe(1);
    expect(captured.personalLabelsCleared).toBe(true);
    expect(captured.audit).toMatchObject({
      action: "skill.share",
      targetId: "skill-pdf-extractor",
      metadata: { slug: "pdf-extractor", shared_dependencies: [] },
    });
  });

  it("plans and shares direct private dependencies owned by the same creator", async () => {
    const dep = skill("markdown-report");
    const { database } = fakeDb({
      root: personalSkill,
      skills: [personalSkill, dep],
      edges: [edge(personalSkill, dep.slug, dep)],
      migrationSlugs: ["pdf-extractor", "markdown-report"],
    });

    await expect(buildSkillSharePlan({ actor: owner, orgId: ORG, slug: personalSkill.slug, database })).resolves.toEqual({
      slug: "pdf-extractor",
      dependencies: [{ slug: "markdown-report", status: "satisfied", note: null }],
      blocked: [],
    });
    await expect(shareSkill({ actor: owner, orgId: ORG, slug: personalSkill.slug, database })).resolves.toEqual({
      scope: "org",
      shared_dependencies: ["markdown-report"],
    });
  });

  it("includes transitive private dependencies but ignores dependencies already in the org library", async () => {
    const direct = skill("report-pack");
    const transitive = skill("markdown-report");
    const orgDep = skill("org-toolkit", { scope: "org" });
    const { database } = fakeDb({
      root: personalSkill,
      skills: [personalSkill, direct, transitive, orgDep],
      edges: [edge(personalSkill, direct.slug, direct), edge(direct, transitive.slug, transitive), edge(direct, orgDep.slug, orgDep)],
      migrationSlugs: ["pdf-extractor", "report-pack", "markdown-report"],
    });

    const result = await shareSkill({ actor: owner, orgId: ORG, slug: personalSkill.slug, database });
    expect(result.shared_dependencies).toEqual(["markdown-report", "report-pack"]);
  });

  it("does not block sharing on transitive dependencies of an org dependency", async () => {
    const orgDep = skill("org-toolkit", { scope: "org" });
    const { database } = fakeDb({
      root: personalSkill,
      skills: [personalSkill, orgDep],
      edges: [edge(personalSkill, orgDep.slug, orgDep), edge(orgDep, "missing-in-org-toolkit")],
      migrationSlugs: ["pdf-extractor"],
    });

    await expect(buildSkillSharePlan({ actor: owner, orgId: ORG, slug: personalSkill.slug, database })).resolves.toEqual({
      slug: "pdf-extractor",
      dependencies: [],
      blocked: [],
    });
  });

  it("blocks unresolved dependency graphs before mutating", async () => {
    const { database, captured } = fakeDb({
      root: personalSkill,
      skills: [personalSkill],
      edges: [edge(personalSkill, "missing-dep")],
      migrationSlugs: ["pdf-extractor"],
    });

    await expect(shareSkill({ actor: owner, orgId: ORG, slug: personalSkill.slug, database })).rejects.toThrow(
      "share dependencies must be resolved before sharing",
    );
    expect(captured.scopeUpdates).toBe(0);
    expect(captured.personalLabelsCleared).toBe(false);
  });

  it("reports dependencies owned by another member as generically missing", async () => {
    const hidden = skill("hidden-private", { creatorId: other.id });
    const { database } = fakeDb({
      root: personalSkill,
      skills: [personalSkill, hidden],
      edges: [edge(personalSkill, hidden.slug, hidden)],
      migrationSlugs: ["pdf-extractor"],
    });

    await expect(buildSkillSharePlan({ actor: owner, orgId: ORG, slug: personalSkill.slug, database })).resolves.toEqual({
      slug: "pdf-extractor",
      dependencies: [],
      blocked: [{ slug: "hidden-private", status: "missing", msg: "not published to this workspace" }],
    });
  });

  it("does not continue to cleanup or audit when the scope update fails", async () => {
    const { database, captured } = fakeDb({ root: personalSkill, migrationSlugs: ["pdf-extractor"], failOnUpdate: true });
    await expect(shareSkill({ actor: owner, orgId: ORG, slug: personalSkill.slug, database })).rejects.toThrow("update failed");
    expect(captured.personalLabelsCleared).toBe(false);
    expect(captured.audit).toBeNull();
  });

  it("hides another member's personal skill from the share plan", async () => {
    const { database, captured } = fakeDb({ role: "admin", root: personalSkill });
    await expect(buildSkillSharePlan({ actor: other, orgId: ORG, slug: "pdf-extractor", database })).rejects.toThrow(
      "skill not found",
    );
    expect(captured.scopeUpdates).toBe(0);
  });

  it("denies a member who is not the owner without leaking personal skill existence", async () => {
    const { database, captured } = fakeDb({ role: "admin", root: personalSkill });
    await expect(shareSkill({ actor: other, orgId: ORG, slug: "pdf-extractor", database })).rejects.toThrow(
      "skill not found",
    );
    expect(captured.scopeUpdates).toBe(0);
  });

  it("rejects sharing an org skill (it is already shared)", async () => {
    const orgSkill: SkillRow = { ...personalSkill, scope: "org" };
    const { database } = fakeDb({ root: orgSkill });
    await expect(shareSkill({ actor: owner, orgId: ORG, slug: "pdf-extractor", database })).rejects.toThrow(
      "only the owner can share a personal skill",
    );
  });

  it("throws when the skill does not exist", async () => {
    const { database } = fakeDb({ root: null });
    await expect(shareSkill({ actor: owner, orgId: ORG, slug: "ghost", database })).rejects.toThrow("skill not found");
  });

  it("denies a non-member", async () => {
    const { database } = fakeDb({ role: null, root: personalSkill });
    await expect(shareSkill({ actor: owner, orgId: ORG, slug: "pdf-extractor", database })).rejects.toThrow(
      "not a member of this organization",
    );
  });
});
