import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { extractRuntimeRoleGrantBlock, resolveRuntimeRoleGrantsFile } from "../../src/migrate";
import {
  CompanionRuntimeTransitionError,
  CompanionShareForbiddenError,
  CompanionNotFoundError,
  claimCompanionRuntimeStart,
  claimCompanionRuntimeStop,
  listCompanionShares,
  recordCompanionPiProjection,
  setCompanionWorkspaceShare,
  updateCompanionObservation,
} from "@companion/core";
import { withTenantContext } from "@companion/db";
import {
  createIntegrationFixture,
  integrationSql,
  seedSkill,
  type IntegrationFixture,
} from "./testDatabase";

/**
 * Product promise: PostgreSQL enforces organization isolation for the non-bypass API role, while
 * creator-only personal-skill access remains an additional service-layer gate.
 *
 * Regression caught: dropping FORCE RLS or the organization predicate.
 *
 * Why integrated: table owners and mocked query builders cannot prove PostgreSQL policy behavior.
 *
 * Failure proof: removing the org predicate makes the cross-tenant query return the outsider's skill.
 */
describe("Skills Hub PostgreSQL isolation", () => {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 16);
  const apiRole = `companion_api_${suffix}`;
  const workerRole = `companion_worker_${suffix}`;
  const migrationRole = `companion_migration_${suffix}`;
  let functionOwner: string;
  let fixture: IntegrationFixture;
  let personalSlug: string;
  let orgSlug: string;
  let otherOrgSlug: string;
  const companionId = randomUUID();
  const deliveryFenceCompanionId = randomUUID();

  beforeAll(async () => {
    const [ownerRow] = await integrationSql<Array<{ current_user: string }>>`select current_user`;
    functionOwner = ownerRow!.current_user;
    fixture = await createIntegrationFixture();
    personalSlug = `private-${fixture.suffix}`;
    orgSlug = `org-${fixture.suffix}`;
    otherOrgSlug = `other-${fixture.suffix}`;
    await seedSkill({ orgId: fixture.orgA, creator: fixture.owner, slug: personalSlug, scope: "personal" });
    await seedSkill({ orgId: fixture.orgA, creator: fixture.owner, slug: orgSlug, scope: "org" });
    await seedSkill({ orgId: fixture.orgB, creator: fixture.outsider, slug: otherOrgSlug, scope: "org" });
    await integrationSql`
      insert into companions (id, org_id, owner_id, name)
      values
        (${companionId}, ${fixture.orgA}, ${fixture.owner.id}, 'RLS companion'),
        (${deliveryFenceCompanionId}, ${fixture.orgA}, ${fixture.owner.id}, 'Delivery fence companion')
    `;
    await integrationSql`
      insert into companion_transcript_entries (
        org_id, companion_id, event_id, ordinal, role, content, author_id
      ) values (
        ${fixture.orgA}, ${deliveryFenceCompanionId}, 'delivery-fence-user', 0, 'user',
        'rollout-safe prompt', ${fixture.owner.id}
      )
    `;
    await integrationSql`
      insert into companion_threads (org_id, companion_id, next_ordinal)
      values (${fixture.orgA}, ${deliveryFenceCompanionId}, 1)
    `;
    await integrationSql.unsafe(`create role ${apiRole} login nosuperuser nobypassrls noinherit`);
    await integrationSql.unsafe(`create role ${workerRole} login nosuperuser nobypassrls noinherit`);
    await integrationSql.unsafe(`create role ${migrationRole} login nosuperuser nobypassrls noinherit`);
    await integrationSql.unsafe(`
      grant usage on schema public to ${migrationRole};
      grant select on memberships, companions, companion_workspace_access,
        companion_transcript_entries, companion_threads to ${migrationRole};
      grant update on companion_transcript_entries, companion_threads to ${migrationRole};
      grant execute on function companion_delivery_read_fence(uuid, uuid, text) to ${migrationRole};
      alter function companion_expire_tool_runs(uuid, uuid, timestamp with time zone, integer, integer)
        owner to ${migrationRole}
    `);
    const grants = extractRuntimeRoleGrantBlock(await readFile(await resolveRuntimeRoleGrantsFile(), "utf8"));
    await integrationSql.begin(async (tx) => {
      await tx`select set_config('companion.api_role', ${apiRole}, true)`;
      await tx`select set_config('companion.worker_role', ${workerRole}, true)`;
      await tx.unsafe(grants);
    });
  });

  afterAll(async () => {
    await integrationSql`
      delete from companions where id in (${companionId}, ${deliveryFenceCompanionId})
    `;
    await fixture.cleanup();
    await integrationSql.unsafe(`drop owned by ${apiRole}`);
    await integrationSql.unsafe(`drop owned by ${workerRole}`);
    await integrationSql.unsafe(`alter function companion_expire_tool_runs(uuid, uuid, timestamp with time zone, integer, integer) owner to ${functionOwner}`);
    await integrationSql.unsafe(`drop owned by ${migrationRole}`);
    await integrationSql.unsafe(`drop role ${apiRole}`);
    await integrationSql.unsafe(`drop role ${workerRole}`);
    await integrationSql.unsafe(`drop role ${migrationRole}`);
  });

  async function visibleSlugs(orgId: string, userId: string): Promise<string[]> {
    return integrationSql.begin(async (tx) => {
      await tx.unsafe(`set local role ${apiRole}`);
      await tx`select set_config('app.org_id', ${orgId}, true), set_config('app.user_id', ${userId}, true)`;
      const rows = await tx<Array<{ slug: string }>>`select slug from skills order by slug`;
      return rows.map((row) => row.slug);
    });
  }

  it("shows an owner their personal and org skills but hides both from other tenants", async () => {
    expect(await visibleSlugs(fixture.orgA, fixture.owner.id)).toEqual([orgSlug, personalSlug].sort());
    expect(await visibleSlugs(fixture.orgB, fixture.outsider.id)).toEqual([otherOrgSlug]);
  });

  it("replaces only untouched migration seeds during post-commit delivery refinement", async () => {
    await expect(integrationSql`
      select companion_refresh_delivery_compat_backfill(NULL)
    `).rejects.toThrow("batch size must be between 1 and 1000");

    await integrationSql`
      insert into companion_reconcile_leases (
        org_id, companion_id, reason, delivery_compat_expires_at,
        delivery_compat_next_ordinal, delivery_compat_seeded
      ) values (
        ${fixture.orgA}, ${companionId}, 'delivery_compat',
        statement_timestamp() + interval '10 minutes', 0, true
      )
    `;
    const refined = await integrationSql<Array<{ processed: number }>>`
      select companion_refresh_delivery_compat_backfill(1) as processed
    `;
    expect(refined).toEqual([{ processed: 1 }]);
    const [refinedSeed] = await integrationSql<Array<{
      delivery_compat_expires_at: string;
      delivery_compat_seeded: boolean;
    }>>`
      select delivery_compat_expires_at, delivery_compat_seeded
      from companion_reconcile_leases
      where companion_id = ${companionId}
    `;
    expect(refinedSeed?.delivery_compat_seeded).toBe(false);
    expect(Date.parse(refinedSeed?.delivery_compat_expires_at ?? ""))
      .toBeLessThan(Date.now() + 60_000);

    // Once a legacy read has replaced the seed, a later runner retry must not shorten that real
    // in-flight snapshot fence even when the Companion's current exact work count is zero.
    await integrationSql`
      update companion_reconcile_leases
      set delivery_compat_expires_at = statement_timestamp() + interval '11 minutes'
      where companion_id = ${companionId}
    `;
    const retried = await integrationSql<Array<{ processed: number }>>`
      select companion_refresh_delivery_compat_backfill(1) as processed
    `;
    expect(retried).toEqual([{ processed: 0 }]);
    const [preservedLegacyFence] = await integrationSql<Array<{
      delivery_compat_expires_at: string;
      delivery_compat_seeded: boolean;
    }>>`
      select delivery_compat_expires_at, delivery_compat_seeded
      from companion_reconcile_leases
      where companion_id = ${companionId}
    `;
    expect(preservedLegacyFence?.delivery_compat_seeded).toBe(false);
    expect(Date.parse(preservedLegacyFence?.delivery_compat_expires_at ?? ""))
      .toBeGreaterThan(Date.now() + 10 * 60_000);
    await integrationSql`
      delete from companion_reconcile_leases
      where companion_id in (${companionId}, ${deliveryFenceCompanionId})
    `;
  });

  it("fences legacy transcript delivery against protocol-2 claims during rollout", async () => {
    const firstClaim = randomUUID();
    const claimed = await integrationSql.begin(async (tx) => {
      await tx.unsafe(`set local role ${apiRole}`);
      await tx`
        select set_config('app.org_id', ${fixture.orgA}, true),
               set_config('app.user_id', ${fixture.owner.id}, true),
               set_config('app.companion_delivery_protocol', '2', true)
      `;
      return tx<Array<{ claimed: boolean }>>`
        select companion_claim_delivery_lease(
          ${fixture.orgA}, ${deliveryFenceCompanionId}, ${firstClaim}, 600
        ) as claimed
      `;
    });
    expect(claimed).toEqual([{ claimed: true }]);

    // An old replica has no protocol marker. The restrictive transcript policy must fail its read
    // before it can take the prompt snapshot while a new delivery owns the exact lease.
    await expect(integrationSql.begin(async (tx) => {
      await tx.unsafe(`set local role ${apiRole}`);
      await tx`
        select set_config('app.org_id', ${fixture.orgA}, true),
               set_config('app.user_id', ${fixture.owner.id}, true)
      `;
      await tx`
        select event_id from companion_transcript_entries
        where companion_id = ${deliveryFenceCompanionId}
      `;
    })).rejects.toThrow("Companion delivery protocol is upgrading");

    // Migration backfill owns compatibility state independently of an already-active worker/API
    // lease. Model that overlap directly: releasing the exact owner below must not erase the fence.
    await integrationSql`
      update companion_reconcile_leases
      set delivery_compat_expires_at = statement_timestamp() + interval '11 minutes',
          delivery_compat_next_ordinal = 1
      where companion_id = ${deliveryFenceCompanionId}
    `;

    await integrationSql.begin(async (tx) => {
      await tx.unsafe(`set local role ${apiRole}`);
      await tx`
        select set_config('app.org_id', ${fixture.orgA}, true),
               set_config('app.user_id', ${fixture.owner.id}, true),
               set_config('app.companion_delivery_protocol', '2', true)
      `;
      await tx`
        select companion_release_delivery_lease(
          ${fixture.orgA}, ${deliveryFenceCompanionId}, ${firstClaim}
        )
      `;
    });

    const backfillBlockedClaim = randomUUID();
    const blockedAfterRelease = await integrationSql.begin(async (tx) => {
      await tx.unsafe(`set local role ${apiRole}`);
      await tx`
        select set_config('app.org_id', ${fixture.orgA}, true),
               set_config('app.user_id', ${fixture.owner.id}, true),
               set_config('app.companion_delivery_protocol', '2', true)
      `;
      return tx<Array<{ claimed: boolean }>>`
        select companion_claim_delivery_lease(
          ${fixture.orgA}, ${deliveryFenceCompanionId}, ${backfillBlockedClaim}, 600
        ) as claimed
      `;
    });
    expect(blockedAfterRelease).toEqual([{ claimed: false }]);

    // A legacy snapshot is finite but its prompt loop scales with its actual durable tail, not the
    // full historical ordinal. Six pending prompts on a 1,000-ordinal thread need sixteen minutes,
    // not the roughly seventeen-hour outage a total-history deadline would create.
    await integrationSql`
      insert into companion_transcript_entries (
        org_id, companion_id, event_id, ordinal, role, content, author_id
      )
      select ${fixture.orgA}, ${deliveryFenceCompanionId}, 'delivery-fence-user-' || n,
             n, 'user', 'queued prompt ' || n, ${fixture.owner.id}
      from generate_series(1, 5) as n
    `;
    await integrationSql`
      update companion_threads
      set next_ordinal = 1000
      where companion_id = ${deliveryFenceCompanionId}
    `;
    await integrationSql`
      update companion_threads
      set delivered_ordinal = 5
      where companion_id = ${deliveryFenceCompanionId}
    `;
    const [deliveredHistory] = await integrationSql<Array<{ deadline: string }>>`
      select companion_delivery_compat_deadline(
        ${fixture.orgA}, ${deliveryFenceCompanionId}, statement_timestamp()
      ) as deadline
    `;
    // A post-snapshot watermark is not completion evidence: a slower old request may still hold
    // these six unanswered prompts, so migration backfill must retain their full drain window.
    expect(Date.parse(deliveredHistory!.deadline)).toBeGreaterThan(Date.now() + 15 * 60_000);
    await integrationSql`
      insert into companion_transcript_entries (
        org_id, companion_id, event_id, ordinal, role, content
      ) values (
        ${fixture.orgA}, ${deliveryFenceCompanionId}, 'delivery-fence-assistant', 6,
        'assistant', 'All queued prompts answered.'
      )
    `;
    const [recentlyCompleted] = await integrationSql<Array<{ deadline: string }>>`
      select companion_delivery_compat_deadline(
        ${fixture.orgA}, ${deliveryFenceCompanionId}, statement_timestamp()
      ) as deadline
    `;
    // Even a just-written assistant can belong to the faster request; retain the completed batch
    // until its own size-derived drain window proves a slower pre-policy snapshot has ended.
    expect(Date.parse(recentlyCompleted!.deadline)).toBeGreaterThan(Date.now() + 15 * 60_000);
    await integrationSql`
      update companion_transcript_entries
      set created_at = statement_timestamp() - interval '1 day'
      where companion_id = ${deliveryFenceCompanionId}
        and event_id = 'delivery-fence-assistant'
    `;
    const [completedHistory] = await integrationSql<Array<{ deadline: string }>>`
      select companion_delivery_compat_deadline(
        ${fixture.orgA}, ${deliveryFenceCompanionId}, statement_timestamp()
      ) as deadline
    `;
    // Once an assistant closes that tail, the 1,000-ordinal historical bound adds no outage.
    expect(Date.parse(completedHistory!.deadline)).toBeLessThan(Date.now() + 60_000);
    await integrationSql`
      insert into companion_transcript_entries (
        org_id, companion_id, event_id, ordinal, role, content, decision
      ) values (
        ${fixture.orgA}, ${deliveryFenceCompanionId}, 'delivery-fence-settled-decision', 7,
        'decision', 'Already allowed', jsonb_build_object(
          'status', 'allowed',
          'decided_at', statement_timestamp()::text
        )
      )
    `;
    const [settlementInFlight] = await integrationSql<Array<{ deadline: string }>>`
      select companion_delivery_compat_deadline(
        ${fixture.orgA}, ${deliveryFenceCompanionId}, statement_timestamp()
      ) as deadline
    `;
    // A pre-policy route persists its decision before the FIFO response. Backfill in that gap must
    // still fence protocol 2 even though the card no longer reports `pending`.
    expect(Date.parse(settlementInFlight!.deadline)).toBeGreaterThan(Date.now() + 9 * 60_000);
    await integrationSql`
      delete from companion_transcript_entries
      where companion_id = ${deliveryFenceCompanionId}
        and event_id = 'delivery-fence-settled-decision'
    `;
    await integrationSql`
      delete from companion_transcript_entries
      where companion_id = ${deliveryFenceCompanionId}
        and event_id = 'delivery-fence-assistant'
    `;
    await integrationSql`
      update companion_threads
      set delivered_ordinal = NULL
      where companion_id = ${deliveryFenceCompanionId}
    `;
    await integrationSql`
      update companion_reconcile_leases
      set delivery_compat_expires_at = statement_timestamp() + interval '20 minutes',
          delivery_compat_next_ordinal = 0,
          delivery_compat_seeded = false
      where companion_id = ${deliveryFenceCompanionId}
    `;

    const legacyRows = await integrationSql.begin(async (tx) => {
      await tx.unsafe(`set local role ${apiRole}`);
      await tx`
        select set_config('app.org_id', ${fixture.orgA}, true),
               set_config('app.user_id', ${fixture.owner.id}, true)
      `;
      return tx<Array<{ event_id: string }>>`
        select event_id from companion_transcript_entries
        where companion_id = ${deliveryFenceCompanionId}
      `;
    });
    expect(legacyRows).toHaveLength(6);
    expect(legacyRows.map((row) => row.event_id)).toContain("delivery-fence-user");

    // This read observed a larger next ordinal and recalculated a shorter work estimate. It must
    // not shorten the fence established by an earlier legacy snapshot that may still be draining.
    const [preservedEarlierRead] = await integrationSql<Array<{
      delivery_compat_expires_at: string | null;
    }>>`
      select delivery_compat_expires_at
      from companion_reconcile_leases
      where companion_id = ${deliveryFenceCompanionId}
    `;
    expect(Date.parse(preservedEarlierRead?.delivery_compat_expires_at ?? ""))
      .toBeGreaterThan(Date.now() + 19 * 60_000);

    // Establish a fresh exact fence for the remaining claim assertions below.
    await integrationSql`
      update companion_reconcile_leases
      set delivery_compat_expires_at = NULL,
          delivery_compat_next_ordinal = NULL
      where companion_id = ${deliveryFenceCompanionId}
    `;
    await integrationSql.begin(async (tx) => {
      await tx.unsafe(`set local role ${apiRole}`);
      await tx`
        select set_config('app.org_id', ${fixture.orgA}, true),
               set_config('app.user_id', ${fixture.owner.id}, true)
      `;
      await tx`
        select event_id from companion_transcript_entries
        where companion_id = ${deliveryFenceCompanionId}
      `;
    });

    const secondClaim = randomUUID();
    const blocked = await integrationSql.begin(async (tx) => {
      await tx.unsafe(`set local role ${apiRole}`);
      await tx`
        select set_config('app.org_id', ${fixture.orgA}, true),
               set_config('app.user_id', ${fixture.owner.id}, true),
               set_config('app.companion_delivery_protocol', '2', true)
      `;
      return tx<Array<{ claimed: boolean }>>`
        select companion_claim_delivery_lease(
          ${fixture.orgA}, ${deliveryFenceCompanionId}, ${secondClaim}, 600
        ) as claimed
      `;
    });
    expect(blocked).toEqual([{ claimed: false }]);

    // Protocol-1 workers know only claimed_by/lease_expires_at. The table guard must reject that
    // ordinary claim too, otherwise the old reconciler could prompt beside protocol 2 during rollout.
    const legacyWorkerClaim = await integrationSql<Array<{ claimed_by: string }>>`
      update companion_reconcile_leases
      set claimed_by = 'legacy-worker',
          lease_expires_at = statement_timestamp() + interval '5 minutes'
      where companion_id = ${deliveryFenceCompanionId}
      returning claimed_by
    `;
    expect(legacyWorkerClaim).toEqual([]);

    // One old watermark cannot prove that every other old request has finished the prompt snapshot
    // it already read. The shared fence therefore survives delivery and only an expired full drain
    // window lets protocol 2 take over.
    const watermark = await integrationSql.begin(async (tx) => {
      await tx.unsafe(`set local role ${apiRole}`);
      await tx`
        select set_config('app.org_id', ${fixture.orgA}, true),
               set_config('app.user_id', ${fixture.owner.id}, true),
               set_config('app.companion_delivery_protocol', '2', true)
      `;
      return tx<Array<{ delivered_ordinal: number }>>`
        update companion_threads set delivered_ordinal = 0
        where companion_id = ${deliveryFenceCompanionId}
        returning delivered_ordinal
      `;
    });
    expect(watermark).toEqual([{ delivered_ordinal: 0 }]);
    const [liveFence] = await integrationSql<Array<{
      delivery_compat_expires_at: string | null;
      delivery_compat_next_ordinal: number | null;
    }>>`
      select delivery_compat_expires_at, delivery_compat_next_ordinal
      from companion_reconcile_leases
      where companion_id = ${deliveryFenceCompanionId}
    `;
    expect(liveFence?.delivery_compat_next_ordinal).toBe(1000);
    expect(Date.parse(liveFence?.delivery_compat_expires_at ?? "")).toBeGreaterThan(
      Date.now() + 15 * 60_000,
    );
    expect(Date.parse(liveFence?.delivery_compat_expires_at ?? "")).toBeLessThan(
      Date.now() + 17 * 60_000,
    );
    await integrationSql`
      update companion_reconcile_leases
      set delivery_compat_expires_at = statement_timestamp() - interval '1 second'
      where companion_id = ${deliveryFenceCompanionId}
    `;
    const reclaimed = await integrationSql.begin(async (tx) => {
      await tx.unsafe(`set local role ${apiRole}`);
      await tx`
        select set_config('app.org_id', ${fixture.orgA}, true),
               set_config('app.user_id', ${fixture.owner.id}, true),
               set_config('app.companion_delivery_protocol', '2', true)
      `;
      return tx<Array<{ claimed: boolean }>>`
        select companion_claim_delivery_lease(
          ${fixture.orgA}, ${deliveryFenceCompanionId}, ${secondClaim}, 600
        ) as claimed
      `;
    });
    expect(reclaimed).toEqual([{ claimed: true }]);

    const wrongClaim = await integrationSql.begin(async (tx) => {
      await tx.unsafe(`set local role ${apiRole}`);
      await tx`
        select set_config('app.org_id', ${fixture.orgA}, true),
               set_config('app.user_id', ${fixture.owner.id}, true),
               set_config('app.companion_delivery_protocol', '2', true)
      `;
      return tx<Array<{ accepted: boolean }>>`
        select companion_accept_delivery_lease(
          ${fixture.orgA}, ${deliveryFenceCompanionId}, ${randomUUID()}, 5, NULL
        ) as accepted
      `;
    });
    expect(wrongClaim).toEqual([{ accepted: false }]);

    const exactAcceptance = await integrationSql.begin(async (tx) => {
      await tx.unsafe(`set local role ${apiRole}`);
      await tx`
        select set_config('app.org_id', ${fixture.orgA}, true),
               set_config('app.user_id', ${fixture.owner.id}, true),
               set_config('app.companion_delivery_protocol', '2', true)
      `;
      return tx<Array<{ accepted: boolean }>>`
        select companion_accept_delivery_lease(
          ${fixture.orgA}, ${deliveryFenceCompanionId}, ${secondClaim}, 5, 5
        ) as accepted
      `;
    });
    expect(exactAcceptance).toEqual([{ accepted: true }]);

    await integrationSql`
      update companion_reconcile_leases
      set lease_expires_at = statement_timestamp() - interval '1 second'
      where companion_id = ${deliveryFenceCompanionId}
    `;
    const expiredAcceptance = await integrationSql.begin(async (tx) => {
      await tx.unsafe(`set local role ${apiRole}`);
      await tx`
        select set_config('app.org_id', ${fixture.orgA}, true),
               set_config('app.user_id', ${fixture.owner.id}, true),
               set_config('app.companion_delivery_protocol', '2', true)
      `;
      return tx<Array<{ accepted: boolean }>>`
        select companion_accept_delivery_lease(
          ${fixture.orgA}, ${deliveryFenceCompanionId}, ${secondClaim}, 6, 6
        ) as accepted
      `;
    });
    expect(expiredAcceptance).toEqual([{ accepted: false }]);
    const [fencedWatermark] = await integrationSql<Array<{
      delivered_ordinal: number | null;
      accepted_delivery_ordinal: number | null;
      timeout_delivery_ordinal: number | null;
    }>>`
      select delivered_ordinal, accepted_delivery_ordinal, timeout_delivery_ordinal
      from companion_threads
      where companion_id = ${deliveryFenceCompanionId}
    `;
    expect(fencedWatermark).toEqual({
      delivered_ordinal: 5,
      accepted_delivery_ordinal: 5,
      timeout_delivery_ordinal: 5,
    });
  });

  it("enforces the workspace-only Companion ACL in PostgreSQL (no per-member overrides)", async () => {
    const initiallyVisible = await integrationSql.begin(async (tx) => {
      await tx.unsafe(`set local role ${apiRole}`);
      await tx`select set_config('app.org_id', ${fixture.orgA}, true), set_config('app.user_id', ${fixture.admin.id}, true)`;
      return tx<Array<{ id: string }>>`select id from companions`;
    });
    expect(initiallyVisible).toEqual([]);

    // The owner seeds the thread read model and grants the whole workspace Viewer access. There is
    // no per-member grant table any more, so every current member reads through this one row.
    await integrationSql.begin(async (tx) => {
      await tx.unsafe(`set local role ${apiRole}`);
      await tx`select set_config('app.org_id', ${fixture.orgA}, true), set_config('app.user_id', ${fixture.owner.id}, true)`;
      await tx`
        insert into companion_workspace_access (
          org_id, companion_id, owner_id, role, granted_by
        ) values (
          ${fixture.orgA}, ${companionId}, ${fixture.owner.id}, 'viewer', ${fixture.owner.id}
        )
      `;
      await tx`
        insert into companion_transcript_entries (
          org_id, companion_id, event_id, ordinal, role, content
        ) values (
          ${fixture.orgA}, ${companionId}, 'event-1', 0, 'assistant', 'Control-plane message'
        )
      `;
      await tx`
        insert into companion_threads (org_id, companion_id, next_ordinal)
        values (${fixture.orgA}, ${companionId}, 1)
      `;
    });

    const viewerResult = await integrationSql.begin(async (tx) => {
      await tx.unsafe(`set local role ${apiRole}`);
      await tx`select set_config('app.org_id', ${fixture.orgA}, true), set_config('app.user_id', ${fixture.admin.id}, true)`;
      const visible = await tx<Array<{ id: string }>>`select id from companions`;
      const transcript = await tx<Array<{ content: string }>>`
        select content from companion_transcript_entries where companion_id = ${companionId}
      `;
      const thread = await tx<Array<{ next_ordinal: number }>>`
        select next_ordinal from companion_threads where companion_id = ${companionId}
      `;
      const threadWrite = await tx<Array<{ companion_id: string }>>`
        update companion_threads set next_ordinal = 9 where companion_id = ${companionId}
        returning companion_id
      `;
      const updated = await tx<Array<{ id: string }>>`
        update companions set runtime_state = 'running' where id = ${companionId} returning id
      `;
      return { visible, transcript, thread, threadWrite, updated };
    });
    expect(viewerResult.visible).toEqual([{ id: companionId }]);
    expect(viewerResult.transcript).toEqual([{ content: "Control-plane message" }]);
    // A Viewer reads the thread read model but cannot advance the ordinals a send would consume.
    expect(viewerResult.thread).toEqual([{ next_ordinal: 1 }]);
    expect(viewerResult.threadWrite).toEqual([]);
    expect(viewerResult.updated).toEqual([]);

    // A Viewer cannot write the transcript either.
    await expect(integrationSql.begin(async (tx) => {
      await tx.unsafe(`set local role ${apiRole}`);
      await tx`select set_config('app.org_id', ${fixture.orgA}, true), set_config('app.user_id', ${fixture.admin.id}, true)`;
      await tx`
        insert into companion_transcript_entries (
          org_id, companion_id, event_id, ordinal, role, content
        ) values (
          ${fixture.orgA}, ${companionId}, 'viewer-write', 1, 'user', 'must be rejected'
        )
      `;
    })).rejects.toThrow();

    // Raising the workspace grant to Editor lets every member run the Companion.
    await integrationSql.begin(async (tx) => {
      await tx.unsafe(`set local role ${apiRole}`);
      await tx`select set_config('app.org_id', ${fixture.orgA}, true), set_config('app.user_id', ${fixture.owner.id}, true)`;
      await tx`
        update companion_workspace_access set role = 'editor'
        where companion_id = ${companionId}
      `;
    });

    const editorUpdate = await integrationSql.begin(async (tx) => {
      await tx.unsafe(`set local role ${apiRole}`);
      await tx`select set_config('app.org_id', ${fixture.orgA}, true), set_config('app.user_id', ${fixture.admin.id}, true)`;
      return tx<Array<{ id: string }>>`
        update companions set runtime_state = 'running' where id = ${companionId} returning id
      `;
    });
    expect(editorUpdate).toEqual([{ id: companionId }]);

    const editorThreadWrite = await integrationSql.begin(async (tx) => {
      await tx.unsafe(`set local role ${apiRole}`);
      await tx`select set_config('app.org_id', ${fixture.orgA}, true), set_config('app.user_id', ${fixture.admin.id}, true)`;
      return tx<Array<{ next_ordinal: number }>>`
        update companion_threads set next_ordinal = 2 where companion_id = ${companionId}
        returning next_ordinal
      `;
    });
    expect(editorThreadWrite).toEqual([{ next_ordinal: 2 }]);

    const secondMemberUpdate = await integrationSql.begin(async (tx) => {
      await tx.unsafe(`set local role ${apiRole}`);
      await tx`select set_config('app.org_id', ${fixture.orgA}, true), set_config('app.user_id', ${fixture.developer.id}, true)`;
      return tx<Array<{ id: string }>>`
        update companions set runtime_state = 'stopped' where id = ${companionId} returning id
      `;
    });
    expect(secondMemberUpdate).toEqual([{ id: companionId }]);

    // Removing the workspace grant returns the Companion to private: members lose all access.
    await integrationSql.begin(async (tx) => {
      await tx.unsafe(`set local role ${apiRole}`);
      await tx`select set_config('app.org_id', ${fixture.orgA}, true), set_config('app.user_id', ${fixture.owner.id}, true)`;
      await tx`delete from companion_workspace_access where companion_id = ${companionId}`;
    });
    const revokedAccess = await integrationSql.begin(async (tx) => {
      await tx.unsafe(`set local role ${apiRole}`);
      await tx`select set_config('app.org_id', ${fixture.orgA}, true), set_config('app.user_id', ${fixture.admin.id}, true)`;
      const visible = await tx<Array<{ id: string }>>`select id from companions`;
      const updated = await tx<Array<{ id: string }>>`
        update companions set runtime_state = 'running' where id = ${companionId} returning id
      `;
      return { visible, updated };
    });
    expect(revokedAccess.visible).toEqual([]);
    expect(revokedAccess.updated).toEqual([]);

    const outsiderVisible = await integrationSql.begin(async (tx) => {
      await tx.unsafe(`set local role ${apiRole}`);
      await tx`select set_config('app.org_id', ${fixture.orgB}, true), set_config('app.user_id', ${fixture.outsider.id}, true)`;
      const companionRows = await tx<Array<{ id: string }>>`select id from companions`;
      const threadRows = await tx<Array<{ companion_id: string }>>`select companion_id from companion_threads`;
      return { companionRows, threadRows };
    });
    expect(outsiderVisible.companionRows).toEqual([]);
    expect(outsiderVisible.threadRows).toEqual([]);
  });

  it("lets a runner settle a tool run and attach its frame while a Viewer cannot", async () => {
    const running = JSON.stringify({
      call_id: "call-1",
      kind: "shell",
      name: "bash",
      title: "ls -la",
      status: "running",
      detail: null,
      screenshot: null,
    });
    await integrationSql.begin(async (tx) => {
      await tx.unsafe(`set local role ${apiRole}`);
      await tx`select set_config('app.org_id', ${fixture.orgA}, true), set_config('app.user_id', ${fixture.owner.id}, true)`;
      await tx`
        insert into companion_transcript_entries (
          org_id, companion_id, event_id, ordinal, role, content, tool
        ) values (
          ${fixture.orgA}, ${companionId}, 'pi:1:tool:0', 2, 'tool', '', ${running}::jsonb
        )
      `;
      await tx`
        insert into companion_workspace_access (
          org_id, companion_id, owner_id, role, granted_by
        ) values (
          ${fixture.orgA}, ${companionId}, ${fixture.owner.id}, 'viewer', ${fixture.owner.id}
        )
      `;
    });

    // A Viewer reads the chip and never settles it, so watching a thread cannot rewrite its history.
    const viewerSettle = await integrationSql.begin(async (tx) => {
      await tx.unsafe(`set local role ${apiRole}`);
      await tx`select set_config('app.org_id', ${fixture.orgA}, true), set_config('app.user_id', ${fixture.admin.id}, true)`;
      const visible = await tx<Array<{ status: string }>>`
        select tool->>'status' as status from companion_transcript_entries
        where companion_id = ${companionId} and event_id = 'pi:1:tool:0'
      `;
      const settled = await tx<Array<{ event_id: string }>>`
        update companion_transcript_entries set tool = jsonb_set(tool, '{status}', '"ok"')
        where companion_id = ${companionId} and event_id = 'pi:1:tool:0'
        returning event_id
      `;
      return { visible, settled };
    });
    expect(viewerSettle.visible).toEqual([{ status: "running" }]);
    expect(viewerSettle.settled).toEqual([]);

    await integrationSql.begin(async (tx) => {
      await tx.unsafe(`set local role ${apiRole}`);
      await tx`select set_config('app.org_id', ${fixture.orgA}, true), set_config('app.user_id', ${fixture.owner.id}, true)`;
      await tx`update companion_workspace_access set role = 'editor' where companion_id = ${companionId}`;
    });

    // An Editor settles the run and attaches the frame the sync captured for it.
    const editorSettle = await integrationSql.begin(async (tx) => {
      await tx.unsafe(`set local role ${apiRole}`);
      await tx`select set_config('app.org_id', ${fixture.orgA}, true), set_config('app.user_id', ${fixture.admin.id}, true)`;
      return tx<Array<{ status: string; screenshot: string }>>`
        update companion_transcript_entries
        set tool = jsonb_set(jsonb_set(tool, '{status}', '"ok"'), '{screenshot}', '"data:image/png;base64,AAAA"')
        where companion_id = ${companionId} and event_id = 'pi:1:tool:0'
        returning tool->>'status' as status, tool->>'screenshot' as screenshot
      `;
    });
    expect(editorSettle).toEqual([{ status: "ok", screenshot: "data:image/png;base64,AAAA" }]);

    // The tenant predicate still holds: another tenant neither reads nor settles this run.
    const outsiderSettle = await integrationSql.begin(async (tx) => {
      await tx.unsafe(`set local role ${apiRole}`);
      await tx`select set_config('app.org_id', ${fixture.orgB}, true), set_config('app.user_id', ${fixture.outsider.id}, true)`;
      const visible = await tx<Array<{ event_id: string }>>`
        select event_id from companion_transcript_entries where companion_id = ${companionId}
      `;
      const settled = await tx<Array<{ event_id: string }>>`
        update companion_transcript_entries set tool = jsonb_set(tool, '{status}', '"error"')
        where companion_id = ${companionId} and event_id = 'pi:1:tool:0'
        returning event_id
      `;
      return { visible, settled };
    });
    expect(outsiderSettle.visible).toEqual([]);
    expect(outsiderSettle.settled).toEqual([]);

    await integrationSql`delete from companion_workspace_access where companion_id = ${companionId}`;
    await integrationSql`
      delete from companion_transcript_entries
      where companion_id = ${companionId} and event_id = 'pi:1:tool:0'
    `;
  });

  it("lets a Viewer invoke only fail-closed timeout recovery under forced RLS", async () => {
    const running = JSON.stringify({
      call_id: "call-viewer-timeout",
      kind: "file",
      name: "read",
      title: "/tmp/conductor-cli.png",
      status: "running",
      detail: null,
      screenshot: null,
    });
    await integrationSql.begin(async (tx) => {
      await tx.unsafe(`set local role ${apiRole}`);
      await tx`select set_config('app.org_id', ${fixture.orgA}, true), set_config('app.user_id', ${fixture.owner.id}, true)`;
      await tx`
        insert into companion_workspace_access (
          org_id, companion_id, owner_id, role, granted_by
        ) values (
          ${fixture.orgA}, ${companionId}, ${fixture.owner.id}, 'viewer', ${fixture.owner.id}
        )
      `;
      await tx`
        insert into companion_transcript_entries (
          org_id, companion_id, event_id, ordinal, role, content, author_id, created_at, tool
        ) values
          (${fixture.orgA}, ${companionId}, 'viewer-timeout-user-1', 1, 'user', 'Read it', ${fixture.owner.id}, now() - interval '3 minutes', null),
          (${fixture.orgA}, ${companionId}, 'viewer-timeout-tool', 2, 'tool', '/tmp/conductor-cli.png', null, now() - interval '2 minutes', ${running}::jsonb),
          (${fixture.orgA}, ${companionId}, 'viewer-timeout-user-2', 3, 'user', 'Alors ?', ${fixture.owner.id}, now() - interval '1 minute', null),
          (${fixture.orgA}, ${companionId}, 'viewer-timeout-user-3', 4, 'user', 'Ca va ?', ${fixture.owner.id}, now() - interval '30 seconds', null)
      `;
      await tx`
        update companion_threads
        set next_ordinal = 5, delivered_ordinal = 4
        where companion_id = ${companionId}
      `;
    });

    const viewerRecovery = await integrationSql.begin(async (tx) => {
      await tx.unsafe(`set local role ${apiRole}`);
      await tx`select set_config('app.org_id', ${fixture.orgA}, true), set_config('app.user_id', ${fixture.admin.id}, true)`;
      const directWrite = await tx<Array<{ event_id: string }>>`
        update companion_transcript_entries
        set tool = jsonb_set(tool, '{status}', '"ok"')
        where companion_id = ${companionId} and event_id = 'viewer-timeout-tool'
        returning event_id
      `;
      const expired = await tx<Array<{ event_id: string; kind: string }>>`
        select * from companion_expire_tool_runs(${fixture.orgA}, ${companionId}, now(), 90, 600)
      `;
      const [state] = await tx<Array<{
        status: string;
        delivered_ordinal: number;
        timeout_recovery_ordinal: number;
      }>>`
        select e.tool->>'status' as status, t.delivered_ordinal, t.timeout_recovery_ordinal
        from companion_transcript_entries e
        join companion_threads t on t.companion_id = e.companion_id
        where e.companion_id = ${companionId} and e.event_id = 'viewer-timeout-tool'
      `;
      return { directWrite, expired, state };
    });
    expect(viewerRecovery.directWrite).toEqual([]);
    expect(viewerRecovery.expired).toEqual([{ event_id: "viewer-timeout-tool", kind: "file" }]);
    expect(viewerRecovery.state).toEqual({
      status: "timeout",
      delivered_ordinal: 1,
      timeout_recovery_ordinal: 2,
    });

    const crossTenant = await integrationSql.begin(async (tx) => {
      await tx.unsafe(`set local role ${apiRole}`);
      await tx`select set_config('app.org_id', ${fixture.orgB}, true), set_config('app.user_id', ${fixture.outsider.id}, true)`;
      return tx<Array<{ event_id: string }>>`
        select * from companion_expire_tool_runs(${fixture.orgA}, ${companionId}, now(), 90, 600)
      `;
    });
    expect(crossTenant).toEqual([]);

    await integrationSql`delete from companion_workspace_access where companion_id = ${companionId}`;
    await integrationSql`
      delete from companion_transcript_entries
      where companion_id = ${companionId} and event_id like 'viewer-timeout-%'
    `;
  });

  it("ensures the dropped per-member grant table cannot leak access", async () => {
    const [row] = await integrationSql<Array<{ exists: boolean }>>`
      select to_regclass('public.companion_member_access') is not null as exists
    `;
    expect(row?.exists).toBe(false);
  });

  it("lets admins manage provider ciphertext while members see metadata only within the tenant", async () => {
    await integrationSql.begin(async (tx) => {
      await tx.unsafe(`set local role ${apiRole}`);
      await tx`select set_config('app.org_id', ${fixture.orgA}, true), set_config('app.user_id', ${fixture.admin.id}, true)`;
      await tx`
        insert into companion_provider_connections (
          org_id, provider_id, auth_method, ciphertext, iv, auth_tag,
          wrapped_dek, wrap_iv, wrap_auth_tag, key_id, connected_by
        ) values (
          ${fixture.orgA}, 'anthropic', 'api_key', 'ciphertext', 'iv', 'tag',
          'dek', 'wrap-iv', 'wrap-tag', 'key-id', ${fixture.admin.id}
        )
      `;
    });

    const developerVisible = await integrationSql.begin(async (tx) => {
      await tx.unsafe(`set local role ${apiRole}`);
      await tx`select set_config('app.org_id', ${fixture.orgA}, true), set_config('app.user_id', ${fixture.developer.id}, true)`;
      return tx<Array<{ provider_id: string; auth_method: string }>>`
        select provider_id, auth_method from companion_provider_connections
      `;
    });
    expect(developerVisible).toEqual([{ provider_id: "anthropic", auth_method: "api_key" }]);

    await expect(integrationSql.begin(async (tx) => {
      await tx.unsafe(`set local role ${apiRole}`);
      await tx`select set_config('app.org_id', ${fixture.orgA}, true), set_config('app.user_id', ${fixture.developer.id}, true)`;
      await tx`
        insert into companion_provider_connections (
          org_id, provider_id, auth_method, ciphertext, iv, auth_tag,
          wrapped_dek, wrap_iv, wrap_auth_tag, key_id, connected_by
        ) values (
          ${fixture.orgA}, 'zai', 'api_key', 'ciphertext', 'iv', 'tag',
          'dek', 'wrap-iv', 'wrap-tag', 'key-id', ${fixture.developer.id}
        )
      `;
    })).rejects.toThrow();

    const outsiderVisible = await integrationSql.begin(async (tx) => {
      await tx.unsafe(`set local role ${apiRole}`);
      await tx`select set_config('app.org_id', ${fixture.orgB}, true), set_config('app.user_id', ${fixture.outsider.id}, true)`;
      return tx<Array<{ provider_id: string }>>`select provider_id from companion_provider_connections`;
    });
    expect(outsiderVisible).toEqual([]);
  });

  it("enforces owner-only workspace share management", async () => {
    const ownerInput = {
      actor: fixture.owner,
      orgId: fixture.orgA,
      companionId,
    };
    const shared = await withTenantContext(
      { orgId: fixture.orgA, userId: fixture.owner.id },
      (database) => setCompanionWorkspaceShare({
        ...ownerInput,
        role: "editor",
        database,
      }),
    );
    expect(shared).toEqual({ companion_id: companionId, workspace_role: "editor" });

    const listed = await withTenantContext(
      { orgId: fixture.orgA, userId: fixture.owner.id },
      (database) => listCompanionShares({ ...ownerInput, database }),
    );
    expect(listed).toEqual({ companion_id: companionId, workspace_role: "editor" });
    // The workspace-only share payload carries no per-member list.
    expect("members" in listed).toBe(false);

    // A non-owner member cannot read or manage sharing, even with workspace Editor access.
    await expect(withTenantContext(
      { orgId: fixture.orgA, userId: fixture.admin.id },
      (database) => listCompanionShares({
        actor: fixture.admin,
        orgId: fixture.orgA,
        companionId,
        database,
      }),
    )).rejects.toBeInstanceOf(CompanionShareForbiddenError);

    await expect(withTenantContext(
      { orgId: fixture.orgB, userId: fixture.outsider.id },
      (database) => listCompanionShares({
        actor: fixture.outsider,
        orgId: fixture.orgB,
        companionId,
        database,
      }),
    )).rejects.toBeInstanceOf(CompanionNotFoundError);

    const revoked = await withTenantContext(
      { orgId: fixture.orgA, userId: fixture.owner.id },
      (database) => setCompanionWorkspaceShare({ ...ownerInput, role: null, database }),
    );
    expect(revoked).toEqual({ companion_id: companionId, workspace_role: null });
  });

  it("CAS-claims lifecycle transitions and keeps live observations from clobbering them", async () => {
    await integrationSql`
      update companions
      set box_id = 'bx_23456789', runtime_state = 'stopped', daemon_state = 'stopped'
      where id = ${companionId}
    `;
    const input = {
      actor: fixture.owner,
      orgId: fixture.orgA,
      companionId,
    };

    const started = await withTenantContext(
      { orgId: fixture.orgA, userId: fixture.owner.id },
      (database) => claimCompanionRuntimeStart({ ...input, database }),
    );
    expect(started.runtime.state).toBe("provisioning");
    await expect(withTenantContext(
      { orgId: fixture.orgA, userId: fixture.owner.id },
      (database) => claimCompanionRuntimeStart({ ...input, database }),
    )).rejects.toBeInstanceOf(CompanionRuntimeTransitionError);

    const observed = await withTenantContext(
      { orgId: fixture.orgA, userId: fixture.owner.id },
      (database) => updateCompanionObservation({
        ...input,
        patch: {
          runtimeState: "stopped",
          daemonState: "stopped",
          desktopAvailable: false,
          observedAt: new Date(),
        },
        database,
      }),
    );
    expect(observed.runtime.state).toBe("provisioning");

    await integrationSql`
      update companions set runtime_state = 'running', daemon_state = 'running'
      where id = ${companionId}
    `;
    const stopped = await withTenantContext(
      { orgId: fixture.orgA, userId: fixture.owner.id },
      (database) => claimCompanionRuntimeStop({ ...input, database }),
    );
    expect(stopped.runtime.state).toBe("stopping");
    await expect(withTenantContext(
      { orgId: fixture.orgA, userId: fixture.owner.id },
      (database) => claimCompanionRuntimeStop({ ...input, database }),
    )).rejects.toBeInstanceOf(CompanionRuntimeTransitionError);
  });

  it("only rewinds the Pi log offset when Pi's log itself rewound", async () => {
    const project = (piLogOffset: number, piLogRewound?: boolean) => withTenantContext(
      { orgId: fixture.orgA, userId: fixture.owner.id },
      (database) => recordCompanionPiProjection({
        actor: fixture.owner,
        orgId: fixture.orgA,
        companionId,
        entries: [],
        piLogOffset,
        piLogRewound,
        database,
      }),
    );
    const storedOffset = async () => {
      const [row] = await integrationSql<Array<{ pi_log_offset: string }>>`
        select pi_log_offset from companion_threads where companion_id = ${companionId}
      `;
      return Number(row?.pi_log_offset);
    };

    await project(4096);
    // A slower overlapping sync read less of the log; it must not make the next sync reproject it.
    await project(512);
    expect(await storedOffset()).toBe(4096);

    // A restarted Box truncates the log, so that read owns the offset and replays from the start.
    await project(128, true);
    expect(await storedOffset()).toBe(128);
  });
});
