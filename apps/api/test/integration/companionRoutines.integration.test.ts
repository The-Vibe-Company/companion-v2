import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  answerCompanionRoutineDecisionV2,
  claimDueCompanionRoutines,
  createCompanionRoutineV2,
  createCompanionV2,
  deleteCompanionRoutineV2,
  fireCompanionRoutine,
  failCompanionRoutineFire,
  listCompanionRoutinesV2,
  listCompanionRoutineRunsV2,
  getCompanionRoutineRunV2,
  listCompanionsV2,
  readCompanionThreadV2,
  routineFireMessageId,
  saveCompanionProvider,
  setCompanionWorkspaceShareV2,
  updateCompanionRoutineV2,
} from "@companion/core";
import { COMPANION_ROUTINE_MAX_PER_COMPANION } from "@companion/contracts";
import { schema, withTenantContext, type Db } from "@companion/db";
import {
  createIntegrationFixture,
  integrationDb,
  integrationSql,
  type IntegrationFixture,
  type TestActor,
} from "./testDatabase";

/**
 * Routines cross the same Drizzle boundary as every other control-plane write, and the worker
 * carries a claimed instant back through JavaScript before it fences the fire. Only a real database
 * proves the round trip: the raw SQL surface is covered elsewhere, but the parameter binding, the
 * stored precision of `next_fire_at`, and the masked transcript projection are only visible here.
 */
describe("Companion routines over the real database", () => {
  let fixture: IntegrationFixture;
  let companionId: string;
  const masterKey = Buffer.alloc(32, 71);

  async function asActor<T>(actor: TestActor, action: (database: Db) => Promise<T>): Promise<T> {
    return withTenantContext({ orgId: fixture.orgA, userId: actor.id }, action);
  }

  function draft(name: string, cron = "0 9 * * 1-5") {
    return { name, prompt: `Write the ${name} summary.`, cron, timezone: "UTC" };
  }

  async function seedRoutineProposal(input: {
    requestKey: string;
    proposal: {
      kind: "routine";
      name: string;
      prompt: string;
      cron: string;
      timezone: string;
    };
  }): Promise<void> {
    const turnId = randomUUID();
    const attemptId = randomUUID();
    const clientMessageId = randomUUID();
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    const decision = {
      request_id: input.requestKey,
      kind: "routine",
      name: "propose_routine",
      title: `Propose ${input.proposal.name}`,
      detail: "Create or update a scheduled routine.",
      status: "pending",
      answer: null,
      decided_by_id: null,
      decided_by_name: null,
      decided_at: null,
      expires_at: expiresAt.toISOString(),
      proposal: input.proposal,
    };

    await integrationSql`
      insert into companion_threads(org_id, companion_id, next_ordinal, last_message_at)
      values (${fixture.orgA}::uuid, ${companionId}::uuid, 3, now())
      on conflict (companion_id) do update
      set next_ordinal = greatest(companion_threads.next_ordinal, 3), updated_at = now()
    `;
    await integrationSql`
      insert into companion_transcript_entries(
        org_id, companion_id, event_id, ordinal, role, content, author_id
      ) values (
        ${fixture.orgA}::uuid, ${companionId}::uuid, ${`msg:${clientMessageId}`},
        0, 'user', 'Propose a routine', ${fixture.owner.id}
      )
    `;
    await integrationSql`
      insert into companion_turns (
        id, org_id, companion_id, client_message_id, message_event_id,
        queue_sequence, actor_id, client_surface, status,
        inactivity_deadline_at, absolute_deadline_at
      ) values (
        ${turnId}::uuid, ${fixture.orgA}::uuid, ${companionId}::uuid,
        ${clientMessageId}::uuid, ${`msg:${clientMessageId}`}, 1,
        ${fixture.owner.id}, 'native_mobile', 'needs_input',
        null, now() + interval '2 hours'
      )
    `;
    await integrationSql`
      insert into companion_turn_attempts (
        id, org_id, companion_id, turn_id, attempt_number, actor_id,
        runtime_generation, settings_revision, skills_revision, model_id,
        provider_ids, provider_credential_refs, selected_skill_ids,
        selected_mcp_account_ids, mcp_credential_refs,
        status, checkpoint, dispatch_state, command_id,
        dispatch_accepted_at, pi_invocation_id, last_activity_at
      ) values (
        ${attemptId}::uuid, ${fixture.orgA}::uuid, ${companionId}::uuid, ${turnId}::uuid,
        1, ${fixture.owner.id}, 1, 1, 1, 'claude-opus-4-8',
        ${JSON.stringify(["anthropic"])}::jsonb,
        ${JSON.stringify([{ provider_id: "anthropic", credential_generation: randomUUID(), credential_version: 1 }])}::jsonb,
        '[]'::jsonb, '[]'::jsonb, '[]'::jsonb,
        'needs_input', 'needs_input', 'accepted', ${randomUUID()}::uuid,
        now(), ${`pi-${attemptId}`}, now()
      )
    `;
    await integrationSql`
      insert into companion_decision_deliveries(
        org_id, companion_id, turn_id, attempt_id,
        request_key, request_kind, expires_at, proposal
      ) values (
        ${fixture.orgA}::uuid, ${companionId}::uuid, ${turnId}::uuid, ${attemptId}::uuid,
        ${input.requestKey}, 'routine_proposal', ${expiresAt.toISOString()},
        ${JSON.stringify(input.proposal)}::jsonb
      )
    `;
    await integrationSql`
      insert into companion_transcript_entries(
        org_id, companion_id, event_id, ordinal, role, content, decision
      ) values (
        ${fixture.orgA}::uuid, ${companionId}::uuid, ${`decision:${input.requestKey}`},
        1, 'decision', ${decision.title}, ${JSON.stringify(decision)}::jsonb
      )
    `;
  }

  beforeEach(async () => {
    fixture = await createIntegrationFixture();
    await saveCompanionProvider({
      actor: fixture.owner,
      orgId: fixture.orgA,
      providerId: "anthropic",
      authMethod: "api_key",
      credential: "integration-secret",
      masterKey,
      database: integrationDb,
    });
    const companion = await asActor(fixture.owner, (database) => createCompanionV2({
      actor: fixture.owner,
      orgId: fixture.orgA,
      name: "Routine runner",
      persona: "Runs scheduled prompts",
      providerId: "anthropic",
      modelId: "claude-opus-4-8",
      database,
    }));
    companionId = companion.id;
  });

  afterEach(async () => {
    await integrationDb.delete(schema.companions).where(eq(schema.companions.orgId, fixture.orgA));
    await fixture.cleanup();
  });

  afterAll(async () => {
    await integrationSql.end();
  });

  it("creates, lists, updates, and deletes a routine through the ordinary tenant boundary", async () => {
    const created = await asActor(fixture.owner, (database) => createCompanionRoutineV2({
      orgId: fixture.orgA,
      companionId,
      ...draft("Daily standup"),
      database,
    }));
    expect(created).toMatchObject({ name: "Daily standup", enabled: true, timezone: "UTC" });
    // A schedule that never crosses the boundary intact is the failure this suite exists for.
    expect(created.next_fire_at).not.toBeNull();
    expect(new Date(created.next_fire_at!).getTime()).toBeGreaterThan(Date.now());

    const listed = await asActor(fixture.owner, (database) => listCompanionRoutinesV2({
      orgId: fixture.orgA,
      companionId,
      database,
    }));
    expect(listed).toEqual([created]);

    const disabled = await asActor(fixture.owner, (database) => updateCompanionRoutineV2({
      orgId: fixture.orgA,
      companionId,
      routineId: created.id,
      enabled: false,
      database,
    }));
    expect(disabled).toMatchObject({ enabled: false, next_fire_at: null });

    const reenabled = await asActor(fixture.owner, (database) => updateCompanionRoutineV2({
      orgId: fixture.orgA,
      companionId,
      routineId: created.id,
      cron: "*/30 * * * *",
      enabled: true,
      database,
    }));
    expect(reenabled.cron).toBe("*/30 * * * *");
    expect(reenabled.next_fire_at).not.toBeNull();

    await asActor(fixture.owner, (database) => deleteCompanionRoutineV2({
      orgId: fixture.orgA,
      companionId,
      routineId: created.id,
      database,
    }));
    await expect(asActor(fixture.owner, (database) => listCompanionRoutinesV2({
      orgId: fixture.orgA,
      companionId,
      database,
    }))).resolves.toEqual([]);
  });

  it("approves a same-name proposal in place, resets failures, and returns the routine", async () => {
    const existing = await asActor(fixture.owner, (database) => createCompanionRoutineV2({
      orgId: fixture.orgA,
      companionId,
      ...draft("Daily standup"),
      database,
    }));
    const previousNextFireAt = existing.next_fire_at;
    await integrationDb
      .update(schema.companionRoutines)
      .set({
        lastErrorCode: "fire_failed",
        lastErrorMessage: "The previous run failed.",
        lastErrorAt: new Date(),
        consecutiveFailures: 4,
        nextFireAt: new Date(Date.now() - 1_000),
      })
      .where(eq(schema.companionRoutines.id, existing.id));
    const staleWorkerId = "routine-proposal-stale-worker";
    const [staleClaim] = await claimDueCompanionRoutines({
      workerId: staleWorkerId,
      database: integrationDb,
    });
    expect(staleClaim?.routineId).toBe(existing.id);
    const proposal = {
      kind: "routine" as const,
      name: "daily STANDUP",
      prompt: "Write the revised standup.",
      cron: "30 10 * * 1-5",
      timezone: "America/New_York",
    };
    const requestKey = randomUUID();
    await seedRoutineProposal({ requestKey, proposal });

    const approved = await asActor(fixture.owner, (database) =>
      answerCompanionRoutineDecisionV2({
        orgId: fixture.orgA,
        companionId,
        requestId: requestKey,
        decision: "allow",
        database,
      }));

    expect(approved).toMatchObject({
      id: existing.id,
      name: existing.name,
      prompt: proposal.prompt,
      cron: proposal.cron,
      timezone: proposal.timezone,
      enabled: true,
      last_error_code: null,
      last_error_message: null,
      last_error_at: null,
      consecutive_failures: 0,
    });
    expect(approved?.next_fire_at).not.toBe(previousNextFireAt);
    expect(new Date(approved!.next_fire_at!).getTime()).toBeGreaterThan(Date.now());

    const [claimState] = await integrationDb
      .select({
        claimedBy: schema.companionRoutines.claimedBy,
        leaseExpiresAt: schema.companionRoutines.leaseExpiresAt,
      })
      .from(schema.companionRoutines)
      .where(eq(schema.companionRoutines.id, existing.id));
    expect(claimState).toEqual({ claimedBy: null, leaseExpiresAt: null });

    await failCompanionRoutineFire({
      workerId: staleWorkerId,
      orgId: fixture.orgA,
      routineId: existing.id,
      errorCode: "fire_failed",
      errorMessage: "The stale worker must not settle.",
      nextFireAt: new Date(Date.now() + 2 * 60 * 60 * 1000),
      database: integrationDb,
    });

    const routines = await asActor(fixture.owner, (database) => listCompanionRoutinesV2({
      orgId: fixture.orgA,
      companionId,
      database,
    }));
    expect(routines).toHaveLength(1);
    expect(routines[0]).toMatchObject({
      id: existing.id,
      prompt: proposal.prompt,
      next_fire_at: approved!.next_fire_at,
      last_error_code: null,
      consecutive_failures: 0,
    });
    const [audit] = await integrationSql<{ action: string; target_id: string; mode: string }[]>`
      select action, target_id, metadata ->> 'mode' as mode
      from audit_log
      where org_id = ${fixture.orgA}::uuid
        and target_type = 'companion_routine'
        and target_id = ${existing.id}
        and action = 'companion.routine.proposal.approved'
      order by created_at desc
      limit 1
    `;
    expect(audit).toEqual({
      action: "companion.routine.proposal.approved",
      target_id: existing.id,
      mode: "updated",
    });
  });

  it("creates a fresh routine when the proposed same-name routine was deleted", async () => {
    const existing = await asActor(fixture.owner, (database) => createCompanionRoutineV2({
      orgId: fixture.orgA,
      companionId,
      ...draft("Daily standup"),
      database,
    }));
    const proposal = {
      kind: "routine" as const,
      name: "Daily standup",
      prompt: "Write a fresh standup.",
      cron: "45 11 * * 1-5",
      timezone: "UTC",
    };
    const requestKey = randomUUID();
    await seedRoutineProposal({ requestKey, proposal });
    await asActor(fixture.owner, (database) => deleteCompanionRoutineV2({
      orgId: fixture.orgA,
      companionId,
      routineId: existing.id,
      database,
    }));

    const approved = await asActor(fixture.owner, (database) =>
      answerCompanionRoutineDecisionV2({
        orgId: fixture.orgA,
        companionId,
        requestId: requestKey,
        decision: "allow",
        database,
      }));

    expect(approved).toMatchObject({
      prompt: proposal.prompt,
      cron: proposal.cron,
      timezone: proposal.timezone,
      enabled: true,
    });
    expect(approved?.id).toEqual(expect.any(String));
    expect(approved?.id).not.toBe(existing.id);
    await expect(asActor(fixture.owner, (database) => listCompanionRoutinesV2({
      orgId: fixture.orgA,
      companionId,
      database,
    }))).resolves.toEqual([approved]);
  });

  it("refuses an unschedulable cadence, a Viewer write, an outsider, and the eleventh routine", async () => {
    await expect(asActor(fixture.owner, (database) => createCompanionRoutineV2({
      orgId: fixture.orgA,
      companionId,
      ...draft("Too eager", "* * * * *"),
      database,
    }))).rejects.toMatchObject({ code: "interval_too_short" });
    await expect(asActor(fixture.owner, (database) => createCompanionRoutineV2({
      orgId: fixture.orgA,
      companionId,
      ...draft("Nowhere", "0 9 * * 1-5"),
      timezone: "Mars/Olympus",
      database,
    }))).rejects.toMatchObject({ code: "invalid_timezone" });

    await asActor(fixture.owner, (database) => setCompanionWorkspaceShareV2({
      actor: fixture.owner,
      orgId: fixture.orgA,
      companionId,
      role: "viewer",
      database,
    }));
    await expect(asActor(fixture.developer, (database) => createCompanionRoutineV2({
      orgId: fixture.orgA,
      companionId,
      ...draft("Viewer routine"),
      database,
    }))).rejects.toThrow();
    await expect(withTenantContext(
      { orgId: fixture.orgB, userId: fixture.outsider.id },
      (database) => listCompanionRoutinesV2({ orgId: fixture.orgB, companionId, database }),
    )).rejects.toThrow();

    for (let index = 0; index < COMPANION_ROUTINE_MAX_PER_COMPANION; index += 1) {
      await asActor(fixture.owner, (database) => createCompanionRoutineV2({
        orgId: fixture.orgA,
        companionId,
        ...draft(`Routine ${index}`),
        database,
      }));
    }
    await expect(asActor(fixture.owner, (database) => createCompanionRoutineV2({
      orgId: fixture.orgA,
      companionId,
      ...draft("One too many"),
      database,
    }))).rejects.toThrow();
  });

  it("claims a due routine, fires it once as the Owner, and hides the prompt behind its name", async () => {
    const created = await asActor(fixture.owner, (database) => createCompanionRoutineV2({
      orgId: fixture.orgA,
      companionId,
      ...draft("Daily standup"),
      database,
    }));
    await integrationDb
      .update(schema.companionRoutines)
      .set({ nextFireAt: new Date() })
      .where(eq(schema.companionRoutines.id, created.id));

    const claimed = await claimDueCompanionRoutines({
      workerId: "integration-routine-worker",
      database: integrationDb,
    });
    const claim = claimed.find((entry) => entry.routineId === created.id);
    expect(claim).toMatchObject({ orgId: fixture.orgA, companionId, name: "Daily standup" });

    const clientMessageId = routineFireMessageId({
      routineId: claim!.routineId,
      scheduledFor: claim!.scheduledFor,
    });
    const fired = await fireCompanionRoutine({
      workerId: "integration-routine-worker",
      orgId: fixture.orgA,
      routineId: created.id,
      clientMessageId,
      scheduledFor: claim!.scheduledFor,
      nextFireAt: new Date(Date.now() + 60 * 60 * 1000),
      database: integrationDb,
    });
    expect(fired).toEqual({ outcome: "fired", replayed: false });

    const thread = await asActor(fixture.owner, (database) => readCompanionThreadV2({
      actor: fixture.owner,
      orgId: fixture.orgA,
      companionId,
      database,
    }));
    const entry = thread.entries.find((candidate) => candidate.routine !== null);
    // The prompt stays durable; the projection is what lets the client show a routine header only.
    expect(entry).toMatchObject({
      role: "user",
      content: "Write the Daily standup summary.",
      routine: { id: created.id, name: "Daily standup", run_id: entry?.turn_id },
    });

    // The conversation list is read by everyone who can see the Companion, and the fire is recorded
    // as the Owner. Leaking the prompt there would read as something the Owner just typed.
    const [listed] = await asActor(fixture.owner, (database) => listCompanionsV2({
      actor: fixture.owner,
      orgId: fixture.orgA,
      database,
    }));
    expect(listed!.last_message).toMatchObject({
      role: "user",
      preview: "",
      routine_name: "Daily standup",
    });

    const [after] = await asActor(fixture.owner, (database) => listCompanionRoutinesV2({
      orgId: fixture.orgA,
      companionId,
      database,
    }));
    expect(after).toMatchObject({ consecutive_failures: 0, last_error_code: null });
    expect(after!.last_fired_at).not.toBeNull();
  });

  it("records a classified fire failure without persisting a provider payload", async () => {
    const created = await asActor(fixture.owner, (database) => createCompanionRoutineV2({
      orgId: fixture.orgA,
      companionId,
      ...draft("Flaky"),
      database,
    }));
    await integrationDb
      .update(schema.companionRoutines)
      .set({ nextFireAt: new Date() })
      .where(eq(schema.companionRoutines.id, created.id));
    await claimDueCompanionRoutines({
      workerId: "integration-routine-worker",
      database: integrationDb,
    });

    await failCompanionRoutineFire({
      workerId: "integration-routine-worker",
      orgId: fixture.orgA,
      routineId: created.id,
      errorCode: "fire_failed",
      errorMessage: "Companion routine fire failed",
      nextFireAt: new Date(Date.now() + 60 * 60 * 1000),
      database: integrationDb,
    });

    const [after] = await asActor(fixture.owner, (database) => listCompanionRoutinesV2({
      orgId: fixture.orgA,
      companionId,
      database,
    }));
    expect(after).toMatchObject({
      last_error_code: "fire_failed",
      last_error_message: "Companion routine fire failed",
      consecutive_failures: 1,
      enabled: true,
    });
  });

  it("atomically cancels queued routine turns on disable and delete, and rolls back the purge", async () => {
    const created = await asActor(fixture.owner, (database) => createCompanionRoutineV2({
      orgId: fixture.orgA,
      companionId,
      ...draft("Queue cleanup"),
      database,
    }));

    const fireQueued = async (workerId: string): Promise<string> => {
      await integrationDb
        .update(schema.companionRoutines)
        .set({ nextFireAt: new Date() })
        .where(eq(schema.companionRoutines.id, created.id));
      const [claim] = await claimDueCompanionRoutines({ workerId, database: integrationDb });
      if (!claim) throw new Error("expected the queue cleanup routine to become due");
      await fireCompanionRoutine({
        workerId,
        orgId: fixture.orgA,
        routineId: created.id,
        clientMessageId: routineFireMessageId({ routineId: created.id, scheduledFor: claim.scheduledFor }),
        scheduledFor: claim.scheduledFor,
        nextFireAt: new Date(Date.now() + 60 * 60 * 1000),
        database: integrationDb,
      });
      const [turn] = await integrationDb
        .select({ id: schema.companionTurns.id })
        .from(schema.companionTurns)
        .where(and(
          eq(schema.companionTurns.routineSnapshotId, created.id),
          eq(schema.companionTurns.status, "queued"),
        ))
        .orderBy(desc(schema.companionTurns.createdAt), desc(schema.companionTurns.id));
      if (!turn) throw new Error("expected a queued routine turn");
      return turn.id;
    };

    const disabledTurnId = await fireQueued("integration-routine-disable-cleanup");
    await expect(integrationSql.begin(async (tx) => {
      await tx`
        update companion_routines
        set enabled = false, next_fire_at = null
        where id = ${created.id}::uuid
      `;
      throw new Error("rollback routine disable");
    })).rejects.toThrow("rollback routine disable");

    const [afterRollback] = await integrationSql<Array<{ enabled: boolean }>>`
      select enabled from companion_routines where id = ${created.id}::uuid
    `;
    expect(afterRollback).toEqual({ enabled: true });
    const [queuedAfterRollback] = await integrationSql<Array<{ status: string }>>`
      select status::text as status from companion_turns where id = ${disabledTurnId}::uuid
    `;
    expect(queuedAfterRollback).toEqual({ status: "queued" });
    const [startAfterRollback] = await integrationSql<Array<{ status: string }>>`
      select status::text as status from companion_operations
      where source_turn_id = ${disabledTurnId}::uuid and kind = 'start'
    `;
    expect(startAfterRollback).toEqual({ status: "pending" });

    await asActor(fixture.owner, (database) => updateCompanionRoutineV2({
      orgId: fixture.orgA,
      companionId,
      routineId: created.id,
      enabled: false,
      database,
    }));
    const [disabledTurn] = await integrationSql<Array<{
      status: string;
      errorCode: string | null;
      errorMessage: string | null;
      errorAction: string | null;
    }>>`
      select status::text as status, last_error_code as "errorCode",
        last_error_message as "errorMessage", last_error_action::text as "errorAction"
      from companion_turns where id = ${disabledTurnId}::uuid
    `;
    expect(disabledTurn).toEqual({
      status: "cancelled",
      errorCode: "routine_disabled",
      errorMessage: "This scheduled run was skipped because the routine was disabled.",
      errorAction: "none",
    });
    const [disabledStart] = await integrationSql<Array<{ status: string }>>`
      select status::text as status from companion_operations
      where source_turn_id = ${disabledTurnId}::uuid and kind = 'start'
    `;
    expect(disabledStart).toEqual({ status: "cancelled" });
    const [disabledRoutine] = await integrationDb
      .select({ failures: schema.companionRoutines.consecutiveFailures })
      .from(schema.companionRoutines)
      .where(eq(schema.companionRoutines.id, created.id));
    expect(disabledRoutine?.failures).toBe(0);

    await asActor(fixture.owner, (database) => updateCompanionRoutineV2({
      orgId: fixture.orgA,
      companionId,
      routineId: created.id,
      enabled: true,
      database,
    }));
    const deletedTurnId = await fireQueued("integration-routine-delete-cleanup");
    await asActor(fixture.owner, (database) => deleteCompanionRoutineV2({
      orgId: fixture.orgA,
      companionId,
      routineId: created.id,
      database,
    }));

    const [deletedTurn] = await integrationSql<Array<{
      status: string;
      routineId: string | null;
      routineName: string | null;
      errorCode: string | null;
      errorMessage: string | null;
      errorAction: string | null;
    }>>`
      select status::text as status, routine_id::text as "routineId", routine_name as "routineName",
        last_error_code as "errorCode", last_error_message as "errorMessage",
        last_error_action::text as "errorAction"
      from companion_turns where id = ${deletedTurnId}::uuid
    `;
    expect(deletedTurn).toEqual({
      status: "cancelled",
      routineId: null,
      routineName: "Queue cleanup",
      errorCode: "routine_deleted",
      errorMessage: "This scheduled run was skipped because the routine was deleted.",
      errorAction: "none",
    });
    const [deletedStart] = await integrationSql<Array<{ status: string }>>`
      select status::text as status from companion_operations
      where source_turn_id = ${deletedTurnId}::uuid and kind = 'start'
    `;
    expect(deletedStart).toEqual({ status: "cancelled" });
  });

  it("ignores scheduler cancellations and disables only after five genuine run failures", async () => {
    const created = await asActor(fixture.owner, (database) => createCompanionRoutineV2({
      orgId: fixture.orgA,
      companionId,
      ...draft("Failure accounting"),
      database,
    }));
    let fireIndex = 0;
    const fireNextRun = async (): Promise<string> => {
      await integrationDb
        .update(schema.companionRoutines)
        .set({ nextFireAt: new Date() })
        .where(eq(schema.companionRoutines.id, created.id));
      const workerId = `integration-routine-outcome-${fireIndex++}`;
      const claimed = await claimDueCompanionRoutines({ workerId, database: integrationDb });
      const claim = claimed.find((entry) => entry.routineId === created.id);
      if (!claim) throw new Error("expected the routine outcome fixture to be due");
      const clientMessageId = routineFireMessageId({
        routineId: created.id,
        scheduledFor: claim.scheduledFor,
      });
      await fireCompanionRoutine({
        workerId,
        orgId: fixture.orgA,
        routineId: created.id,
        clientMessageId,
        scheduledFor: claim.scheduledFor,
        nextFireAt: new Date(Date.now() + 60 * 60 * 1000),
        database: integrationDb,
      });
      const run = await integrationDb.query.companionTurns.findFirst({
        where: eq(schema.companionTurns.clientMessageId, clientMessageId),
      });
      if (!run) throw new Error("expected a fired routine run");
      return run.id;
    };
    const settleRun = async (runId: string, errorCode: string, errorMessage: string) => {
      await integrationDb
        .update(schema.companionTurns)
        .set({
          status: "failed",
          settledAt: new Date(),
          absoluteDeadlineAt: new Date(Date.now() + 60 * 1000),
          lastErrorCode: errorCode,
          lastErrorMessage: errorMessage,
          lastErrorAction: "retry",
        })
        .where(eq(schema.companionTurns.id, runId));
    };
    const settleNextRun = async (errorCode: string, errorMessage: string) => {
      await settleRun(await fireNextRun(), errorCode, errorMessage);
    };

    for (let index = 0; index < 5; index += 1) {
      await settleNextRun(
        "routine_session_cancelled",
        "Routine Pi session was cancelled before launch.",
      );
    }
    let [after] = await asActor(fixture.owner, (database) => listCompanionRoutinesV2({
      orgId: fixture.orgA,
      companionId,
      database,
    }));
    expect(after).toMatchObject({ consecutive_failures: 0, enabled: true });

    for (let index = 0; index < 4; index += 1) {
      await settleNextRun("provider_unavailable", "The routine provider is unavailable.");
    }
    const fifthFailureRunId = await fireNextRun();
    const queuedBeforeAutoDisable = randomUUID();
    const queuedClientMessageId = randomUUID();
    await integrationSql`
      insert into companion_turns (
        id, org_id, companion_id, client_message_id, message_event_id, queue_sequence,
        actor_id, client_surface, status, routine_id, routine_name,
        routine_snapshot_id, routine_snapshot_created_at
      )
      select
        ${queuedBeforeAutoDisable}::uuid, routine.org_id, routine.companion_id,
        ${queuedClientMessageId}::uuid, ${`msg:${queuedClientMessageId}`},
        coalesce((
          select max(existing.queue_sequence) + 1
          from companion_turns existing
          where existing.companion_id = routine.companion_id
        ), 1),
        ${fixture.owner.id}, 'web'::companion_client_surface, 'queued'::companion_turn_status,
        routine.id, routine.name, routine.id, routine.created_at
      from companion_routines routine
      where routine.id = ${created.id}::uuid
    `;
    await integrationSql`
      insert into companion_operations (
        org_id, companion_id, request_id, kind, trigger, actor_id,
        source_turn_id, runtime_generation
      ) values (
        ${fixture.orgA}::uuid, ${companionId}::uuid, ${randomUUID()}::uuid,
        'start', 'turn', ${fixture.owner.id}, ${queuedBeforeAutoDisable}::uuid, 1
      )
    `;
    await settleRun(
      fifthFailureRunId,
      "provider_unavailable",
      "The routine provider is unavailable.",
    );
    [after] = await asActor(fixture.owner, (database) => listCompanionRoutinesV2({
      orgId: fixture.orgA,
      companionId,
      database,
    }));
    expect(after).toMatchObject({
      consecutive_failures: 5,
      enabled: false,
      next_fire_at: null,
      last_error_code: "provider_unavailable",
    });
    const [purgedAfterAutoDisable] = await integrationSql<Array<{
      status: string;
      errorCode: string | null;
      errorMessage: string | null;
    }>>`
      select status::text as status, last_error_code as "errorCode",
        last_error_message as "errorMessage"
      from companion_turns where id = ${queuedBeforeAutoDisable}::uuid
    `;
    expect(purgedAfterAutoDisable).toEqual({
      status: "cancelled",
      errorCode: "routine_disabled",
      errorMessage: "This scheduled run was skipped because the routine was disabled.",
    });
    const [autoDisabledStart] = await integrationSql<Array<{ status: string }>>`
      select status::text as status from companion_operations
      where source_turn_id = ${queuedBeforeAutoDisable}::uuid and kind = 'start'
    `;
    expect(autoDisabledStart).toEqual({ status: "cancelled" });
  });

  it("does not apply an old run outcome to a recreated routine generation", async () => {
    const routineId = randomUUID();
    await asActor(fixture.owner, (database) => createCompanionRoutineV2({
      orgId: fixture.orgA,
      companionId,
      id: routineId,
      ...draft("Original generation"),
      database,
    }));
    await integrationDb
      .update(schema.companionRoutines)
      .set({ nextFireAt: new Date() })
      .where(eq(schema.companionRoutines.id, routineId));
    const [claim] = await claimDueCompanionRoutines({
      workerId: "integration-routine-generation",
      database: integrationDb,
    });
    if (!claim) throw new Error("expected the original routine generation to be due");
    await fireCompanionRoutine({
      workerId: "integration-routine-generation",
      orgId: fixture.orgA,
      routineId,
      clientMessageId: routineFireMessageId({ routineId, scheduledFor: claim.scheduledFor }),
      scheduledFor: claim.scheduledFor,
      nextFireAt: new Date(Date.now() + 60 * 60 * 1000),
      database: integrationDb,
    });
    const oldRun = await integrationDb.query.companionTurns.findFirst({
      where: eq(schema.companionTurns.routineSnapshotId, routineId),
      orderBy: (turn, { desc }) => [desc(turn.createdAt), desc(turn.id)],
    });
    if (!oldRun) throw new Error("expected the original routine run");

    await asActor(fixture.owner, (database) => deleteCompanionRoutineV2({
      orgId: fixture.orgA,
      companionId,
      routineId,
      database,
    }));
    await asActor(fixture.owner, (database) => createCompanionRoutineV2({
      orgId: fixture.orgA,
      companionId,
      id: routineId,
      ...draft("Replacement generation"),
      database,
    }));

    await integrationDb
      .update(schema.companionTurns)
      .set({
        status: "failed",
        settledAt: new Date(),
        absoluteDeadlineAt: new Date(Date.now() + 60 * 1000),
        lastErrorCode: "provider_unavailable",
        lastErrorMessage: "The old routine provider was unavailable.",
        lastErrorAction: "retry",
      })
      .where(eq(schema.companionTurns.id, oldRun.id));

    const [replacement] = await asActor(fixture.owner, (database) => listCompanionRoutinesV2({
      orgId: fixture.orgA,
      companionId,
      database,
    }));
    expect(replacement).toMatchObject({
      id: routineId,
      name: "Replacement generation",
      consecutive_failures: 0,
      enabled: true,
      last_error_code: null,
    });
  });

  it("keeps private run history tenant-scoped and references one notify payload in the main thread", async () => {
    const created = await asActor(fixture.owner, (database) => createCompanionRoutineV2({
      orgId: fixture.orgA,
      companionId,
      ...draft("Deployment check"),
      database,
    }));
    await integrationDb
      .update(schema.companionRoutines)
      .set({ nextFireAt: new Date() })
      .where(eq(schema.companionRoutines.id, created.id));
    const [claim] = await claimDueCompanionRoutines({
      workerId: "integration-routine-history-worker",
      database: integrationDb,
    });
    expect(claim?.routineId).toBe(created.id);
    await fireCompanionRoutine({
      workerId: "integration-routine-history-worker",
      orgId: fixture.orgA,
      routineId: created.id,
      clientMessageId: routineFireMessageId({
        routineId: created.id,
        scheduledFor: claim!.scheduledFor,
      }),
      scheduledFor: claim!.scheduledFor,
      nextFireAt: new Date(Date.now() + 60 * 60 * 1000),
      database: integrationDb,
    });

    const [run] = await integrationDb
      .select({ id: schema.companionTurns.id })
      .from(schema.companionTurns)
      .where(eq(schema.companionTurns.routineSnapshotId, created.id));
    expect(run).toBeDefined();
    const marker = await integrationDb.query.companionTranscriptEntries.findFirst({
      where: eq(schema.companionTranscriptEntries.turnId, run!.id),
    });
    expect(marker).toMatchObject({ routineName: "Deployment check" });

    await integrationDb.insert(schema.companionRoutineRunEntries).values([
      {
        orgId: fixture.orgA,
        companionId,
        runId: run!.id,
        eventId: "routine:work:1",
        ordinal: 0,
        role: "assistant",
        content: "Inspected the deployment before returning.",
      },
      {
        orgId: fixture.orgA,
        companionId,
        runId: run!.id,
        eventId: "routine:work:2",
        ordinal: 1,
        role: "assistant",
        content: "Prepared the terminal notification.",
      },
    ]);
    const [substrate] = await integrationDb
      .insert(schema.companionRoutineContextSubstrates)
      .values({
        orgId: fixture.orgA,
        companionId,
        summarySha256: null,
        builtThroughOrdinal: marker?.ordinal ?? 0,
        content: "Pinned main conversation context.",
        sha256: "f".repeat(64),
      })
      .returning({ id: schema.companionRoutineContextSubstrates.id });
    await integrationDb
      .update(schema.companionTurns)
      .set({ routineIsolated: true, routineContextSubstrateId: substrate!.id })
      .where(eq(schema.companionTurns.id, run!.id));
    const [returned] = await integrationSql<{ accepted: boolean }[]>`
      select companion_runtime_surface_routine_return(
        ${fixture.orgA}::uuid, ${companionId}::uuid, ${run!.id}::uuid,
        'notify', 'The deployment is healthy.'
      ) as accepted
    `;
    const mainEntryEventId = `routine-return:${run!.id}`;
    expect(returned).toEqual({ accepted: true });
    const storedReturn = await integrationDb.query.companionRoutineReturns.findFirst({
      where: eq(schema.companionRoutineReturns.runId, run!.id),
    });
    expect(storedReturn).toMatchObject({ mainEntryEventId, relayTurnId: null, mode: "notify" });
    const [replayed] = await integrationSql<{ accepted: boolean }[]>`
      select companion_runtime_surface_routine_return(
        ${fixture.orgA}::uuid, ${companionId}::uuid, ${run!.id}::uuid,
        'relay', 'This later call must not win.'
      ) as accepted
    `;
    expect(replayed).toEqual({ accepted: false });

    const projectedThread = await asActor(fixture.owner, (database) => readCompanionThreadV2({
      actor: fixture.owner,
      orgId: fixture.orgA,
      companionId,
      database,
    }));
    expect(projectedThread.entries.map((entry) => entry.event_id)).toEqual([
      marker!.eventId,
      mainEntryEventId,
    ]);
    expect(JSON.stringify(projectedThread.entries)).not.toContain("Inspected the deployment");
    expect(JSON.stringify(projectedThread.entries)).not.toContain("This later call must not win.");

    await integrationDb
      .update(schema.companionTurns)
      .set({
        lastErrorCode: "provider_unavailable",
        lastErrorMessage: "Reconnect the routine provider credential.",
        lastErrorAction: "reconnect_provider",
      })
      .where(eq(schema.companionTurns.id, run!.id));
    const ownerDetail = await asActor(fixture.owner, (database) => getCompanionRoutineRunV2({
      orgId: fixture.orgA,
      companionId,
      runId: run!.id,
      database,
    }));
    expect(ownerDetail.error).toEqual({
      code: "provider_unavailable",
      message: "Reconnect the routine provider credential.",
      action: "reconnect_provider",
    });

    await asActor(fixture.owner, (database) => setCompanionWorkspaceShareV2({
      actor: fixture.owner,
      orgId: fixture.orgA,
      companionId,
      role: "viewer",
      database,
    }));
    const viewerHistory = await asActor(fixture.developer, (database) =>
      listCompanionRoutineRunsV2({
        orgId: fixture.orgA,
        companionId,
        routineId: created.id,
        database,
      }));
    expect(viewerHistory).toMatchObject({ next_cursor: null });
    expect(viewerHistory.runs).toHaveLength(1);
    expect(viewerHistory.runs[0]).toMatchObject({
      run_id: run!.id,
      outcome: "surfaced",
      surface_mode: "notify",
      main_entry_event_id: mainEntryEventId,
      relay_turn_id: null,
    });
    const detail = await asActor(fixture.developer, (database) => getCompanionRoutineRunV2({
      orgId: fixture.orgA,
      companionId,
      runId: run!.id,
      entryLimit: 1,
      database,
    }));
    expect(detail.internal_entries).toEqual([expect.objectContaining({
      event_id: "routine:work:1",
      content: "Inspected the deployment before returning.",
    })]);
    expect(detail.next_entry_cursor).toBe(0);
    const secondPage = await asActor(fixture.developer, (database) => getCompanionRoutineRunV2({
      orgId: fixture.orgA,
      companionId,
      runId: run!.id,
      entryLimit: 1,
      entryCursor: detail.next_entry_cursor ?? undefined,
      database,
    }));
    expect(secondPage.internal_entries).toEqual([expect.objectContaining({
      event_id: "routine:work:2",
      content: "Prepared the terminal notification.",
    })]);
    expect(secondPage.next_entry_cursor).toBeNull();
    expect(detail.error).toEqual({
      code: "runtime_unavailable",
      message: "Companion runtime needs attention.",
      action: "none",
    });
    expect(JSON.stringify(detail)).not.toContain("The deployment is healthy.");

    await expect(withTenantContext(
      { orgId: fixture.orgB, userId: fixture.outsider.id },
      (database) => getCompanionRoutineRunV2({
        orgId: fixture.orgB,
        companionId,
        runId: run!.id,
        database,
      }),
    )).rejects.toThrow();

    await asActor(fixture.owner, (database) => deleteCompanionRoutineV2({
      orgId: fixture.orgA,
      companionId,
      routineId: created.id,
      database,
    }));
    await expect(asActor(fixture.developer, (database) => listCompanionRoutineRunsV2({
      orgId: fixture.orgA,
      companionId,
      routineId: created.id,
      database,
    }))).resolves.toMatchObject({ runs: [expect.objectContaining({ run_id: run!.id })] });
  });

  it("projects an additive-rollout main-session reply as a virtual notify result", async () => {
    const created = await asActor(fixture.owner, (database) => createCompanionRoutineV2({
      orgId: fixture.orgA,
      companionId,
      ...draft("Legacy compatibility"),
      database,
    }));
    await integrationDb
      .update(schema.companionRoutines)
      .set({ nextFireAt: new Date() })
      .where(eq(schema.companionRoutines.id, created.id));
    const [claim] = await claimDueCompanionRoutines({
      workerId: "integration-routine-legacy-worker",
      database: integrationDb,
    });
    await fireCompanionRoutine({
      workerId: "integration-routine-legacy-worker",
      orgId: fixture.orgA,
      routineId: created.id,
      clientMessageId: routineFireMessageId({
        routineId: created.id,
        scheduledFor: claim!.scheduledFor,
      }),
      scheduledFor: claim!.scheduledFor,
      nextFireAt: new Date(Date.now() + 60 * 60 * 1000),
      database: integrationDb,
    });

    const [run] = await integrationDb
      .select({ id: schema.companionTurns.id })
      .from(schema.companionTurns)
      .where(eq(schema.companionTurns.routineSnapshotId, created.id));
    const marker = await integrationDb.query.companionTranscriptEntries.findFirst({
      where: eq(schema.companionTranscriptEntries.turnId, run!.id),
    });
    const legacyReplyEventId = `v2:legacy:${run!.id}:assistant`;
    await integrationDb.insert(schema.companionTranscriptEntries).values({
      orgId: fixture.orgA,
      companionId,
      turnId: run!.id,
      eventId: legacyReplyEventId,
      ordinal: (marker?.ordinal ?? 0) + 1,
      role: "assistant",
      content: "This reply was produced by the pre-cutover main Pi session.",
    });
    await integrationDb
      .update(schema.companionTurns)
      .set({
        status: "succeeded",
        inactivityDeadlineAt: null,
        absoluteDeadlineAt: new Date(Date.now() + 2 * 60 * 60 * 1000),
        settledAt: new Date(),
      })
      .where(eq(schema.companionTurns.id, run!.id));

    const history = await asActor(fixture.owner, (database) => listCompanionRoutineRunsV2({
      orgId: fixture.orgA,
      companionId,
      routineId: created.id,
      database,
    }));
    expect(history.runs).toEqual([expect.objectContaining({
      run_id: run!.id,
      status: "succeeded",
      outcome: "surfaced",
      surface_mode: "notify",
      main_entry_event_id: legacyReplyEventId,
      relay_turn_id: null,
    })]);
    const detail = await asActor(fixture.owner, (database) => getCompanionRoutineRunV2({
      orgId: fixture.orgA,
      companionId,
      runId: run!.id,
      database,
    }));
    expect(detail.internal_entries).toEqual([expect.objectContaining({
      event_id: marker!.eventId,
      role: "user",
    })]);
    expect(JSON.stringify(detail.internal_entries)).not.toContain(
      "This reply was produced by the pre-cutover main Pi session.",
    );
  });

  it("references a hidden ordinary turn for relay without projecting its synthetic prompt", async () => {
    const created = await asActor(fixture.owner, (database) => createCompanionRoutineV2({
      orgId: fixture.orgA,
      companionId,
      ...draft("Relay check"),
      database,
    }));
    await integrationDb
      .update(schema.companionRoutines)
      .set({ nextFireAt: new Date() })
      .where(eq(schema.companionRoutines.id, created.id));
    const [claim] = await claimDueCompanionRoutines({
      workerId: "integration-routine-relay-worker",
      database: integrationDb,
    });
    await fireCompanionRoutine({
      workerId: "integration-routine-relay-worker",
      orgId: fixture.orgA,
      routineId: created.id,
      clientMessageId: routineFireMessageId({
        routineId: created.id,
        scheduledFor: claim!.scheduledFor,
      }),
      scheduledFor: claim!.scheduledFor,
      nextFireAt: new Date(Date.now() + 60 * 60 * 1000),
      database: integrationDb,
    });
    const [run] = await integrationDb
      .select({ id: schema.companionTurns.id })
      .from(schema.companionTurns)
      .where(eq(schema.companionTurns.routineSnapshotId, created.id));
    const marker = await integrationDb.query.companionTranscriptEntries.findFirst({
      where: eq(schema.companionTranscriptEntries.turnId, run!.id),
    });
    const [substrate] = await integrationDb
      .insert(schema.companionRoutineContextSubstrates)
      .values({
        orgId: fixture.orgA,
        companionId,
        summarySha256: null,
        builtThroughOrdinal: marker?.ordinal ?? 0,
        content: "Pinned relay context.",
        sha256: "e".repeat(64),
      })
      .returning({ id: schema.companionRoutineContextSubstrates.id });
    await integrationDb
      .update(schema.companionTurns)
      .set({ routineIsolated: true, routineContextSubstrateId: substrate!.id })
      .where(eq(schema.companionTurns.id, run!.id));

    const [returned] = await integrationSql<{ accepted: boolean }[]>`
      select companion_runtime_surface_routine_return(
        ${fixture.orgA}::uuid, ${companionId}::uuid, ${run!.id}::uuid,
        'relay', 'Please explain the failed deployment.'
      ) as accepted
    `;
    expect(returned).toEqual({ accepted: true });
    const storedReturn = await integrationDb.query.companionRoutineReturns.findFirst({
      where: eq(schema.companionRoutineReturns.runId, run!.id),
    });
    expect(storedReturn?.relayTurnId).not.toBeNull();
    const relayTurn = await integrationDb.query.companionTurns.findFirst({
      where: eq(schema.companionTurns.id, storedReturn!.relayTurnId!),
    });
    expect(relayTurn).toMatchObject({
      routineSnapshotId: null,
      routineRelaySourceEventId: `routine-return:${run!.id}`,
      status: "queued",
    });

    const projectedThread = await asActor(fixture.owner, (database) => readCompanionThreadV2({
      actor: fixture.owner,
      orgId: fixture.orgA,
      companionId,
      database,
    }));
    const serialized = JSON.stringify(projectedThread.entries);
    expect(serialized).toContain("Please explain the failed deployment.");
    expect(serialized).not.toContain("Respond to the surfaced routine entry");
    expect(projectedThread.entries.filter((entry) =>
      entry.content === "Please explain the failed deployment.")).toHaveLength(1);
  });

  it("keeps a claimed instant comparable after the worker's JavaScript round trip", async () => {
    const created = await asActor(fixture.owner, (database) => createCompanionRoutineV2({
      orgId: fixture.orgA,
      companionId,
      ...draft("Precision"),
      database,
    }));
    // PostgreSQL now() carries microseconds while the column keeps milliseconds. Keep the instant
    // unambiguously due as well, so a fast transaction boundary cannot make this precision test
    // depend on the wall clock advancing before the worker claim.
    await integrationSql`
      update companion_routines set next_fire_at = now() - interval '1 second'
      where id = ${created.id}::uuid
    `;
    const [claim] = await claimDueCompanionRoutines({
      workerId: "integration-routine-worker",
      database: integrationDb,
    });
    const stored = await integrationDb.query.companionRoutines.findFirst({
      where: eq(schema.companionRoutines.id, created.id),
    });
    expect(claim!.scheduledFor.getTime()).toBe(stored!.nextFireAt!.getTime());

    const fired = await fireCompanionRoutine({
      workerId: "integration-routine-worker",
      orgId: fixture.orgA,
      routineId: created.id,
      clientMessageId: randomUUID(),
      scheduledFor: claim!.scheduledFor,
      nextFireAt: new Date(Date.now() + 60 * 60 * 1000),
      database: integrationDb,
    });
    expect(fired.outcome).toBe("fired");
  });

  it("denies an expired routine proposal without creating a routine", async () => {
    const turnId = randomUUID();
    const attemptId = randomUUID();
    const clientMessageId = randomUUID();
    const requestKey = randomUUID();
    // A poll/runtime sweep can lag the wall-clock deadline, leaving an expired card visibly
    // pending for a short window. Explicit denial is still fail-closed and must win that race.
    const expiresAt = new Date(Date.now() - 60_000);
    const proposal = {
      kind: "routine",
      name: "conductor-progress-check",
      prompt: "Check every active Conductor workspace and report its progress.",
      cron: "*/30 * * * *",
      timezone: "Europe/Paris",
    };

    await integrationSql`
      insert into companion_threads(org_id, companion_id, next_ordinal, last_message_at)
      values (${fixture.orgA}::uuid, ${companionId}::uuid, 2, now())
      on conflict (companion_id) do update
      set next_ordinal = 2, updated_at = now()
    `;
    await integrationSql`
      insert into companion_transcript_entries(
        org_id, companion_id, event_id, ordinal, role, content, author_id
      ) values (
        ${fixture.orgA}::uuid, ${companionId}::uuid, ${`msg:${clientMessageId}`},
        0, 'user', 'Propose a Conductor progress routine', ${fixture.owner.id}
      )
    `;
    await integrationSql`
      insert into companion_turns (
        id, org_id, companion_id, client_message_id, message_event_id,
        queue_sequence, actor_id, client_surface, status,
        inactivity_deadline_at, absolute_deadline_at
      ) values (
        ${turnId}::uuid, ${fixture.orgA}::uuid, ${companionId}::uuid,
        ${clientMessageId}::uuid, ${`msg:${clientMessageId}`}, 1,
        ${fixture.owner.id}, 'native_mobile', 'needs_input',
        null, now() + interval '2 hours'
      )
    `;
    await integrationSql`
      insert into companion_turn_attempts (
        id, org_id, companion_id, turn_id, attempt_number, actor_id,
        runtime_generation, settings_revision, skills_revision, model_id,
        provider_ids, provider_credential_refs, selected_skill_ids,
        selected_mcp_account_ids, mcp_credential_refs,
        status, checkpoint, dispatch_state, command_id,
        dispatch_accepted_at, pi_invocation_id, last_activity_at
      ) values (
        ${attemptId}::uuid, ${fixture.orgA}::uuid, ${companionId}::uuid, ${turnId}::uuid,
        1, ${fixture.owner.id}, 1, 1, 1, 'claude-opus-4-8',
        ${JSON.stringify(["anthropic"])}::jsonb,
        ${JSON.stringify([{ provider_id: "anthropic", credential_generation: randomUUID(), credential_version: 1 }])}::jsonb,
        '[]'::jsonb, '[]'::jsonb, '[]'::jsonb,
        'needs_input', 'needs_input', 'accepted', ${randomUUID()}::uuid,
        now(), ${`pi-${attemptId}`}, now()
      )
    `;
    await integrationSql`
      insert into companion_decision_deliveries(
        org_id, companion_id, turn_id, attempt_id,
        request_key, request_kind, expires_at, proposal
      ) values (
        ${fixture.orgA}::uuid, ${companionId}::uuid, ${turnId}::uuid, ${attemptId}::uuid,
        ${requestKey}, 'routine_proposal', ${expiresAt.toISOString()},
        ${JSON.stringify(proposal)}::jsonb
      )
    `;
    const decision = {
      request_id: requestKey,
      kind: "routine",
      name: "propose_routine",
      title: "Check every Conductor workspace every 30 minutes",
      detail: "Monitor all active Conductor workspaces.",
      status: "pending",
      answer: null,
      decided_by_id: null,
      decided_by_name: null,
      decided_at: null,
      expires_at: expiresAt.toISOString(),
      proposal,
    };
    await integrationSql`
      insert into companion_transcript_entries(
        org_id, companion_id, event_id, ordinal, role, content, decision
      ) values (
        ${fixture.orgA}::uuid, ${companionId}::uuid, ${`decision:${requestKey}`},
        1, 'decision', ${decision.title}, ${JSON.stringify(decision)}::jsonb
      )
    `;

    await asActor(fixture.owner, (database) => answerCompanionRoutineDecisionV2({
      orgId: fixture.orgA,
      companionId,
      requestId: requestKey,
      decision: "deny",
      database,
    }));

    // The runtime expiry sweep may win the row lock after the HTTP preflight saw `pending` but
    // before this answer function selects it. Deny treats that actorless terminal row as the same
    // fail-closed outcome instead of returning a conflict.
    const sweptRequestKey = randomUUID();
    const sweptAt = new Date();
    await integrationSql`
      insert into companion_decision_deliveries(
        org_id, companion_id, turn_id, attempt_id,
        request_key, request_kind, decision_status, responded_at, expires_at, proposal
      ) values (
        ${fixture.orgA}::uuid, ${companionId}::uuid, ${turnId}::uuid, ${attemptId}::uuid,
        ${sweptRequestKey}, 'routine_proposal', 'expired', ${sweptAt.toISOString()},
        ${expiresAt.toISOString()}, ${JSON.stringify(proposal)}::jsonb
      )
    `;
    await asActor(fixture.owner, (database) => answerCompanionRoutineDecisionV2({
      orgId: fixture.orgA,
      companionId,
      requestId: sweptRequestKey,
      decision: "deny",
      database,
    }));

    // The exception is deliberately one-way: expiry can never be bypassed to create a routine.
    const expiredAllowRequestKey = randomUUID();
    await integrationSql`
      insert into companion_decision_deliveries(
        org_id, companion_id, turn_id, attempt_id,
        request_key, request_kind, expires_at, proposal
      ) values (
        ${fixture.orgA}::uuid, ${companionId}::uuid, ${turnId}::uuid, ${attemptId}::uuid,
        ${expiredAllowRequestKey}, 'routine_proposal', ${expiresAt.toISOString()},
        ${JSON.stringify(proposal)}::jsonb
      )
    `;
    await expect(asActor(fixture.owner, (database) => answerCompanionRoutineDecisionV2({
      orgId: fixture.orgA,
      companionId,
      requestId: expiredAllowRequestKey,
      decision: "allow",
      database,
    }))).rejects.toMatchObject({
      code: "routine_update_failed",
      httpStatus: 409,
      message: "Unable to apply the routine proposal. Please try again.",
    });

    await expect(asActor(fixture.owner, (database) => listCompanionRoutinesV2({
      orgId: fixture.orgA,
      companionId,
      database,
    }))).resolves.toEqual([]);
    const [delivery] = await integrationDb
      .select({ decisionStatus: schema.companionDecisionDeliveries.decisionStatus })
      .from(schema.companionDecisionDeliveries)
      .where(eq(schema.companionDecisionDeliveries.requestKey, requestKey));
    expect(delivery).toEqual({ decisionStatus: "denied" });
    const [entry] = await integrationDb
      .select({ decision: schema.companionTranscriptEntries.decision })
      .from(schema.companionTranscriptEntries)
      .where(eq(schema.companionTranscriptEntries.eventId, `decision:${requestKey}`));
    expect(entry?.decision).toMatchObject({ status: "denied", decided_by_id: fixture.owner.id });
    const [swept] = await integrationDb
      .select({ decisionStatus: schema.companionDecisionDeliveries.decisionStatus })
      .from(schema.companionDecisionDeliveries)
      .where(eq(schema.companionDecisionDeliveries.requestKey, sweptRequestKey));
    expect(swept).toEqual({ decisionStatus: "expired" });
  });
});
