import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  COMPANION_RUNTIME_ERROR_VIEWER_MESSAGE,
  COMPANION_RUNTIME_START_BUDGET_MS,
  CompanionRuntimeTransitionError,
  claimCompanionRuntimeStart,
  getCompanion,
  updateCompanionObservation,
  updateCompanionRuntime,
} from "@companion/core";
import { withTenantContext } from "@companion/db";
import { createIntegrationFixture, integrationSql, type IntegrationFixture } from "./testDatabase";

/**
 * Product promise: a Companion in `error` explains itself. The Owner and Editor read the reason the
 * failed lifecycle attempt recorded, a Viewer reads only a generic unavailable line, and no
 * credential material is stored or returned.
 *
 * Regression caught: dropping the stored reason (leaving a bare red status), leaking an operator
 * configuration hint to a Viewer, or keeping a stale reason after a retry recovers.
 *
 * Why integrated: the reason has to survive the write, the row, and the authorized read, so a
 * mocked query builder cannot prove it.
 *
 * Failure proof: returning `row.lastError` regardless of access makes the Viewer read the missing
 * `COMPANION_BOX_API_KEY` hint; skipping the clear on claim keeps the reason after a retry starts.
 */
describe("Companion runtime error reporting", () => {
  let fixture: IntegrationFixture;
  const companionId = randomUUID();
  const failure = "Box runtime is not configured; set COMPANION_BOX_API_KEY";

  const asOwner = <T>(fn: (database: Parameters<Parameters<typeof withTenantContext>[1]>[0]) => Promise<T>) =>
    withTenantContext({ orgId: fixture.orgA, userId: fixture.owner.id }, fn);

  const recordFailure = (lastError: string) => asOwner((database) => updateCompanionRuntime({
    actor: fixture.owner,
    orgId: fixture.orgA,
    companionId,
    patch: {
      runtimeState: "error",
      daemonState: "error",
      lastError,
      observedAt: new Date(),
    },
    database,
  }));

  const storedError = async () => {
    const [row] = await integrationSql<Array<{ last_error: string | null }>>`
      select last_error from companions where id = ${companionId}
    `;
    return row?.last_error ?? null;
  };

  beforeAll(async () => {
    fixture = await createIntegrationFixture();
    await integrationSql`
      insert into companions (id, org_id, owner_id, name)
      values (${companionId}, ${fixture.orgA}, ${fixture.owner.id}, 'Runtime error companion')
    `;
    // Workspace-only sharing (THE-329): a Viewer grant applies to every member, so the developer
    // reads the Companion as a Viewer.
    await integrationSql`
      insert into companion_workspace_access (org_id, companion_id, owner_id, role, granted_by)
      values (
        ${fixture.orgA}, ${companionId}, ${fixture.owner.id}, 'viewer', ${fixture.owner.id}
      )
    `;
  });

  afterAll(async () => {
    await integrationSql`delete from companions where id = ${companionId}`;
    await fixture.cleanup();
  });

  it("keeps the recorded reason for the Owner and hides it from a Viewer", async () => {
    const recorded = await recordFailure(failure);
    expect(recorded.runtime.state).toBe("error");
    expect(recorded.runtime.last_error).toBe(failure);

    const viewerRead = await withTenantContext(
      { orgId: fixture.orgA, userId: fixture.developer.id },
      (database) => getCompanion({
        actor: fixture.developer,
        orgId: fixture.orgA,
        companionId,
        database,
      }),
    );

    expect(viewerRead.access).toBe("viewer");
    expect(viewerRead.runtime.state).toBe("error");
    expect(viewerRead.runtime.last_error).toBe(COMPANION_RUNTIME_ERROR_VIEWER_MESSAGE);
    expect(viewerRead.runtime.last_error).not.toContain("COMPANION_BOX_API_KEY");
  });

  it("stores a credential-shaped Box message without its credential", async () => {
    const recorded = await recordFailure(
      "Box rejected the request: authorization: Bearer abcdef0123456789abcdef0123456789",
    );

    expect(await storedError()).toBe("Box rejected the request: authorization: [redacted]");
    expect(recorded.runtime.last_error).not.toContain("abcdef0123456789");
  });

  it("clears the reason as soon as a retry claims the start", async () => {
    await recordFailure(failure);

    const claimed = await asOwner((database) => claimCompanionRuntimeStart({
      actor: fixture.owner,
      orgId: fixture.orgA,
      companionId,
      database,
    }));

    expect(claimed.runtime.state).toBe("provisioning");
    expect(claimed.runtime.last_error).toBeNull();
    expect(await storedError()).toBeNull();
  });

  /**
   * THE-340: a wake that dies without writing anything leaves its `provisioning` claim behind, and
   * the Companion reads as Starting until that claim may be taken. The window is the wake's own start
   * budget plus the room a live wake needs to record its failure on the way out, so a claim younger
   * than the budget still belongs to whoever holds it and an older one belongs to nobody.
   */
  it.each([
    ["refuses a claim a live wake could still be inside", COMPANION_RUNTIME_START_BUDGET_MS - 30_000],
    ["takes over a claim no live wake can still be holding", COMPANION_RUNTIME_START_BUDGET_MS + 60_000],
  ])("%s", async (_case, age) => {
    await integrationSql`
      update companions
      set runtime_state = 'provisioning',
          daemon_state = 'starting',
          last_error = null,
          updated_at = ${new Date(Date.now() - age).toISOString()}
      where id = ${companionId}
    `;

    const claim = asOwner((database) => claimCompanionRuntimeStart({
      actor: fixture.owner,
      orgId: fixture.orgA,
      companionId,
      database,
    }));

    if (age < COMPANION_RUNTIME_START_BUDGET_MS) {
      await expect(claim).rejects.toBeInstanceOf(CompanionRuntimeTransitionError);
      return;
    }
    await expect(claim).resolves.toMatchObject({
      runtime: expect.objectContaining({ state: "provisioning", daemon_state: "starting" }),
    });
  });

  it("clears the reason when a live observation finds the Box healthy", async () => {
    await integrationSql`
      update companions set runtime_state = 'error', daemon_state = 'error', last_error = ${failure}
      where id = ${companionId}
    `;

    const observed = await asOwner((database) => updateCompanionObservation({
      actor: fixture.owner,
      orgId: fixture.orgA,
      companionId,
      patch: {
        runtimeState: "running",
        daemonState: "running",
        desktopAvailable: false,
        observedAt: new Date(),
      },
      database,
    }));

    expect(observed.runtime.state).toBe("running");
    expect(observed.runtime.last_error).toBeNull();
    expect(await storedError()).toBeNull();
  });
});
