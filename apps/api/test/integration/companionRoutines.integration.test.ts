import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
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
      routine: { id: created.id, name: "Daily standup" },
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
    }))).rejects.toMatchObject({ cause: { code: "55000" } });

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
