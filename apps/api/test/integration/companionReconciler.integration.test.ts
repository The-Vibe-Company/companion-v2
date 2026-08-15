import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  claimCompanionReconcileCandidates,
  settleCompanionReconcileLease,
} from "@companion/core";
import { integrationSql } from "./testDatabase";

/**
 * Product promise:
 * A Companion nobody is looking at still gets fixed. The reconciler's claim function finds every
 * stuck shape — a dead wake, a stranded archive-resume, a locked deletion, an unanswered message,
 * an unobserved runtime, an overdue chip — while active clients, explicit stops, and fresh states
 * are left alone. Two workers ticking together can never treat the same Companion at once.
 *
 * Why this test is integrated:
 * The guarantees are PostgreSQL guarantees — a conditional lease upsert, cross-tenant candidate
 * SQL, backoff gates. Mocks would prove nothing about the row-level exclusion.
 */
describe("Companion reconciler claims", () => {
  const suffix = randomUUID();
  const owner = {
    id: `reconcile-owner-${suffix}`,
    email: `reconcile-owner-${suffix}@example.test`,
    name: "Reconcile Owner",
  };
  const org = randomUUID();
  const workerA = `worker-a-${suffix}`;
  const workerB = `worker-b-${suffix}`;

  /** Fresh Companion row in a given runtime shape, aged past every grace window. */
  async function seedCompanion(input: {
    runtimeState: string;
    daemonState: string;
    agedSeconds?: number;
    lastObservedAt?: string | null;
    lastStartedAt?: string | null;
    lastStoppedAt?: string | null;
  }): Promise<string> {
    const id = randomUUID();
    await integrationSql`
      insert into companions (id, org_id, owner_id, name, box_id, runtime_state, daemon_state,
        last_observed_at, last_started_at, last_stopped_at)
      values (${id}, ${org}, ${owner.id}, 'Reconcile Companion', 'bx_23456789',
        ${input.runtimeState}, ${input.daemonState},
        ${input.lastObservedAt ?? null}, ${input.lastStartedAt ?? null}, ${input.lastStoppedAt ?? null})
    `;
    await integrationSql`
      update companions
      set updated_at = now() - make_interval(secs => ${input.agedSeconds ?? 600})
      where id = ${id}
    `;
    return id;
  }

  async function cleanCompanions() {
    await integrationSql`delete from companions where org_id = ${org}`;
  }

  beforeAll(async () => {
    await integrationSql`
      insert into "user" (id, name, email, email_verified)
      values (${owner.id}, ${owner.name}, ${owner.email}, true)
    `;
    await integrationSql`
      insert into profiles (id, name, email, initials, onboarded_at)
      values (${owner.id}, ${owner.name}, ${owner.email}, 'RO', now())
    `;
    await integrationSql`
      insert into organizations (id, name, slug, kind)
      values (${org}, 'Reconcile org', ${`reconcile-org-${suffix}`}, 'team')
    `;
    await integrationSql`
      insert into memberships (org_id, user_id, org_role) values (${org}, ${owner.id}, 'owner')
    `;
  });

  afterAll(async () => {
    await cleanCompanions();
    await integrationSql`delete from organizations where id = ${org}`;
    await integrationSql`delete from "user" where id = ${owner.id}`;
  });

  it("claims each stuck lifecycle shape with its reason and the owner identity", async () => {
    const staleStart = await seedCompanion({ runtimeState: "provisioning", daemonState: "starting" });
    const archiveResume = await seedCompanion({ runtimeState: "stopping", daemonState: "starting" });
    const deletionStuck = await seedCompanion({
      runtimeState: "stopping",
      daemonState: "unknown",
      agedSeconds: 700,
    });

    const claimed = await claimCompanionReconcileCandidates({ workerId: workerA, limit: 10 });
    const byId = new Map(claimed.map((candidate) => [candidate.companionId, candidate]));

    expect(byId.get(staleStart)?.reason).toBe("stale_start");
    expect(byId.get(archiveResume)?.reason).toBe("archive_resume");
    expect(byId.get(deletionStuck)?.reason).toBe("deletion_stuck");
    expect(byId.get(staleStart)?.owner).toEqual({
      id: owner.id,
      email: owner.email,
      name: owner.name,
    });
    expect(byId.get(staleStart)?.boxId).toBe("bx_23456789");

    // Everything claimed is leased: a second worker ticking now gets nothing.
    const second = await claimCompanionReconcileCandidates({ workerId: workerB, limit: 10 });
    expect(second.map((candidate) => candidate.companionId))
      .not.toContain(staleStart);
    expect(second.map((candidate) => candidate.companionId))
      .not.toContain(archiveResume);

    for (const id of [staleStart, archiveResume, deletionStuck]) {
      await settleCompanionReconcileLease({
        orgId: org,
        companionId: id,
        workerId: workerA,
        outcome: "test settled",
      });
    }
    await cleanCompanions();
  });

  it("leaves fresh transitions alone so a live request keeps its claim", async () => {
    await seedCompanion({ runtimeState: "provisioning", daemonState: "starting", agedSeconds: 10 });
    await seedCompanion({ runtimeState: "stopping", daemonState: "starting", agedSeconds: 5 });

    const claimed = await claimCompanionReconcileCandidates({ workerId: workerA, limit: 10 });
    expect(claimed).toEqual([]);
    await cleanCompanions();
  });

  it("claims redelivery for a recent undelivered tail and respects an explicit stop after it", async () => {
    const stranded = await seedCompanion({ runtimeState: "stopped", daemonState: "stopped" });
    const stopped = await seedCompanion({
      runtimeState: "stopped",
      daemonState: "stopped",
      // The Owner pressed Stop after sending: the reconciler must not wake this Box.
      lastStoppedAt: new Date().toISOString(),
    });
    for (const id of [stranded, stopped]) {
      await integrationSql`
        insert into companion_threads (org_id, companion_id, next_ordinal, delivered_ordinal)
        values (${org}, ${id}, 1, null)
      `;
      await integrationSql`
        insert into companion_transcript_entries
          (org_id, companion_id, event_id, ordinal, role, content, author_id, created_at)
        values (${org}, ${id}, 'msg:pending', 0, 'user', 'Alors ?', ${owner.id},
          now() - interval '5 minutes')
      `;
      await integrationSql`
        update companion_threads
        set updated_at = now() - interval '2 minutes'
        where org_id = ${org} and companion_id = ${id}
      `;
    }

    const claimed = await claimCompanionReconcileCandidates({ workerId: workerA, limit: 10 });
    const ids = claimed.map((candidate) => candidate.companionId);
    expect(ids).toContain(stranded);
    expect(claimed.find((candidate) => candidate.companionId === stranded)?.reason)
      .toBe("redelivery");
    expect(ids).not.toContain(stopped);
    await cleanCompanions();
  });

  it("skips redelivery while a client is actively syncing the thread", async () => {
    const id = await seedCompanion({ runtimeState: "stopped", daemonState: "stopped" });
    await integrationSql`
      insert into companion_threads (org_id, companion_id, next_ordinal)
      values (${org}, ${id}, 1)
    `;
    await integrationSql`
      insert into companion_transcript_entries
        (org_id, companion_id, event_id, ordinal, role, content, author_id, created_at)
      values (${org}, ${id}, 'msg:live', 0, 'user', 'Ca va ?', ${owner.id}, now())
    `;
    // The insert just bumped the thread row: that recency is exactly what "a client is on it" means.
    const claimed = await claimCompanionReconcileCandidates({ workerId: workerA, limit: 10 });
    expect(claimed.map((candidate) => candidate.companionId)).not.toContain(id);
    await cleanCompanions();
  });

  it("claims liveness only for a running Companion started recently and unobserved lately", async () => {
    const silent = await seedCompanion({
      runtimeState: "running",
      daemonState: "running",
      lastObservedAt: null,
      lastStartedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    });
    await seedCompanion({
      runtimeState: "running",
      daemonState: "running",
      // Freshly observed: nothing to probe.
      lastObservedAt: new Date().toISOString(),
      lastStartedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    });
    await seedCompanion({
      runtimeState: "running",
      daemonState: "running",
      lastObservedAt: null,
      // Started days ago: outside the probe-cost bound.
      lastStartedAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
    });

    const claimed = await claimCompanionReconcileCandidates({ workerId: workerA, limit: 10 });
    expect(claimed.map((candidate) => candidate.companionId)).toEqual([silent]);
    expect(claimed[0]?.reason).toBe("liveness");
    await cleanCompanions();
  });

  it("gates a settled failure behind its backoff and frees it afterwards", async () => {
    const id = await seedCompanion({ runtimeState: "provisioning", daemonState: "starting" });

    const [first] = await claimCompanionReconcileCandidates({ workerId: workerA, limit: 10 });
    expect(first?.companionId).toBe(id);
    expect(first?.attempts).toBe(0);

    const settled = await settleCompanionReconcileLease({
      orgId: org,
      companionId: id,
      workerId: workerA,
      outcome: "heal failed",
      backoffSeconds: 3600,
    });
    expect(settled).toBe(true);

    // Backed off: nobody can claim it again yet, though the condition still holds.
    const during = await claimCompanionReconcileCandidates({ workerId: workerB, limit: 10 });
    expect(during.map((candidate) => candidate.companionId)).not.toContain(id);

    await integrationSql`
      update companion_reconcile_leases
      set next_attention_at = now() - interval '1 second'
      where org_id = ${org} and companion_id = ${id}
    `;
    const after = await claimCompanionReconcileCandidates({ workerId: workerB, limit: 10 });
    const reclaimed = after.find((candidate) => candidate.companionId === id);
    expect(reclaimed?.attempts).toBe(1);

    // A worker that no longer holds the lease cannot settle it.
    await expect(settleCompanionReconcileLease({
      orgId: org,
      companionId: id,
      workerId: workerA,
      outcome: "stale settle",
    })).resolves.toBe(false);
    await cleanCompanions();
  });

  it("claims an expiry sweep for an overdue chip on a thread nobody reads", async () => {
    const id = await seedCompanion({ runtimeState: "stopped", daemonState: "stopped" });
    await integrationSql`
      insert into companion_threads (org_id, companion_id, next_ordinal)
      values (${org}, ${id}, 1)
    `;
    await integrationSql`
      insert into companion_transcript_entries
        (org_id, companion_id, event_id, ordinal, role, content, tool, created_at)
      values (${org}, ${id}, 'pi:stuck-tool', 0, 'tool', 'read',
        ${JSON.stringify({
          call_id: "call-1",
          kind: "file",
          name: "read",
          title: "read",
          status: "running",
          detail: null,
          screenshot: null,
        })}::jsonb,
        now() - interval '10 minutes')
    `;
    await integrationSql`
      update companion_threads
      set updated_at = now() - interval '5 minutes'
      where org_id = ${org} and companion_id = ${id}
    `;

    const claimed = await claimCompanionReconcileCandidates({ workerId: workerA, limit: 10 });
    expect(claimed.find((candidate) => candidate.companionId === id)?.reason).toBe("expiry_sweep");
    await cleanCompanions();
  });

  it("gives a shell chip the longer deadline before sweeping it", async () => {
    const id = await seedCompanion({ runtimeState: "stopped", daemonState: "stopped" });
    await integrationSql`
      insert into companion_threads (org_id, companion_id, next_ordinal)
      values (${org}, ${id}, 1)
    `;
    await integrationSql`
      insert into companion_transcript_entries
        (org_id, companion_id, event_id, ordinal, role, content, tool, created_at)
      values (${org}, ${id}, 'pi:long-build', 0, 'tool', 'pnpm test',
        ${JSON.stringify({
          call_id: "call-2",
          kind: "shell",
          name: "bash",
          title: "pnpm test",
          status: "running",
          detail: null,
          screenshot: null,
        })}::jsonb,
        now() - interval '5 minutes')
    `;
    await integrationSql`
      update companion_threads
      set updated_at = now() - interval '4 minutes'
      where org_id = ${org} and companion_id = ${id}
    `;

    // Five minutes into a shell run is a build, not a stall.
    const claimed = await claimCompanionReconcileCandidates({ workerId: workerA, limit: 10 });
    expect(claimed.map((candidate) => candidate.companionId)).not.toContain(id);
    await cleanCompanions();
  });
});
