import { describe, expect, it } from "vitest";
import { schema, type Db } from "@companion/db";
import { fallbackCompanionManifest } from "@companion/contracts";
import {
  buildDependencyPlan,
  getDownloadVersion,
  getSkillDependencies,
  resolveDependencyReferences,
  resolvedDependencyIdMap,
  resolvedDependencySlugs,
  type ActorContext,
} from "../src/services";

const ORG = "00000000-0000-0000-0000-0000000000aa";
const actor: ActorContext = { id: "user-1", email: "user@example.test", name: "User One" };
const createdAt = new Date("2026-06-25T10:00:00.000Z");

interface SkillRow {
  id: string;
  slug: string;
  currentVersionId: string;
}

const source: SkillRow = { id: "00000000-0000-0000-0000-000000000001", slug: "web-archiver", currentVersionId: "version-source" };
const renamedTarget: SkillRow = { id: "00000000-0000-0000-0000-000000000002", slug: "log-parser-renamed", currentVersionId: "version-target" };
const reusedOldSlug: SkillRow = { id: "00000000-0000-0000-0000-000000000003", slug: "log-parser", currentVersionId: "version-reused" };
const sharedHelper: SkillRow = { id: "00000000-0000-0000-0000-000000000004", slug: "shared-helper", currentVersionId: "version-helper" };

interface DependencyEdge {
  skillId: string;
  skillVersionId: string;
  dependsOnSlug: string;
  dependsOnSkillId: string | null;
}

const edge: DependencyEdge = {
  skillId: source.id,
  skillVersionId: source.currentVersionId,
  dependsOnSlug: "log-parser",
  dependsOnSkillId: renamedTarget.id,
};

function versionFor(skill: SkillRow, version: string) {
  return {
    id: skill.currentVersionId,
    orgId: ORG,
    skillId: skill.id,
    version,
    note: "",
    frontmatter: "{}",
    body: "",
    tools: [],
    license: null,
    sizeBytes: 123,
    checksum: "sha256:" + "a".repeat(64),
    storagePath: `${ORG}/${skill.slug}/${version}.tar.gz`,
    validation: "valid" as const,
    validationError: null,
    createdBy: actor.id,
    createdAt,
  };
}

function fakeDb(opts: {
  includeRenamedTarget?: boolean;
  edgeOverride?: Partial<DependencyEdge>;
  skills?: SkillRow[];
  dependencyEdges?: DependencyEdge[];
  versionOverrides?: Record<string, string>;
  installedVersions?: Record<string, string | null>;
} = {}) {
  const includeRenamedTarget = opts.includeRenamedTarget ?? true;
  const dependencyEdge: DependencyEdge = { ...edge, ...opts.edgeOverride };
  const dependencyEdges = opts.dependencyEdges ?? [dependencyEdge];
  const skills = opts.skills ?? [source, ...(includeRenamedTarget ? [renamedTarget] : []), reusedOldSlug];
  const installedVersions = new Map(Object.entries(opts.installedVersions ?? {}));
  const versions = skills.map((skill) =>
    versionFor(
      skill,
      opts.versionOverrides?.[skill.id] ?? (skill.id === renamedTarget.id ? "2.0.0" : "1.0.0"),
    ),
  );

  const rowsFor = (table: unknown, cols: Record<string, unknown> | undefined) => {
    if (table === schema.skills && cols && "share_token" in cols) {
      return skills.map((s) => {
        const version = versions.find((v) => v.skillId === s.id)!;
        return {
          id: s.id,
          share_token: `share-${s.slug}`,
          org_id: ORG,
          slug: s.slug,
          description: `${s.slug} description`,
          display_name: null,
          scope: "org",
          validation: "valid",
          validation_error: null,
          creator_id: actor.id,
          creator_name: "User One",
          creator_initials: "UO",
          labels: [],
          current_version: version.version,
          license: null,
          frontmatter: "{}",
          checksum: version.checksum,
          size_bytes: version.sizeBytes,
          tools: [],
          star_count: 0,
          starred: false,
          installed: installedVersions.has(s.id),
          archived_at: null,
          created_at: createdAt,
          updated_at: createdAt,
        };
      });
    }
    if (table === schema.skills && cols && "currentVersionId" in cols) {
      return skills.map((s) => {
        const version = versions.find((v) => v.skillId === s.id)!;
        return {
          id: s.id,
          slug: s.slug,
          scope: "org",
          creatorId: actor.id,
          archivedAt: null,
          currentVersionId: s.currentVersionId,
          currentVersion: version.version,
        };
      });
    }
    if (table === schema.skills && cols && "id" in cols) {
      return skills.map((s) => ({ id: s.id, slug: s.slug }));
    }
    if (table === schema.skillVersions) {
      return versions;
    }
    if (table === schema.skillVersionDependencies) {
      if (cols && "target_id" in cols) {
        return dependencyEdges.map((d) => ({ slug: d.dependsOnSlug, target_id: d.dependsOnSkillId }));
      }
      if (cols && "targetId" in cols) {
        return dependencyEdges.map((d) => ({ slug: d.dependsOnSlug, targetId: d.dependsOnSkillId, skillId: d.skillId }));
      }
      if (cols && "skillVersionId" in cols) {
        return dependencyEdges;
      }
      return dependencyEdges.filter((d) => d.skillId === source.id);
    }
    if (table === schema.skillInstalls) {
      return [...installedVersions.entries()].map(([skill_id, installed_version]) => ({ skill_id, installed_version }));
    }
    return [];
  };

  const select = (cols?: Record<string, unknown>) => {
    let table: unknown;
    const builder: Record<string, unknown> = {
      from(t: unknown) {
        table = t;
        return builder;
      },
      innerJoin() {
        return builder;
      },
      leftJoin() {
        return builder;
      },
      where() {
        return builder;
      },
      groupBy() {
        return builder;
      },
      orderBy() {
        return Promise.resolve(rowsFor(table, cols));
      },
      limit() {
        return Promise.resolve(rowsFor(table, cols));
      },
      then(resolve: (value: unknown) => unknown) {
        return Promise.resolve(rowsFor(table, cols)).then(resolve);
      },
    };
    return builder;
  };

  return {
    query: {
      memberships: { findFirst: async () => ({ orgRole: "developer" }) },
    },
    select,
  } as unknown as Db;
}

describe("skill dependency reads after target rename", () => {
  it("uses depends_on_skill_id to show the target's current slug in Requires and Used by", async () => {
    const database = fakeDb();

    await expect(
      getSkillDependencies({ actor, orgId: ORG, slug: "web-archiver", database }),
    ).resolves.toMatchObject({
      slug: "web-archiver",
      requires: [{ slug: "log-parser-renamed", status: "satisfied", can_open: true }],
    });

    await expect(
      getSkillDependencies({ actor, orgId: ORG, slug: "log-parser-renamed", database }),
    ).resolves.toMatchObject({
      slug: "log-parser-renamed",
      used_by: [{ slug: "web-archiver", status: "satisfied", can_open: true }],
    });

    await expect(
      getDownloadVersion({ actor, orgId: ORG, slug: "web-archiver", database }),
    ).resolves.toMatchObject({
      version: "1.0.0",
      dependencies: ["log-parser-renamed"],
    });
  });

  it("uses the previous dependency target id for archive candidates when the old slug is reused", async () => {
    await expect(
      buildDependencyPlan({ actor, orgId: ORG, slug: "web-archiver", declaredSlugs: [], database: fakeDb() }),
    ).resolves.toMatchObject({
      removed: ["log-parser-renamed"],
      archive_candidates: [{ slug: "log-parser-renamed" }],
    });
  });

  it("does not retarget an id-backed dependency to a reused old slug when the id no longer resolves", async () => {
    const database = fakeDb({ includeRenamedTarget: false });

    await expect(
      getSkillDependencies({ actor, orgId: ORG, slug: "web-archiver", database }),
    ).resolves.toMatchObject({
      slug: "web-archiver",
      requires: [{ slug: "log-parser", status: "missing", can_open: false }],
    });

    await expect(
      getSkillDependencies({ actor, orgId: ORG, slug: "log-parser", database }),
    ).resolves.toMatchObject({
      slug: "log-parser",
      used_by: [],
    });
  });

  it("returns transitive dependencies once with the shortest via parent and install metadata", async () => {
    const database = fakeDb({
      skills: [source, renamedTarget, reusedOldSlug, sharedHelper],
      dependencyEdges: [
        edge,
        {
          skillId: source.id,
          skillVersionId: source.currentVersionId,
          dependsOnSlug: reusedOldSlug.slug,
          dependsOnSkillId: reusedOldSlug.id,
        },
        {
          skillId: renamedTarget.id,
          skillVersionId: renamedTarget.currentVersionId,
          dependsOnSlug: sharedHelper.slug,
          dependsOnSkillId: sharedHelper.id,
        },
        {
          skillId: reusedOldSlug.id,
          skillVersionId: reusedOldSlug.currentVersionId,
          dependsOnSlug: sharedHelper.slug,
          dependsOnSkillId: sharedHelper.id,
        },
      ],
      versionOverrides: {
        [renamedTarget.id]: "2.0.0",
        [sharedHelper.id]: "3.0.0",
      },
      installedVersions: {
        [renamedTarget.id]: "1.0.0",
        [sharedHelper.id]: "2.0.0",
      },
    });

    const result = await getSkillDependencies({ actor, orgId: ORG, slug: "web-archiver", database });

    expect(result.requires).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          slug: "log-parser-renamed",
          version: "2.0.0",
          install_status: "update",
          installed_version: "1.0.0",
          depth: 0,
          via: null,
        }),
        expect.objectContaining({ slug: "log-parser", depth: 0, via: null }),
      ]),
    );
    expect(result.transitive).toEqual([
      expect.objectContaining({
        slug: "shared-helper",
        version: "3.0.0",
        install_status: "update",
        installed_version: "2.0.0",
        depth: 2,
        via: "log-parser-renamed",
      }),
    ]);
    expect(result.transitive_n).toBe(1);
    expect(result.updates_n).toBe(2);
  });

  it("normalizes a renamed dependency by stable id before republish", async () => {
    const dependencies = await resolveDependencyReferences({
      actor,
      orgId: ORG,
      slugs: ["log-parser"],
      manifest: fallbackCompanionManifest({
        summary: "Test manifest.",
        dependencies: { "log-parser": renamedTarget.id },
      }),
      database: fakeDb(),
    });

    expect(dependencies).toEqual([
      { declaredSlug: "log-parser", slug: "log-parser-renamed", skillId: renamedTarget.id },
    ]);
    expect(resolvedDependencySlugs(dependencies)).toEqual(["log-parser-renamed"]);
    expect(resolvedDependencyIdMap(dependencies)).toEqual({ "log-parser-renamed": renamedTarget.id });
  });

  it("detects cycles introduced by publishing a previously missing legacy dependency slug", async () => {
    await expect(
      buildDependencyPlan({
        actor,
        orgId: ORG,
        slug: "missing-helper",
        declaredSlugs: ["web-archiver"],
        database: fakeDb({
          includeRenamedTarget: false,
          edgeOverride: { dependsOnSlug: "missing-helper", dependsOnSkillId: null },
        }),
      }),
    ).resolves.toMatchObject({
      blocked: [{ slug: "web-archiver", status: "cycle" }],
    });
  });
});
