import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { schema, withTenantContext, type Db } from "@companion/db";
import { listProjects } from "@companion/core/services";
import {
  createIntegrationFixture,
  integrationDb,
  seedSkill,
  type IntegrationFixture,
} from "./testDatabase";

/**
 * Product promise:
 * The Projects switcher remains a faithful, fast projection as a member creates more Projects.
 * Counts cover the complete durable library while each Project embeds only its canonical five most
 * recent active conversations.
 *
 * Regression caught:
 * The former projection issued seven database statements per Project. It also made it easy for a
 * batch rewrite to count archived/deleted rows, leak another creator's Project, or lose the
 * created_at/id tie-breaker while selecting recent conversations.
 *
 * Why this test is integrated:
 * The behavior depends on Postgres filtered aggregates, a partitioned window and real creator/org
 * scoping. A conservative select-builder counter proves the query construction is constant for one
 * or many returned Projects without coupling the assertion to driver-private hooks.
 *
 * Failure proof:
 * Restoring the per-Project projectCounts/recent-session loop exceeds the seven-builder bound.
 * Removing any aggregate filter or the window rank changes the exact counts/recent IDs below.
 */
describe("Project list projection", () => {
  let fixture: IntegrationFixture;
  const projectA = randomUUID();
  const projectB = randomUUID();
  const archivedProject = randomUUID();
  const sameOrgOtherCreatorProject = randomUUID();
  const otherOrgProject = randomUUID();
  let tiedRecentIds: string[] = [];
  let olderIds: string[] = [];

  beforeAll(async () => {
    fixture = await createIntegrationFixture();
    const skills = await Promise.all(
      ["one", "two", "three"].map((name) =>
        seedSkill({
          orgId: fixture.orgA,
          creator: fixture.owner,
          slug: `project-list-${name}-${fixture.suffix}`,
          scope: "org",
        })
      ),
    );

    await integrationDb.insert(schema.projects).values([
      {
        id: projectA,
        orgId: fixture.orgA,
        creatorId: fixture.owner.id,
        name: "Project A",
        defaultModel: "openai/gpt-5",
        idempotencyKey: `project-list-${projectA}`,
        payloadHash: "a".repeat(64),
      },
      {
        id: projectB,
        orgId: fixture.orgA,
        creatorId: fixture.owner.id,
        name: "Project B",
        defaultModel: "anthropic/claude-sonnet-4",
        idempotencyKey: `project-list-${projectB}`,
        payloadHash: "b".repeat(64),
      },
      {
        id: archivedProject,
        orgId: fixture.orgA,
        creatorId: fixture.owner.id,
        name: "Archived Project",
        defaultModel: "openai/gpt-5",
        idempotencyKey: `project-list-${archivedProject}`,
        payloadHash: "c".repeat(64),
        archivedAt: new Date("2026-01-15T00:00:00.000Z"),
      },
      {
        id: sameOrgOtherCreatorProject,
        orgId: fixture.orgA,
        creatorId: fixture.admin.id,
        name: "Admin Project",
        defaultModel: "openai/gpt-5",
        idempotencyKey: `project-list-${sameOrgOtherCreatorProject}`,
        payloadHash: "d".repeat(64),
      },
      {
        id: otherOrgProject,
        orgId: fixture.orgB,
        creatorId: fixture.outsider.id,
        name: "Other tenant Project",
        defaultModel: "openai/gpt-5",
        idempotencyKey: `project-list-${otherOrgProject}`,
        payloadHash: "e".repeat(64),
      },
    ]);
    await integrationDb.insert(schema.projectWorkspaces).values([
      {
        orgId: fixture.orgA,
        projectId: projectA,
        creatorId: fixture.owner.id,
        sandboxName: `project-${projectA}`,
        lastActivityAt: new Date("2026-01-10T00:00:00.000Z"),
      },
      {
        orgId: fixture.orgA,
        projectId: projectB,
        creatorId: fixture.owner.id,
        sandboxName: `project-${projectB}`,
        lastActivityAt: new Date("2026-01-11T00:00:00.000Z"),
      },
      {
        orgId: fixture.orgA,
        projectId: archivedProject,
        creatorId: fixture.owner.id,
        sandboxName: `project-${archivedProject}`,
        lastActivityAt: new Date("2026-01-12T00:00:00.000Z"),
      },
      {
        orgId: fixture.orgA,
        projectId: sameOrgOtherCreatorProject,
        creatorId: fixture.admin.id,
        sandboxName: `project-${sameOrgOtherCreatorProject}`,
      },
      {
        orgId: fixture.orgB,
        projectId: otherOrgProject,
        creatorId: fixture.outsider.id,
        sandboxName: `project-${otherOrgProject}`,
      },
    ]);
    await integrationDb.insert(schema.projectSkills).values([
      {
        orgId: fixture.orgA,
        projectId: projectA,
        creatorId: fixture.owner.id,
        skillId: skills[0]!.id,
        desiredVersionId: skills[0]!.versionId,
      },
      {
        orgId: fixture.orgA,
        projectId: projectA,
        creatorId: fixture.owner.id,
        skillId: skills[1]!.id,
        desiredVersionId: skills[1]!.versionId,
      },
      {
        orgId: fixture.orgA,
        projectId: projectB,
        creatorId: fixture.owner.id,
        skillId: skills[2]!.id,
        desiredVersionId: skills[2]!.versionId,
      },
    ]);

    tiedRecentIds = [randomUUID(), randomUUID()];
    olderIds = Array.from({ length: 7 }, () => randomUUID());
    const viewedBefore = new Date("2026-01-01T00:00:00.000Z");
    const viewedAfter = new Date("2026-01-20T00:00:00.000Z");
    const updated = new Date("2026-01-10T00:00:00.000Z");
    await integrationDb.insert(schema.projectSessions).values([
      {
        id: tiedRecentIds[0],
        orgId: fixture.orgA,
        projectId: projectA,
        creatorId: fixture.owner.id,
        title: "Newest tied A",
        model: "openai/gpt-5",
        modelProvider: "openai",
        status: "stopped",
        createdAt: new Date("2026-01-07T00:00:00.000Z"),
        updatedAt: updated,
        lastViewedAt: updated,
      },
      {
        id: tiedRecentIds[1],
        orgId: fixture.orgA,
        projectId: projectA,
        creatorId: fixture.owner.id,
        title: "Newest tied B",
        model: "openai/gpt-5",
        modelProvider: "openai",
        status: "idle",
        createdAt: new Date("2026-01-07T00:00:00.000Z"),
        updatedAt: updated,
        lastViewedAt: viewedAfter,
      },
      {
        id: olderIds[0],
        orgId: fixture.orgA,
        projectId: projectA,
        creatorId: fixture.owner.id,
        title: "Completed unread",
        model: "openai/gpt-5",
        modelProvider: "openai",
        status: "completed",
        createdAt: new Date("2026-01-06T00:00:00.000Z"),
        updatedAt: updated,
        lastViewedAt: viewedBefore,
      },
      {
        id: olderIds[1],
        orgId: fixture.orgA,
        projectId: projectA,
        creatorId: fixture.owner.id,
        title: "Error unread",
        model: "openai/gpt-5",
        modelProvider: "openai",
        status: "error",
        createdAt: new Date("2026-01-05T00:00:00.000Z"),
        updatedAt: updated,
        lastViewedAt: viewedBefore,
      },
      {
        id: olderIds[2],
        orgId: fixture.orgA,
        projectId: projectA,
        creatorId: fixture.owner.id,
        title: "Queued",
        model: "openai/gpt-5",
        modelProvider: "openai",
        status: "queued",
        createdAt: new Date("2026-01-04T00:00:00.000Z"),
      },
      {
        id: olderIds[3],
        orgId: fixture.orgA,
        projectId: projectA,
        creatorId: fixture.owner.id,
        title: "Working",
        model: "openai/gpt-5",
        modelProvider: "openai",
        status: "working",
        createdAt: new Date("2026-01-03T00:00:00.000Z"),
      },
      {
        id: olderIds[4],
        orgId: fixture.orgA,
        projectId: projectA,
        creatorId: fixture.owner.id,
        title: "Stopping",
        model: "openai/gpt-5",
        modelProvider: "openai",
        status: "stopping",
        createdAt: new Date("2026-01-02T00:00:00.000Z"),
      },
      {
        id: olderIds[5],
        orgId: fixture.orgA,
        projectId: projectA,
        creatorId: fixture.owner.id,
        title: "Archived one",
        model: "openai/gpt-5",
        modelProvider: "openai",
        status: "completed",
        archivedAt: new Date("2026-01-12T00:00:00.000Z"),
        createdAt: new Date("2026-01-09T00:00:00.000Z"),
      },
      {
        id: olderIds[6],
        orgId: fixture.orgA,
        projectId: projectA,
        creatorId: fixture.owner.id,
        title: "Archived two",
        model: "openai/gpt-5",
        modelProvider: "openai",
        status: "error",
        archivedAt: new Date("2026-01-13T00:00:00.000Z"),
        createdAt: new Date("2026-01-08T00:00:00.000Z"),
      },
      {
        id: randomUUID(),
        orgId: fixture.orgA,
        projectId: projectB,
        creatorId: fixture.owner.id,
        title: "Project B result",
        model: "anthropic/claude-sonnet-4",
        modelProvider: "anthropic",
        status: "completed",
        updatedAt: updated,
        lastViewedAt: viewedBefore,
      },
      {
        id: randomUUID(),
        orgId: fixture.orgA,
        projectId: archivedProject,
        creatorId: fixture.owner.id,
        title: "Still working while archived",
        model: "openai/gpt-5",
        modelProvider: "openai",
        status: "working",
      },
    ]);

    await integrationDb.insert(schema.projectFiles).values([
      {
        orgId: fixture.orgA,
        projectId: projectA,
        creatorId: fixture.owner.id,
        path: "files/a.txt",
        contentType: "text/plain",
        byteSize: 1,
        checksum: "1".repeat(64),
        storageKey: `projects/${projectA}/a.txt`,
      },
      {
        orgId: fixture.orgA,
        projectId: projectA,
        creatorId: fixture.owner.id,
        path: "files/b.txt",
        contentType: "text/plain",
        byteSize: 1,
        checksum: "2".repeat(64),
        storageKey: `projects/${projectA}/b.txt`,
      },
      {
        orgId: fixture.orgA,
        projectId: projectA,
        creatorId: fixture.owner.id,
        path: "files/deleted.txt",
        contentType: "text/plain",
        byteSize: 1,
        checksum: "3".repeat(64),
        storageKey: `projects/${projectA}/deleted.txt`,
        deletedAt: new Date("2026-01-14T00:00:00.000Z"),
      },
      {
        orgId: fixture.orgA,
        projectId: projectB,
        creatorId: fixture.owner.id,
        path: "files/result.md",
        contentType: "text/markdown",
        byteSize: 1,
        checksum: "4".repeat(64),
        storageKey: `projects/${projectB}/result.md`,
      },
    ]);

  });

  afterAll(async () => {
    await fixture.cleanup();
  });

  it("returns exact creator-scoped counts and five recent conversations with constant query construction", async () => {
    const countSelectBuilders = (database: Db) => {
      let count = 0;
      const instrumented = new Proxy(database, {
        get(target, property) {
          const value = Reflect.get(target, property, target);
          if (property !== "select" || typeof value !== "function") return value;
          return (...args: unknown[]) => {
            count += 1;
            return Reflect.apply(value, target, args);
          };
        },
      }) as Db;
      return { database: instrumented, count: () => count };
    };

    const activeResult = await withTenantContext(
      { orgId: fixture.orgA, userId: fixture.owner.id },
      async (database) => {
        const counted = countSelectBuilders(database);
        const projects = await listProjects({
          actor: fixture.owner,
          orgId: fixture.orgA,
          view: "active",
          database: counted.database,
        });
        return { projects, selectBuilders: counted.count() };
      },
    );
    const archivedResult = await withTenantContext(
      { orgId: fixture.orgA, userId: fixture.owner.id },
      async (database) => {
        const counted = countSelectBuilders(database);
        const projects = await listProjects({
          actor: fixture.owner,
          orgId: fixture.orgA,
          view: "archived",
          database: counted.database,
        });
        return { projects, selectBuilders: counted.count() };
      },
    );

    expect(activeResult.selectBuilders).toBeLessThanOrEqual(7);
    expect(archivedResult.selectBuilders).toBe(activeResult.selectBuilders);
    expect(activeResult.projects.map((project) => project.id)).toEqual([projectB, projectA]);
    expect(activeResult.projects.map((project) => project.id)).not.toContain(
      sameOrgOtherCreatorProject,
    );
    expect(activeResult.projects.map((project) => project.id)).not.toContain(otherOrgProject);

    const firstTied = [...tiedRecentIds].sort((left, right) =>
      left < right ? 1 : left > right ? -1 : 0
    );
    expect(activeResult.projects[1]).toMatchObject({
      id: projectA,
      skill_count: 2,
      session_count: 7,
      active_session_count: 3,
      archived_session_count: 2,
      unread_session_count: 2,
      file_count: 2,
    });
    expect(
      activeResult.projects[1]!.recent_sessions.map((session) => session.id),
    ).toEqual([
      ...firstTied,
      olderIds[0],
      olderIds[1],
      olderIds[2],
    ]);
    expect(activeResult.projects[0]).toMatchObject({
      id: projectB,
      skill_count: 1,
      session_count: 1,
      active_session_count: 0,
      archived_session_count: 0,
      unread_session_count: 1,
      file_count: 1,
    });
    expect(archivedResult.projects).toHaveLength(1);
    expect(archivedResult.projects[0]).toMatchObject({
      id: archivedProject,
      session_count: 1,
      active_session_count: 1,
      archived_session_count: 0,
      unread_session_count: 0,
    });
  });
});
