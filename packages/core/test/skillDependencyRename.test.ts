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

function fakeDb(opts: { includeRenamedTarget?: boolean; edgeOverride?: Partial<DependencyEdge> } = {}) {
  const includeRenamedTarget = opts.includeRenamedTarget ?? true;
  const dependencyEdge: DependencyEdge = { ...edge, ...opts.edgeOverride };
  const skills = [source, ...(includeRenamedTarget ? [renamedTarget] : []), reusedOldSlug];
  const versions = [versionFor(source, "1.0.0"), versionFor(renamedTarget, "2.0.0"), versionFor(reusedOldSlug, "1.0.0")];

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
          installed: false,
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
        return [{ slug: dependencyEdge.dependsOnSlug, target_id: dependencyEdge.dependsOnSkillId }];
      }
      if (cols && "targetId" in cols) {
        return [{ slug: dependencyEdge.dependsOnSlug, targetId: dependencyEdge.dependsOnSkillId, skillId: dependencyEdge.skillId }];
      }
      return [dependencyEdge];
    }
    if (table === schema.skillInstalls) {
      return [];
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
