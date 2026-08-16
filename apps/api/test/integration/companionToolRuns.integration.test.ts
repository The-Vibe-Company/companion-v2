import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deliverCompanionMessages, type CompanionBoxRuntime } from "@companion/box-runtime";
import {
  CompanionRuntimeForbiddenError,
  claimCompanionDelivery,
  expireCompanionToolRuns,
  listPendingCompanionMessages,
  recordCompanionTimeoutRestart,
  releaseCompanionDelivery,
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

  /**
   * Rows take the database clock at projection time — Pi's own timestamps are untrusted since the
   * deadline is measured in PostgreSQL. Aging a chip therefore means backdating the stored row,
   * exactly what a real stall looks like to the settlement function.
   */
  const backdateToolRun = async (eventId: string, seconds: number) => {
    await integrationSql`
      update companion_transcript_entries
      set created_at = now() - make_interval(secs => ${seconds})
      where org_id = ${org} and companion_id = ${companionId} and event_id = ${eventId}
    `;
  };

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
    await backdateToolRun(eventId, 91);

    // A Viewer can close the durable deadline through the read-only thread path without receiving
    // runtime mutation authority.
    const expired = await asViewer((database) => expireCompanionToolRuns({
      actor: viewer,
      orgId: org,
      companionId,
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
        createdAt: new Date("2026-08-15T13:00:00.000Z"),
      }],
      database,
    }));
    await backdateToolRun(eventId, 91);
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
    expect(pending.timeoutRecoveryPending).toBe(true);
    expect(pending.timeoutRestartPending).toBe(true);
  });

  it("gives shell runs the longer execution deadline and names it in the detail", async () => {
    const eventId = "pi:tool-shell-run";
    await asOwner((database) => recordCompanionPiProjectionWithEffects({
      actor: owner,
      orgId: org,
      companionId,
      entries: [{
        eventId,
        role: "tool",
        content: "pnpm test",
        tool: {
          call_id: "call-shell-run",
          kind: "shell",
          name: "bash",
          title: "pnpm test",
          status: "running",
          detail: null,
          screenshot: null,
        },
        createdAt,
      }],
      database,
    }));

    // Past the default deadline but inside the shell one: a build must keep running.
    await backdateToolRun(eventId, 91);
    const early = await asOwner((database) => expireCompanionToolRuns({
      actor: owner,
      orgId: org,
      companionId,
      database,
    }));
    expect(early.timedOut).toEqual([]);
    expect(early.thread.entries.find((entry) => entry.event_id === eventId)?.tool?.status)
      .toBe("running");

    await backdateToolRun(eventId, 601);
    const late = await asOwner((database) => expireCompanionToolRuns({
      actor: owner,
      orgId: org,
      companionId,
      database,
    }));
    expect(late.timedOut).toEqual([{ eventId, kind: "shell" }]);
    expect(late.thread.entries.find((entry) => entry.event_id === eventId)?.tool?.detail)
      .toBe("Timed out after 600 seconds without a tool result.");
  });

  it("rewinds only the tail when no user message precedes the timed-out tool", async () => {
    // A dedicated companion: the guarantee is about the very first entries of a thread.
    const firstTurnCompanion = randomUUID();
    await integrationSql`
      insert into companions (id, org_id, owner_id, name)
      values (${firstTurnCompanion}, ${org}, ${owner.id}, 'First Turn Companion')
    `;
    const eventId = "pi:tool-first-entry";
    await asOwner((database) => recordCompanionPiProjectionWithEffects({
      actor: owner,
      orgId: org,
      companionId: firstTurnCompanion,
      entries: [{
        eventId,
        role: "tool",
        content: "/tmp/conductor-cli.png",
        tool: {
          call_id: "call-first-entry",
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
    const alors = await asOwner((database) => sendCompanionMessage({
      actor: owner,
      orgId: org,
      companionId: firstTurnCompanion,
      content: "Alors ?",
      database,
    }));
    await asOwner((database) => recordCompanionPiProjectionWithEffects({
      actor: owner,
      orgId: org,
      companionId: firstTurnCompanion,
      entries: [],
      deliveredOrdinal: alors.entry.ordinal,
      database,
    }));
    await integrationSql`
      update companion_transcript_entries
      set created_at = now() - make_interval(secs => 91)
      where org_id = ${org} and companion_id = ${firstTurnCompanion} and event_id = ${eventId}
    `;

    const expired = await asOwner((database) => expireCompanionToolRuns({
      actor: owner,
      orgId: org,
      companionId: firstTurnCompanion,
      database,
    }));
    const pending = await asOwner((database) => listPendingCompanionMessages({
      actor: owner,
      orgId: org,
      companionId: firstTurnCompanion,
      database,
    }));

    expect(expired.timedOut).toEqual([{ eventId, kind: "file" }]);
    // The watermark lands on the tool's own ordinal, so exactly the unanswered tail after it is
    // re-queued. A NULL watermark here would have marked the whole thread undelivered.
    expect(pending.deliveredOrdinal).not.toBeNull();
    expect(pending.pending).toEqual([alors.entry]);
  });

  it("recovers and delivers an already-settled timeout tail once for #305-era threads", async () => {
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
    expect(pending.timeoutRecoveryPending).toBe(true);
    expect(pending.timeoutRestartPending).toBe(true);

    // #307 could watermark the recovered tail without proving the blocked Pi process had released.
    // A later new send must still request the one Pi-only recycle THE-369 adds.
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
    expect(afterRetry.pending).toEqual([alors.entry, caVa.entry]);
    expect(afterRetry.timeoutRecoveryPending).toBe(true);
    expect(afterRetry.timeoutRestartPending).toBe(true);

    // A new send after the old writer's watermark is still after the unanswered timeout. Recycle Pi
    // and retain the whole tail; a zero pending count did not prove the dead turn released it.
    const ping = await asOwner((database) => sendCompanionMessage({
      actor: owner,
      orgId: org,
      companionId,
      content: "ping THE-369",
      database,
    }));
    const afterNewSend = await asOwner((database) => listPendingCompanionMessages({
      actor: owner,
      orgId: org,
      companionId,
      database,
    }));
    expect(afterNewSend.pending).toEqual([alors.entry, caVa.entry, ping.entry]);
    expect(afterNewSend.timeoutRecoveryPending).toBe(true);
    expect(afterNewSend.timeoutRestartPending).toBe(true);

    const timeoutOrdinal = recovered.thread.entries
      .find((entry) => entry.event_id === eventId)?.ordinal;
    expect(timeoutOrdinal).toBeTypeOf("number");
    await asOwner((database) => recordCompanionTimeoutRestart({
      actor: owner,
      orgId: org,
      companionId,
      timeoutOrdinal: timeoutOrdinal!,
      database,
    }));
    const afterRestart = await asOwner((database) => listPendingCompanionMessages({
      actor: owner,
      orgId: org,
      companionId,
      database,
    }));
    expect(afterRestart.pending).toEqual([alors.entry, caVa.entry, ping.entry]);
    expect(afterRestart.timeoutRecoveryPending).toBe(true);
    expect(afterRestart.timeoutRestartPending).toBe(false);

    await asOwner((database) => recordCompanionPiProjectionWithEffects({
      actor: owner,
      orgId: org,
      companionId,
      entries: [],
      deliveredOrdinal: ping.entry.ordinal,
      timeoutDeliveryOrdinal: ping.entry.ordinal,
      database,
    }));
    const afterDelivery = await asOwner((database) => listPendingCompanionMessages({
      actor: owner,
      orgId: org,
      companionId,
      database,
    }));
    expect(afterDelivery.pending).toEqual([]);
    expect(afterDelivery.timeoutRecoveryPending).toBe(false);
    expect(afterDelivery.timeoutRestartPending).toBe(false);

    // THE-370 production state had both markers advanced by a FIFO write Pi never consumed. A
    // later send must still become pending even though the old timeout is no longer eligible for
    // its one-shot restart; delivery will use RPC acceptance and heal the live daemon if required.
    const ping370 = await asOwner((database) => sendCompanionMessage({
      actor: owner,
      orgId: org,
      companionId,
      content: "ping THE-370",
      database,
    }));
    const afterWatermarkedTail = await asOwner((database) => listPendingCompanionMessages({
      actor: owner,
      orgId: org,
      companionId,
      database,
    }));
    expect(afterWatermarkedTail.pending).toEqual([ping370.entry]);
    expect(afterWatermarkedTail.timeoutRecoveryPending).toBe(true);
    expect(afterWatermarkedTail.timeoutRestartPending).toBe(false);

    // Run the actual shared delivery boundary over that PostgreSQL state. The controllable runtime
    // represents the live Box seam: timeout recovery must demand idle Pi health even though the
    // one-shot restart marker is already set, and only an accepted prompt may move the watermark.
    const deliveryOrder: string[] = [];
    const runtime = {
      healPiDaemon: async (input: { requireIdle?: boolean }) => {
        deliveryOrder.push(input.requireIdle ? "heal-idle" : "heal");
        return { daemonState: "running" as const, detail: null };
      },
      prompt: async (input: { requestId: string }) => {
        deliveryOrder.push(`prompt:${input.requestId}`);
      },
      refreshTtl: async () => undefined,
    } as unknown as CompanionBoxRuntime;
    await expect(asViewer((database) => claimCompanionDelivery({
      actor: viewer,
      orgId: org,
      companionId,
      claimId: randomUUID(),
      database,
    }))).rejects.toBeInstanceOf(CompanionRuntimeForbiddenError);
    const blocker = randomUUID();
    await expect(asOwner((database) => claimCompanionDelivery({
      actor: owner,
      orgId: org,
      companionId,
      claimId: blocker,
      database,
    }))).resolves.toBe(true);
    const overlapped = await deliverCompanionMessages({
      actor: owner,
      orgId: org,
      env: {},
      runtimeFactory: () => runtime,
    }, {
      companionId,
      boxId: "box-the-370",
      runtime,
    });
    expect(overlapped).toBeNull();
    expect(deliveryOrder).toEqual([]);
    await expect(asOwner((database) => releaseCompanionDelivery({
      actor: owner,
      orgId: org,
      companionId,
      claimId: blocker,
      database,
    }))).resolves.toBe(true);

    const delivered = await deliverCompanionMessages({
      actor: owner,
      orgId: org,
      env: {},
      runtimeFactory: () => runtime,
    }, {
      companionId,
      boxId: "box-the-370",
      runtime,
    });
    expect(deliveryOrder).toEqual(["heal-idle", `prompt:${ping370.entry.event_id}`]);
    expect(delivered?.deliveredOrdinal).toBe(ping370.entry.ordinal);
    expect(delivered?.thread.accepted_delivery_ordinal).toBe(ping370.entry.ordinal);

    const afterAcceptedPrompt = await asOwner((database) => listPendingCompanionMessages({
      actor: owner,
      orgId: org,
      companionId,
      database,
    }));
    expect(afterAcceptedPrompt.pending).toEqual([]);
    expect(afterAcceptedPrompt.timeoutRecoveryPending).toBe(false);

    // Correlated acceptance retires this timeout boundary even before Pi projects the reply. A
    // concurrent follow-up is ordinary delivery and must not recycle the valid busy recovery turn.
    const whileRecoveredTurnIsBusy = await asOwner((database) => sendCompanionMessage({
      actor: owner,
      orgId: org,
      companionId,
      content: "One more thing while you answer",
      database,
    }));
    const ordinaryFollowUp = await asOwner((database) => listPendingCompanionMessages({
      actor: owner,
      orgId: org,
      companionId,
      database,
    }));
    expect(ordinaryFollowUp.pending).toEqual([whileRecoveredTurnIsBusy.entry]);
    expect(ordinaryFollowUp.timeoutRecoveryPending).toBe(false);
    expect(ordinaryFollowUp.timeoutRestartPending).toBe(false);
    deliveryOrder.length = 0;
    const followUpDelivery = await deliverCompanionMessages({
      actor: owner,
      orgId: org,
      env: {},
      runtimeFactory: () => runtime,
    }, {
      companionId,
      boxId: "box-the-370",
      runtime,
    });
    expect(deliveryOrder).toEqual([
      `prompt:${whileRecoveredTurnIsBusy.entry.event_id}`,
    ]);
    expect(followUpDelivery?.deliveredOrdinal).toBe(whileRecoveredTurnIsBusy.entry.ordinal);

    // Generic acceptance cannot pre-authorize a tool that is still running. Pi can accept a queued
    // follow-up after the tool call, then the tool can time out; that later timeout still creates a
    // fresh recovery boundary because no timeout-correlated acceptance exists for it.
    const laterToolEventId = "pi:tool-after-accepted-follow-up";
    await asOwner((database) => recordCompanionPiProjectionWithEffects({
      actor: owner,
      orgId: org,
      companionId,
      entries: [{
        eventId: laterToolEventId,
        role: "tool",
        content: "/tmp/later.png",
        tool: {
          call_id: "call-after-accepted-follow-up",
          kind: "file",
          name: "read",
          title: "/tmp/later.png",
          status: "running",
          detail: null,
          screenshot: null,
        },
        createdAt,
      }],
      database,
    }));
    const queuedBehindRunningTool = await asOwner((database) => sendCompanionMessage({
      actor: owner,
      orgId: org,
      companionId,
      content: "Queued while the later read runs",
      database,
    }));
    deliveryOrder.length = 0;
    await deliverCompanionMessages({
      actor: owner,
      orgId: org,
      env: {},
      runtimeFactory: () => runtime,
    }, {
      companionId,
      boxId: "box-the-370",
      runtime,
    });
    expect(deliveryOrder).toEqual([`prompt:${queuedBehindRunningTool.entry.event_id}`]);
    await backdateToolRun(laterToolEventId, 91);
    await asViewer((database) => expireCompanionToolRuns({
      actor: viewer,
      orgId: org,
      companionId,
      database,
    }));
    const afterLaterTimeout = await asOwner((database) => sendCompanionMessage({
      actor: owner,
      orgId: org,
      companionId,
      content: "Recover after the later timeout",
      database,
    }));
    const laterRecovery = await asOwner((database) => listPendingCompanionMessages({
      actor: owner,
      orgId: org,
      companionId,
      database,
    }));
    expect(laterRecovery.pending).toEqual([
      queuedBehindRunningTool.entry,
      afterLaterTimeout.entry,
    ]);
    expect(laterRecovery.timeoutRecoveryPending).toBe(true);

    const answered = await asOwner((database) => recordCompanionPiProjectionWithEffects({
      actor: owner,
      orgId: org,
      companionId,
      entries: [{
        eventId: "pi:assistant-the-370",
        role: "assistant",
        content: "Pong THE-370",
        createdAt: new Date("2026-08-15T18:30:00.000Z"),
      }],
      database,
    }));
    expect(answered.thread.entries.at(-1)).toMatchObject({
      role: "assistant",
      content: "Pong THE-370",
    });
    expect(answered.thread.entries.find((entry) => entry.event_id === eventId)?.tool?.status)
      .toBe("timeout");
  });
});
