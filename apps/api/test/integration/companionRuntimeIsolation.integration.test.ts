import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CompanionRuntimeForbiddenError,
  claimCompanionRuntimeStart,
  getCompanion,
  getCompanionForRuntime,
  updateCompanionRuntime,
} from "@companion/core";
import { withTenantContext } from "@companion/db";
import { integrationSql, type TestActor } from "./testDatabase";

/**
 * Product promise (THE-332): the Box is a per-Companion resource again — 1 Companion = 1 Box = 1 Pi.
 * Two Companions in the same workspace wake onto two distinct Boxes, waking one never touches the
 * other's runtime row, and a Viewer reads the chip's state without ever receiving the Box id or being
 * allowed onto a Box-touching path. This inverts the THE-330 shared workspace pool.
 *
 * Why integrated: per-Companion `box_id`, the runtime UPDATE policy, and the Viewer read-model
 * boundary are database facts; a mocked query builder cannot prove one wake leaves a sibling's row
 * untouched or that two Companions hold two Box ids.
 */
describe("Companion per-Companion runtime isolation", () => {
  const suffix = randomUUID();
  const owner: TestActor = actor("iso-owner", suffix);
  const member: TestActor = actor("iso-member", suffix);
  const org = randomUUID();
  const companionA = randomUUID();
  const companionB = randomUUID();

  const asActorIn = <T>(
    userId: string,
    fn: (database: Parameters<Parameters<typeof withTenantContext>[1]>[0]) => Promise<T>,
  ) => withTenantContext({ orgId: org, userId }, fn);

  beforeAll(async () => {
    for (const value of [owner, member]) {
      await integrationSql`
        insert into "user" (id, name, email, email_verified)
        values (${value.id}, ${value.name}, ${value.email}, true)
      `;
      await integrationSql`
        insert into profiles (id, name, email, initials, onboarded_at)
        values (${value.id}, ${value.name}, ${value.email}, 'IS', now())
      `;
    }
    await integrationSql`
      insert into organizations (id, name, slug, kind)
      values (${org}, 'Isolation org', ${`iso-org-${suffix}`}, 'team')
    `;
    await integrationSql`
      insert into memberships (org_id, user_id, org_role) values
        (${org}, ${owner.id}, 'owner'),
        (${org}, ${member.id}, 'developer')
    `;
    await integrationSql`
      insert into companions (id, org_id, owner_id, name) values
        (${companionA}, ${org}, ${owner.id}, 'Companion A'),
        (${companionB}, ${org}, ${owner.id}, 'Companion B')
    `;
  });

  afterAll(async () => {
    await integrationSql`delete from companions where org_id = ${org}`;
    await integrationSql`delete from organizations where id = ${org}`;
    await integrationSql`delete from "user" where id in (${owner.id}, ${member.id})`;
  });

  it("wakes two Companions onto two distinct Boxes and never mutates a sibling's runtime", async () => {
    // Wake A onto its own Box; B has never woken and stays untouched.
    await asActorIn(owner.id, (database) =>
      claimCompanionRuntimeStart({ actor: owner, orgId: org, companionId: companionA, database }));
    const wokeA = await asActorIn(owner.id, (database) =>
      updateCompanionRuntime({
        actor: owner,
        orgId: org,
        companionId: companionA,
        patch: {
          boxId: "bx_23456789",
          runtimeState: "running",
          daemonState: "running",
          startedAt: new Date(),
        },
        database,
      }));
    expect(wokeA.runtime.box_id).toBe("bx_23456789");
    expect(wokeA.runtime.state).toBe("running");

    // B is a separate machine: it has no Box and reads `not_created` even though A is running.
    const siblingB = await asActorIn(owner.id, (database) =>
      getCompanion({ actor: owner, orgId: org, companionId: companionB, database }));
    expect(siblingB.runtime.box_id).toBeNull();
    expect(siblingB.runtime.state).toBe("not_created");

    // Wake B onto a second, distinct Box.
    await asActorIn(owner.id, (database) =>
      claimCompanionRuntimeStart({ actor: owner, orgId: org, companionId: companionB, database }));
    const wokeB = await asActorIn(owner.id, (database) =>
      updateCompanionRuntime({
        actor: owner,
        orgId: org,
        companionId: companionB,
        patch: {
          boxId: "bx_abcdefgh",
          runtimeState: "running",
          daemonState: "running",
          startedAt: new Date(),
        },
        database,
      }));
    expect(wokeB.runtime.box_id).toBe("bx_abcdefgh");

    // Two Companions, two distinct Box ids; A is unchanged by B's wake.
    const [chipA, chipB] = await Promise.all([
      asActorIn(owner.id, (database) =>
        getCompanion({ actor: owner, orgId: org, companionId: companionA, database })),
      asActorIn(owner.id, (database) =>
        getCompanion({ actor: owner, orgId: org, companionId: companionB, database })),
    ]);
    expect(chipA.runtime.box_id).toBe("bx_23456789");
    expect(chipB.runtime.box_id).toBe("bx_abcdefgh");
    expect(chipA.runtime.box_id).not.toBe(chipB.runtime.box_id);

    // Each Companion backs exactly its own runtime row: no shared pool row fans out between them.
    const [poolRow] = await integrationSql<Array<{ count: string }>>`
      select count(*)::int as count from companion_runtime_pools where org_id = ${org}
    `;
    expect(Number(poolRow?.count ?? 0)).toBe(0);
  });

  it("shows a Viewer the chip state but never the Box, and refuses to let them wake it", async () => {
    // Workspace-only Viewer grant (THE-329): every member reads Companion A as a Viewer.
    await integrationSql`
      insert into companion_workspace_access (org_id, companion_id, owner_id, role, granted_by)
      values (${org}, ${companionA}, ${owner.id}, 'viewer', ${owner.id})
    `;
    const viewer = await asActorIn(member.id, (database) =>
      getCompanion({ actor: member, orgId: org, companionId: companionA, database }));
    expect(viewer.access).toBe("viewer");
    // The read-model gives the state but withholds the Box id and desktop flag from a Viewer.
    expect(viewer.runtime.state).toBe("running");
    expect(viewer.runtime.box_id).toBeNull();
    expect(viewer.runtime.desktop_available).toBe(false);
    // A Viewer cannot enter any Box-touching path: the runtime gate rejects them before a wake.
    await expect(asActorIn(member.id, (database) =>
      getCompanionForRuntime({ actor: member, orgId: org, companionId: companionA, database }),
    )).rejects.toBeInstanceOf(CompanionRuntimeForbiddenError);
  });

  it("clears one Companion's shared Box id on its own wake and leaves the other's row alone", async () => {
    // The state the runtime restore produced in production: both Companions in the workspace record
    // the one Box a THE-330 pool owned. The adapter refuses to adopt it and the wake records the Box
    // this Companion does own instead, which has to be a write to exactly one row.
    const pooled = "bx_5neg83t4";
    await integrationSql`
      update companions set box_id = ${pooled}, runtime_state = 'running', daemon_state = 'running'
      where org_id = ${org}
    `;

    await asActorIn(owner.id, (database) =>
      claimCompanionRuntimeStart({ actor: owner, orgId: org, companionId: companionA, database }));
    // The adapter's cleared assignment, then the Box it created for this Companion alone.
    for (const boxId of [null, "bx_23456789"]) {
      await asActorIn(owner.id, (database) =>
        updateCompanionRuntime({
          actor: owner,
          orgId: org,
          companionId: companionA,
          patch: { boxId, runtimeState: "provisioning", daemonState: "starting" },
          database,
        }));
    }

    const [chipA, chipB] = await Promise.all([
      asActorIn(owner.id, (database) =>
        getCompanion({ actor: owner, orgId: org, companionId: companionA, database })),
      asActorIn(owner.id, (database) =>
        getCompanion({ actor: owner, orgId: org, companionId: companionB, database })),
    ]);
    expect(chipA.runtime.box_id).toBe("bx_23456789");
    // B is still pointing at the shared id its own wake will clear; A's wake did not touch it.
    expect(chipB.runtime.box_id).toBe(pooled);
    expect(chipB.runtime.state).toBe("running");
  });
});

function actor(prefix: string, suffix: string): TestActor {
  return {
    id: `${prefix}-${suffix}`,
    email: `${prefix}-${suffix}@example.test`,
    name: "Isolation Person",
  };
}
