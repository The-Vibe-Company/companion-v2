import { describe, expect, it } from "vitest";
import type { Db } from "@companion/db";
import {
  getGitHubIntegration,
  githubRetryDelayMs,
  resolveGitHubSkillClosure,
  resolveGitHubSyncSkillTitle,
  type GitHubSyncGraphSkill,
} from "../src/githubSync";

const skill = (input: Partial<GitHubSyncGraphSkill> & Pick<GitHubSyncGraphSkill, "id" | "slug">): GitHubSyncGraphSkill => ({
  title: input.slug,
  description: `${input.slug} description`,
  shareToken: `${input.slug}-share-token`,
  version: "1.0.0", checksum: `sha256:${input.id}`, storagePath: `${input.id}.tgz`, archived: false, dependencies: [], ...input,
});

describe("GitHub mirror skill closure", () => {
  it("uses explicit rename overrides, then manifest display names, then the slug", () => {
    const frontmatter = JSON.stringify({
      companion: {
        name: "machine-name",
        version: "1.0.0",
        description: "Description",
        display: { name: "Human title" },
      },
    });
    expect(resolveGitHubSyncSkillTitle({ slug: "machine-name", displayName: "Renamed", frontmatter })).toBe("Renamed");
    expect(resolveGitHubSyncSkillTitle({ slug: "machine-name", displayName: null, frontmatter })).toBe("Human title");
    expect(resolveGitHubSyncSkillTitle({ slug: "machine-name", displayName: null, frontmatter: "invalid" })).toBe("machine-name");
  });

  it("mirrors every active org skill in all mode and temporarily omits archived skills", () => {
    const skills = resolveGitHubSkillClosure({
      mode: "all", selectedSkillIds: [], skills: [
        skill({ id: "a", slug: "zeta" }),
        skill({ id: "b", slug: "alpha" }),
        skill({ id: "c", slug: "archived", archived: true }),
      ],
    });
    expect(skills.map((item) => item.slug)).toEqual(["alpha", "zeta"]);
  });

  it("adds the transitive dependency closure and follows stable ids after a dependency rename", () => {
    const skills = resolveGitHubSkillClosure({
      mode: "selected", selectedSkillIds: ["root"], skills: [
        skill({ id: "root", slug: "root", dependencies: [{ slug: "old-helper-name", skillId: "helper" }] }),
        skill({ id: "helper", slug: "renamed-helper", dependencies: [{ slug: "base", skillId: "base" }] }),
        skill({ id: "base", slug: "base" }),
        skill({ id: "unselected", slug: "unselected" }),
      ],
    });
    expect(skills.map((item) => item.slug)).toEqual(["base", "renamed-helper", "root"]);
  });

  it("omits an archived explicit root without invalidating the last valid mirror", () => {
    expect(resolveGitHubSkillClosure({
      mode: "selected", selectedSkillIds: ["archived"], skills: [skill({ id: "archived", slug: "archived", archived: true })],
    })).toEqual([]);
  });

  it("blocks a new tree when an active root has a missing or archived dependency", () => {
    const root = skill({ id: "root", slug: "root", dependencies: [{ slug: "helper", skillId: "helper" }] });
    expect(() => resolveGitHubSkillClosure({
      mode: "selected", selectedSkillIds: ["root"], skills: [root, skill({ id: "helper", slug: "helper", archived: true })],
    })).toThrow("dependency helper is missing or archived");
  });

  it("does not fall back to a reused slug when an id-backed dependency is archived", () => {
    const root = skill({ id: "root", slug: "root", dependencies: [{ slug: "old-helper", skillId: "original-helper" }] });
    expect(() => resolveGitHubSkillClosure({
      mode: "selected",
      selectedSkillIds: ["root"],
      skills: [
        root,
        skill({ id: "original-helper", slug: "renamed-helper", archived: true }),
        skill({ id: "replacement", slug: "old-helper" }),
      ],
    })).toThrow("dependency old-helper is missing or archived");
  });
});

describe("GitHub integration governance", () => {
  const actor = { id: "user-1", email: "user@example.test", name: "User" };
  const orgId = "00000000-0000-4000-8000-000000000001";

  function databaseForRole(role: "owner" | "admin" | "developer" | null): Db {
    const select = () => {
      const builder = {
        from: () => builder,
        where: () => builder,
        orderBy: async () => [],
        then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve([]).then(resolve),
      };
      return builder;
    };
    return {
      query: {
        memberships: { findFirst: async () => role ? { orgRole: role } : null },
        githubConnections: { findFirst: async () => null },
      },
      select,
    } as unknown as Db;
  }

  it.each([
    ["owner", true],
    ["admin", true],
    ["developer", false],
    [null, false],
  ] as const)("role=%s -> allowed=%s", async (role, allowed) => {
    const request = getGitHubIntegration({
      actor,
      orgId,
      configured: true,
      appSlug: "companion",
      appName: "Companion",
      managed: true,
      database: databaseForRole(role),
    });
    if (allowed) await expect(request).resolves.toMatchObject({ connection: { connected: false }, destinations: [] });
    else await expect(request).rejects.toThrow("not allowed to manage GitHub synchronization");
  });

  it("denies a cross-tenant actor whose membership lookup returns no row", async () => {
    await expect(getGitHubIntegration({
      actor: { ...actor, id: "other-org-user" },
      orgId,
      configured: true,
      appSlug: "companion",
      appName: "Companion",
      managed: true,
      database: databaseForRole(null),
    })).rejects.toThrow("not allowed to manage GitHub synchronization");
  });
});

describe("GitHub retry schedule", () => {
  it("backs off exponentially and caps retries at fifteen minutes", () => {
    expect([1, 2, 3, 4].map(githubRetryDelayMs)).toEqual([15_000, 30_000, 60_000, 120_000]);
    expect(githubRetryDelayMs(7)).toBe(15 * 60_000);
    expect(githubRetryDelayMs(20)).toBe(15 * 60_000);
  });
});
