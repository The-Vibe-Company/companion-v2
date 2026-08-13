import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CompanionRuntimeForbiddenError,
  claimCompanionRuntimeStart,
  claimCompanionRuntimeStop,
  getCompanion,
  getCompanionForRuntime,
  listCompanions,
  resolveCompanionBoxScope,
  sendCompanionMessage,
  updateCompanionRuntime,
} from "@companion/core";
import { withTenantContext } from "@companion/db";
import { integrationDb, integrationSql, type TestActor } from "./testDatabase";

/**
 * Product promise (THE-330): the Box is a workspace resource. Every personal Companion of a user
 * shares one Box; every Companion of a team organization shares one org Box. A Wake starts the
 * shared machine for the whole scope, a Stop stops it for everyone, the chip is identical across the
 * scope, and a Viewer reads that chip without ever contacting or waking the Box. Threads stay 1:1.
 *
 * Why integrated: the shared pool, its uniqueness per scope, and the projection onto every Companion
 * in the scope are database facts; a mocked query builder cannot prove one Box id fans out to two
 * Companions or that a personal pool and an org pool never collide.
 */
describe("Companion shared runtime pool", () => {
  const suffix = randomUUID();
  const owner: TestActor = actor("pool-owner", suffix);
  const member: TestActor = actor("pool-member", suffix);
  const personalOrg = randomUUID();
  const teamOrg = randomUUID();
  const personalA = randomUUID();
  const personalB = randomUUID();
  const orgA = randomUUID();
  const orgB = randomUUID();

  const asOwnerIn = <T>(
    orgId: string,
    fn: (database: Parameters<Parameters<typeof withTenantContext>[1]>[0]) => Promise<T>,
  ) => withTenantContext({ orgId, userId: owner.id }, fn);

  const poolCount = async (orgId: string) => {
    const [row] = await integrationSql<Array<{ count: string }>>`
      select count(*)::int as count from companion_runtime_pools where org_id = ${orgId}
    `;
    return Number(row?.count ?? 0);
  };

  beforeAll(async () => {
    for (const value of [owner, member]) {
      await integrationSql`
        insert into "user" (id, name, email, email_verified)
        values (${value.id}, ${value.name}, ${value.email}, true)
      `;
      await integrationSql`
        insert into profiles (id, name, email, initials, onboarded_at)
        values (${value.id}, ${value.name}, ${value.email}, 'PO', now())
      `;
    }
    // A personal workspace (one Box per user) and a team workspace (one Box shared by every member).
    await integrationSql`
      insert into organizations (id, name, slug, kind)
      values (${personalOrg}, 'Personal pool', ${`personal-pool-${suffix}`}, 'personal')
    `;
    await integrationSql`
      insert into organizations (id, name, slug, kind)
      values (${teamOrg}, 'Team pool', ${`team-pool-${suffix}`}, 'team')
    `;
    await integrationSql`
      insert into memberships (org_id, user_id, org_role) values
        (${personalOrg}, ${owner.id}, 'owner'),
        (${teamOrg}, ${owner.id}, 'owner'),
        (${teamOrg}, ${member.id}, 'developer')
    `;
    await integrationSql`
      insert into companions (id, org_id, owner_id, name) values
        (${personalA}, ${personalOrg}, ${owner.id}, 'Personal A'),
        (${personalB}, ${personalOrg}, ${owner.id}, 'Personal B'),
        (${orgA}, ${teamOrg}, ${owner.id}, 'Org A'),
        (${orgB}, ${teamOrg}, ${member.id}, 'Org B')
    `;
  });

  afterAll(async () => {
    await integrationSql`delete from companions where org_id in (${personalOrg}, ${teamOrg})`;
    await integrationSql`delete from organizations where id in (${personalOrg}, ${teamOrg})`;
    await integrationSql`delete from "user" where id in (${owner.id}, ${member.id})`;
  });

  it("wakes two personal Companions onto one Box while their threads stay separate", async () => {
    // Both Companions resolve to the same deterministic personal Box name, never a per-Companion one.
    const [scopeA, scopeB] = await Promise.all([
      resolveCompanionBoxScope({ orgId: personalOrg, companionId: personalA, database: integrationDb }),
      resolveCompanionBoxScope({ orgId: personalOrg, companionId: personalB, database: integrationDb }),
    ]);
    expect(scopeA.boxName).toBe(`Companion personal ${owner.id}`);
    expect(scopeB.boxName).toBe(scopeA.boxName);

    // Waking Companion A starts the shared machine; recording its Box id is a scope-level fact.
    const started = await asOwnerIn(personalOrg, (database) =>
      claimCompanionRuntimeStart({ actor: owner, orgId: personalOrg, companionId: personalA, database }));
    expect(started.runtime.state).toBe("provisioning");
    const woke = await asOwnerIn(personalOrg, (database) =>
      updateCompanionRuntime({
        actor: owner,
        orgId: personalOrg,
        companionId: personalA,
        patch: {
          boxId: "bx_23456789",
          runtimeState: "running",
          daemonState: "running",
          startedAt: new Date(),
        },
        database,
      }));
    expect(woke.runtime.box_id).toBe("bx_23456789");

    // Companion B never woke, yet it projects the very same Box and running chip.
    const siblingChip = await asOwnerIn(personalOrg, (database) =>
      getCompanion({ actor: owner, orgId: personalOrg, companionId: personalB, database }));
    expect(siblingChip.runtime.box_id).toBe("bx_23456789");
    expect(siblingChip.runtime.state).toBe("running");
    // One Wake for the whole scope: exactly one pool row backs both Companions.
    expect(await poolCount(personalOrg)).toBe(1);

    // Threads remain 1:1 per Companion even though the compute is shared.
    await asOwnerIn(personalOrg, (database) =>
      sendCompanionMessage({ actor: owner, orgId: personalOrg, companionId: personalA, content: "hi A", database }));
    await asOwnerIn(personalOrg, (database) =>
      sendCompanionMessage({ actor: owner, orgId: personalOrg, companionId: personalB, content: "hi B", database }));
    const threads = await integrationSql<Array<{ companion_id: string }>>`
      select companion_id from companion_threads where org_id = ${personalOrg} order by companion_id
    `;
    expect(threads.map((row) => row.companion_id).sort()).toEqual([personalA, personalB].sort());
  });

  it("shares one org Box across the team, distinct from any personal Box", async () => {
    const scope = await resolveCompanionBoxScope({
      orgId: teamOrg,
      companionId: orgA,
      database: integrationDb,
    });
    expect(scope.boxName).toBe(`Companion org ${teamOrg}`);
    expect(scope.boxName).not.toBe(`Companion personal ${owner.id}`);

    await asOwnerIn(teamOrg, (database) =>
      claimCompanionRuntimeStart({ actor: owner, orgId: teamOrg, companionId: orgA, database }));
    await asOwnerIn(teamOrg, (database) =>
      updateCompanionRuntime({
        actor: owner,
        orgId: teamOrg,
        companionId: orgA,
        patch: { boxId: "bx_abcdefgh", runtimeState: "running", daemonState: "running" },
        database,
      }));

    // A different member reads the same org Box off their own Companion in the workspace.
    const memberChip = await withTenantContext(
      { orgId: teamOrg, userId: member.id },
      (database) => getCompanion({ actor: member, orgId: teamOrg, companionId: orgB, database }),
    );
    expect(memberChip.runtime.box_id).toBe("bx_abcdefgh");
    expect(memberChip.runtime.state).toBe("running");
    // The org Box is a different machine from the personal Box, and the org has exactly one pool.
    expect(memberChip.runtime.box_id).not.toBe("bx_23456789");
    expect(await poolCount(teamOrg)).toBe(1);
    const [poolScope] = await integrationSql<Array<{ scope: string; owner_id: string | null }>>`
      select scope, owner_id from companion_runtime_pools where org_id = ${teamOrg}
    `;
    expect(poolScope).toEqual({ scope: "org", owner_id: null });
  });

  it("lists a never-woken Companion on the Box its workspace already runs", async () => {
    // The list is what the Companions surface renders from, so a Companion nobody woke has to arrive
    // already carrying the shared chip; anything else has to be repaired by a second wake.
    const listed = await withTenantContext(
      { orgId: teamOrg, userId: member.id },
      (database) => listCompanions({ actor: member, orgId: teamOrg, database }),
    );
    const sibling = listed.find((companion) => companion.id === orgB);
    expect(sibling?.runtime.box_id).toBe("bx_abcdefgh");
    expect(sibling?.runtime.state).toBe("running");
    // Reading the chip never claims a pool of its own: the workspace still has exactly one Box.
    expect(await poolCount(teamOrg)).toBe(1);
  });

  it("stops the shared machine for the whole scope, not one Companion", async () => {
    // A member stops the Box off their own Companion; the owner's Companion reads the same stop.
    const stopped = await withTenantContext(
      { orgId: teamOrg, userId: member.id },
      (database) => claimCompanionRuntimeStop({ actor: member, orgId: teamOrg, companionId: orgB, database }),
    );
    expect(stopped.runtime.state).toBe("stopping");
    const ownerChip = await asOwnerIn(teamOrg, (database) =>
      getCompanion({ actor: owner, orgId: teamOrg, companionId: orgA, database }));
    expect(ownerChip.runtime.state).toBe("stopping");
  });

  it("shows a Viewer the shared chip but never the Box, and refuses to let them wake it", async () => {
    // Grant the whole workspace Viewer access to the owner's Companion so the member can read it.
    await integrationSql`
      insert into companion_workspace_access (org_id, companion_id, owner_id, role, granted_by)
      values (${teamOrg}, ${orgA}, ${owner.id}, 'viewer', ${owner.id})
    `;
    const viewer = await withTenantContext(
      { orgId: teamOrg, userId: member.id },
      (database) => getCompanion({ actor: member, orgId: teamOrg, companionId: orgA, database }),
    );
    expect(viewer.access).toBe("viewer");
    // The read-model gives the state but withholds the Box id and desktop flag from a Viewer.
    expect(viewer.runtime.box_id).toBeNull();
    expect(viewer.runtime.desktop_available).toBe(false);
    // A Viewer cannot enter any Box-touching path: the runtime gate rejects them before a wake.
    await expect(withTenantContext(
      { orgId: teamOrg, userId: member.id },
      (database) => getCompanionForRuntime({ actor: member, orgId: teamOrg, companionId: orgA, database }),
    )).rejects.toBeInstanceOf(CompanionRuntimeForbiddenError);

    // The same member's list holds a Companion they run and one they only watch. Both read the state
    // of the one shared Box, and only the one they run carries the Box itself.
    const listed = await withTenantContext(
      { orgId: teamOrg, userId: member.id },
      (database) => listCompanions({ actor: member, orgId: teamOrg, database }),
    );
    const watched = listed.find((companion) => companion.id === orgA);
    const own = listed.find((companion) => companion.id === orgB);
    expect(watched?.runtime.state).toBe(own?.runtime.state);
    expect(watched?.runtime.box_id).toBeNull();
    expect(own?.runtime.box_id).toBe("bx_abcdefgh");
  });
});

function actor(prefix: string, suffix: string): TestActor {
  return {
    id: `${prefix}-${suffix}`,
    email: `${prefix}-${suffix}@example.test`,
    name: "Pool Person",
  };
}
