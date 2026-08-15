import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CompanionRuntimeForbiddenError,
  expireCompanionToolRuns,
  listPendingCompanionMessages,
  recordCompanionPiProjectionWithEffects,
  sendCompanionMessage,
} from "@companion/core";
import { withTenantContext } from "@companion/db";
import { integrationSql, type TestActor } from "./testDatabase";

/**
 * Product promise:
 * A tool result closes only the running chip it won. Once the timeout path wins, a late Pi result
 * cannot reopen or reclassify that chip.
 *
 * Why this test is integrated:
 * The guarantee is a PostgreSQL compare-and-set over JSONB. A mocked query builder cannot prove
 * the losing writer changed zero rows.
 */
describe("Companion tool-run settlement", () => {
  const suffix = randomUUID();
  const owner: TestActor = {
    id: `tool-run-owner-${suffix}`,
    email: `tool-run-owner-${suffix}@example.test`,
    name: "Tool Run Owner",
  };
  const viewer: TestActor = {
    id: `tool-run-viewer-${suffix}`,
    email: `tool-run-viewer-${suffix}@example.test`,
    name: "Tool Run Viewer",
  };
  const org = randomUUID();
  const companionId = randomUUID();
  const createdAt = new Date("2026-08-15T12:00:00.000Z");

  const asOwner = <T>(
    fn: (database: Parameters<Parameters<typeof withTenantContext>[1]>[0]) => Promise<T>,
  ) => withTenantContext({ orgId: org, userId: owner.id }, fn);
  const asViewer = <T>(
    fn: (database: Parameters<Parameters<typeof withTenantContext>[1]>[0]) => Promise<T>,
  ) => withTenantContext({ orgId: org, userId: viewer.id }, fn);

  beforeAll(async () => {
    await integrationSql`
      insert into "user" (id, name, email, email_verified)
      values
        (${owner.id}, ${owner.name}, ${owner.email}, true),
        (${viewer.id}, ${viewer.name}, ${viewer.email}, true)
    `;
    await integrationSql`
      insert into profiles (id, name, email, initials, onboarded_at)
      values
        (${owner.id}, ${owner.name}, ${owner.email}, 'TR', now()),
        (${viewer.id}, ${viewer.name}, ${viewer.email}, 'TV', now())
    `;
    await integrationSql`
      insert into organizations (id, name, slug, kind)
      values (${org}, 'Tool run org', ${`tool-run-org-${suffix}`}, 'team')
    `;
    await integrationSql`
      insert into memberships (org_id, user_id, org_role) values
        (${org}, ${owner.id}, 'owner'),
        (${org}, ${viewer.id}, 'developer')
    `;
    await integrationSql`
      insert into companions (id, org_id, owner_id, name)
      values (${companionId}, ${org}, ${owner.id}, 'Tool Run Companion')
    `;
    await integrationSql`
      insert into companion_workspace_access (org_id, companion_id, owner_id, role, granted_by)
      values (${org}, ${companionId}, ${owner.id}, 'viewer', ${owner.id})
    `;
  });

  afterAll(async () => {
    await integrationSql`delete from companions where org_id = ${org}`;
    await integrationSql`delete from organizations where id = ${org}`;
    await integrationSql`delete from "user" where id in (${owner.id}, ${viewer.id})`;
  });

  it("keeps a timeout terminal when a late Pi result loses the completion race", async () => {
    const eventId = "pi:tool-timeout";
    await asOwner((database) => recordCompanionPiProjectionWithEffects({
      actor: owner,
      orgId: org,
      companionId,
      entries: [{
        eventId,
        role: "tool",
        content: "/tmp/conductor-cli.png",
        tool: {
          call_id: "call-timeout",
          kind: "file",
          name: "read",
          title: "/tmp/conductor-cli.png",
          status: "running",
          detail: null,
          screenshot: null,
        },
        createdAt,
      }],
      database,
    }));

    // A Viewer can close the durable deadline through the read-only thread path without receiving
    // runtime mutation authority.
    const expired = await asViewer((database) => expireCompanionToolRuns({
      actor: viewer,
      orgId: org,
      companionId,
      now: new Date(createdAt.getTime() + 90_001),
      database,
    }));
    expect(expired.timedOut).toEqual([{ eventId, kind: "file" }]);

    const late = await asOwner((database) => recordCompanionPiProjectionWithEffects({
      actor: owner,
      orgId: org,
      companionId,
      entries: [],
      toolCompletions: [{
        callId: "call-timeout",
        status: "ok",
        result: "image bytes",
        completedAt: new Date(createdAt.getTime() + 90_002),
      }],
      database,
    }));
    expect(late.settledToolRuns).toEqual([]);
    expect(late.thread.entries.find((entry) => entry.event_id === eventId)?.tool?.status)
      .toBe("timeout");

    await expect(asViewer((database) => sendCompanionMessage({
      actor: viewer,
      orgId: org,
      companionId,
      content: "Viewer must stay read-only",
      database,
    }))).rejects.toBeInstanceOf(CompanionRuntimeForbiddenError);

  });

  it("re-queues user messages watermarked after a timed-out tool so Pi can answer them", async () => {
    const turn = await asOwner((database) => sendCompanionMessage({
      actor: owner,
      orgId: org,
      companionId,
      content: "Read the screenshot",
      database,
    }));
    await asOwner((database) => recordCompanionPiProjectionWithEffects({
      actor: owner,
      orgId: org,
      companionId,
      entries: [],
      deliveredOrdinal: turn.entry.ordinal,
      database,
    }));

    const eventId = "pi:tool-stranded-tail";
    const toolCreatedAt = new Date("2026-08-15T13:00:00.000Z");
    await asOwner((database) => recordCompanionPiProjectionWithEffects({
      actor: owner,
      orgId: org,
      companionId,
      entries: [{
        eventId,
        role: "tool",
        content: "/tmp/conductor-cli.png",
        tool: {
          call_id: "call-stranded-tail",
          kind: "file",
          name: "read",
          title: "/tmp/conductor-cli.png",
          status: "running",
          detail: null,
          screenshot: null,
        },
        createdAt: toolCreatedAt,
      }],
      database,
    }));
    const alors = await asOwner((database) => sendCompanionMessage({
      actor: owner,
      orgId: org,
      companionId,
      content: "Alors ?",
      database,
    }));
    const caVa = await asOwner((database) => sendCompanionMessage({
      actor: owner,
      orgId: org,
      companionId,
      content: "Ca va ?",
      database,
    }));
    await asOwner((database) => recordCompanionPiProjectionWithEffects({
      actor: owner,
      orgId: org,
      companionId,
      entries: [],
      deliveredOrdinal: caVa.entry.ordinal,
      database,
    }));

    const expired = await asViewer((database) => expireCompanionToolRuns({
      actor: viewer,
      orgId: org,
      companionId,
      now: new Date(toolCreatedAt.getTime() + 90_001),
      database,
    }));
    const pending = await asOwner((database) => listPendingCompanionMessages({
      actor: owner,
      orgId: org,
      companionId,
      database,
    }));

    expect(expired.timedOut).toEqual([{ eventId, kind: "file" }]);
    expect(expired.thread.entries.find((entry) => entry.event_id === eventId)?.tool?.status)
      .toBe("timeout");
    expect(pending.deliveredOrdinal).toBe(turn.entry.ordinal);
    expect(pending.pending).toEqual([alors.entry, caVa.entry]);
  });

  it("recovers an already-settled timeout tail once for #305-era threads", async () => {
    const turn = await asOwner((database) => sendCompanionMessage({
      actor: owner,
      orgId: org,
      companionId,
      content: "Try another image",
      database,
    }));
    await asOwner((database) => recordCompanionPiProjectionWithEffects({
      actor: owner,
      orgId: org,
      companionId,
      entries: [],
      deliveredOrdinal: turn.entry.ordinal,
      database,
    }));
    const eventId = "pi:tool-already-timed-out";
    await asOwner((database) => recordCompanionPiProjectionWithEffects({
      actor: owner,
      orgId: org,
      companionId,
      entries: [{
        eventId,
        role: "tool",
        content: "/tmp/conductor-cli.png",
        tool: {
          call_id: "call-already-timed-out",
          kind: "file",
          name: "read",
          title: "/tmp/conductor-cli.png",
          status: "timeout",
          detail: "Timed out after 90 seconds without a tool result.",
          screenshot: null,
        },
        createdAt: new Date("2026-08-15T14:00:00.000Z"),
      }],
      database,
    }));
    const alors = await asOwner((database) => sendCompanionMessage({
      actor: owner,
      orgId: org,
      companionId,
      content: "Alors ?",
      database,
    }));
    const caVa = await asOwner((database) => sendCompanionMessage({
      actor: owner,
      orgId: org,
      companionId,
      content: "Ca va ?",
      database,
    }));
    await asOwner((database) => recordCompanionPiProjectionWithEffects({
      actor: owner,
      orgId: org,
      companionId,
      entries: [],
      deliveredOrdinal: caVa.entry.ordinal,
      database,
    }));

    const recovered = await asViewer((database) => expireCompanionToolRuns({
      actor: viewer,
      orgId: org,
      companionId,
      database,
    }));
    const pending = await asOwner((database) => listPendingCompanionMessages({
      actor: owner,
      orgId: org,
      companionId,
      database,
    }));
    expect(recovered.timedOut).toEqual([]);
    expect(pending.deliveredOrdinal).toBe(turn.entry.ordinal);
    expect(pending.pending).toEqual([alors.entry, caVa.entry]);

    // Once Pi accepts the recovered tail, a later read/sync must not move the watermark back again.
    await asOwner((database) => recordCompanionPiProjectionWithEffects({
      actor: owner,
      orgId: org,
      companionId,
      entries: [],
      deliveredOrdinal: caVa.entry.ordinal,
      database,
    }));
    await asViewer((database) => expireCompanionToolRuns({
      actor: viewer,
      orgId: org,
      companionId,
      database,
    }));
    const afterRetry = await asOwner((database) => listPendingCompanionMessages({
      actor: owner,
      orgId: org,
      companionId,
      database,
    }));
    expect(afterRetry.deliveredOrdinal).toBe(caVa.entry.ordinal);
    expect(afterRetry.pending).toEqual([]);
  });
});
