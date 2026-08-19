import type { RuntimeClock } from "../clock";
import type {
  RuntimeAttachmentStager,
  RuntimeBoxControl,
  RuntimeEngineDependencies,
  RuntimeEventProjector,
  RuntimeMaterialProvider,
  RuntimeOutboxHarvester,
  RuntimePiControl,
  RuntimeResourceStager,
} from "../ports";
import type { RuntimePiProjection } from "../piEvents";
import {
  RUNTIME_LEASE_SECONDS,
  type RuntimeStore,
} from "../store";
import type {
  AttemptRuntimeClaim,
  DuplicateCleanup,
  GateStatus,
  LeaseFence,
  McpOauthCasResult,
  OperationRuntimeClaim,
  RuntimeAuthorization,
  RuntimeCheckpointInput,
  RuntimeClaim,
  RuntimeObservationInput,
  RuntimeOutputAttachment,
  RuntimeSettlementInput,
  RuntimeConfigCatalog,
  RuntimeWorkMaterial,
} from "../types";

export const ORG_ID = "11111111-1111-4111-8111-111111111111";
export const COMPANION_ID = "22222222-2222-4222-8222-222222222222";
export const ATTEMPT_ID = "33333333-3333-4333-8333-333333333333";
export const CLAIM_TOKEN = "44444444-4444-4444-8444-444444444444";
export const TURN_ID = "55555555-5555-4555-8555-555555555555";
export const MESSAGE_EVENT_ID = "msg:66666666-6666-4666-8666-666666666666";
export const COMMAND_ID = "77777777-7777-4777-8777-777777777777";
export const BOX_ID = "bx_23456789";
export const PI_INVOCATION_ID = "pi-invocation-1";
export const OPERATION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

export class TestClock implements RuntimeClock {
  readonly sleeps: number[] = [];
  readonly timers = new Map<number, { callback: () => void; milliseconds: number }>();
  #nextTimer = 1;

  constructor(private current = new Date("2026-08-16T12:00:00.000Z")) {}

  now(): Date {
    return new Date(this.current);
  }

  advance(milliseconds: number): void {
    this.current = new Date(this.current.getTime() + milliseconds);
  }

  async sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw signal.reason ?? new Error("aborted");
    this.sleeps.push(milliseconds);
    this.advance(milliseconds);
  }

  setTimeout(callback: () => void, milliseconds: number): unknown {
    const id = this.#nextTimer++;
    this.timers.set(id, { callback, milliseconds });
    return id;
  }

  clearTimeout(handle: unknown): void {
    if (typeof handle === "number") this.timers.delete(handle);
  }

  runNextTimer(): void {
    const entry = this.timers.entries().next().value as
      | [number, { callback: () => void; milliseconds: number }]
      | undefined;
    if (!entry) return;
    const [id, timer] = entry;
    this.timers.delete(id);
    this.advance(timer.milliseconds);
    timer.callback();
  }
}

export function attemptClaim(
  overrides: Partial<AttemptRuntimeClaim> = {},
): AttemptRuntimeClaim {
  return {
    orgId: ORG_ID,
    companionId: COMPANION_ID,
    claimToken: CLAIM_TOKEN,
    claimEpoch: 1n,
    gateEpoch: 1n,
    workKind: "attempt",
    workId: ATTEMPT_ID,
    actorId: "user-1",
    clientSurface: "web",
    runtimeGeneration: 1n,
    checkpoint: "starting",
    checkpointSequence: 0n,
    turnId: TURN_ID,
    turnStatus: "starting",
    attemptStatus: "starting",
    dispatchState: "pending",
    eventCursor: 0n,
    unknownEventCount: 0,
    malformedEventCount: 0,
    oversizedEventCount: 0,
    coldStartDeadlineAt: new Date("2026-08-16T12:03:00.000Z"),
    inactivityDeadlineAt: null,
    absoluteDeadlineAt: new Date("2026-08-16T14:00:00.000Z"),
    operationKind: null,
    operationStartedAt: null,
    operationAttemptCount: null,
    providerOperationId: null,
    targetSettingsRevision: null,
    targetSkillsRevision: null,
    decisionStatus: null,
    decisionDeliveryState: null,
    ...overrides,
  };
}

export function attemptAuthorization(
  claim: AttemptRuntimeClaim,
  overrides: Partial<RuntimeAuthorization> = {},
): RuntimeAuthorization {
  return {
    authorized: true,
    denialCode: null,
    leaseExpiresAt: new Date("2026-08-16T12:00:30.000Z"),
    authorizationActorId: claim.actorId,
    decisionActorId: null,
    clientSurface: claim.clientSurface,
    runtimeGeneration: claim.runtimeGeneration,
    boxId: BOX_ID,
    boxState: "ready",
    piState: "idle",
    piInvocationId: PI_INVOCATION_ID,
    diskLayoutVersion: 14,
    appliedSettingsRevision: 1n,
    appliedSkillsRevision: 1,
    modelId: "provider/model",
    persona: null,
    canWriteSkills: false,
    providerRefs: [],
    skillRefs: [],
    mcpRefs: [],
    desiredSettingsRevision: 1n,
    skillsRevision: 1,
    workCheckpoint: claim.checkpoint,
    workCheckpointSequence: claim.checkpointSequence,
    turnId: claim.turnId,
    turnStatus: claim.turnStatus,
    attemptStatus: claim.attemptStatus,
    dispatchState: claim.dispatchState,
    eventCursor: claim.eventCursor,
    unknownEventCount: claim.unknownEventCount,
    malformedEventCount: claim.malformedEventCount,
    oversizedEventCount: claim.oversizedEventCount,
    coldStartDeadlineAt: claim.coldStartDeadlineAt,
    inactivityDeadlineAt: claim.inactivityDeadlineAt,
    absoluteDeadlineAt: claim.absoluteDeadlineAt,
    operationKind: null,
    operationStartedAt: null,
    operationAttemptCount: null,
    providerOperationId: null,
    targetSettingsRevision: null,
    targetSkillsRevision: null,
    decisionStatus: null,
    decisionDeliveryState: null,
    decisionRequestKey: null,
    decisionResponseText: null,
    ...overrides,
  };
}

export function operationClaim(
  overrides: Partial<Extract<OperationRuntimeClaim, { clientSurface: "web" | "mobile_web" | "native_mobile" }>> = {},
): Extract<OperationRuntimeClaim, { clientSurface: "web" | "mobile_web" | "native_mobile" }> {
  return {
    ...attemptClaim(),
    workKind: "operation",
    workId: OPERATION_ID,
    checkpoint: "pending",
    checkpointSequence: 0n,
    turnId: null,
    turnStatus: null,
    attemptStatus: null,
    dispatchState: null,
    eventCursor: null,
    unknownEventCount: null,
    malformedEventCount: null,
    oversizedEventCount: null,
    inactivityDeadlineAt: null,
    absoluteDeadlineAt: null,
    operationKind: "start",
    operationStartedAt: new Date("2026-08-16T12:00:00.000Z"),
    operationAttemptCount: 1,
    targetSettingsRevision: 1n,
    targetSkillsRevision: 1,
    decisionStatus: null,
    decisionDeliveryState: null,
    ...overrides,
  };
}

export function operationAuthorization(
  claim: OperationRuntimeClaim,
  overrides: Partial<RuntimeAuthorization> = {},
): RuntimeAuthorization {
  const baseAttempt = attemptClaim();
  return attemptAuthorization(baseAttempt, {
    clientSurface: claim.clientSurface,
    runtimeGeneration: claim.runtimeGeneration,
    workCheckpoint: claim.checkpoint,
    workCheckpointSequence: claim.checkpointSequence,
    turnId: claim.turnId,
    turnStatus: claim.turnStatus,
    attemptStatus: null,
    dispatchState: null,
    eventCursor: null,
    unknownEventCount: null,
    malformedEventCount: null,
    oversizedEventCount: null,
    coldStartDeadlineAt: claim.coldStartDeadlineAt,
    inactivityDeadlineAt: null,
    absoluteDeadlineAt: claim.absoluteDeadlineAt,
    operationKind: claim.operationKind,
    operationStartedAt: claim.operationStartedAt,
    operationAttemptCount: claim.operationAttemptCount,
    providerOperationId: claim.providerOperationId,
    targetSettingsRevision: claim.targetSettingsRevision,
    targetSkillsRevision: claim.targetSkillsRevision,
    desiredSettingsRevision: claim.targetSettingsRevision,
    skillsRevision: claim.targetSkillsRevision,
    ...overrides,
  });
}

export function attemptMaterial(overrides: Partial<RuntimeWorkMaterial> = {}): RuntimeWorkMaterial {
  return {
    turnId: TURN_ID,
    attemptId: ATTEMPT_ID,
    messageEventId: MESSAGE_EVENT_ID,
    promptText: "Hello from a durable turn",
    decisionRequestKind: null,
    decisionResponsePayload: null,
    providerMaterial: [],
    skillMaterial: [],
    mcpMaterial: [],
    modelInput: null,
    hasVisibleOutput: false,
    attachments: [],
    configCatalog: null,
    ...overrides,
  };
}

export class MemoryRuntimeStore implements RuntimeStore {
  gate: GateStatus = {
    enabled: true,
    gateEpoch: 1n,
    updatedAt: new Date("2026-08-16T12:00:00.000Z"),
  };
  claims: RuntimeClaim[] = [];
  authorization: RuntimeAuthorization;
  material: RuntimeWorkMaterial;
  settlements: RuntimeSettlementInput[] = [];
  checkpoints: RuntimeCheckpointInput[] = [];
  observations: RuntimeObservationInput[] = [];
  projected: RuntimePiProjection[][] = [];
  releases = 0;
  disables = 0;
  renewReturnsNull = false;
  renewals = 0;
  duplicateCleanups = new Map<string, DuplicateCleanup>();

  constructor(input: {
    authorization: RuntimeAuthorization;
    material?: RuntimeWorkMaterial;
  }) {
    this.authorization = input.authorization;
    this.material = input.material ?? attemptMaterial();
  }

  async ping(): Promise<void> {}

  async gateStatus(): Promise<GateStatus> {
    return this.gate;
  }

  async disable(expectedGateEpoch: bigint): Promise<GateStatus> {
    if (expectedGateEpoch !== this.gate.gateEpoch) throw new Error("stale gate");
    this.disables += 1;
    this.gate = {
      enabled: false,
      gateEpoch: this.gate.gateEpoch + 1n,
      updatedAt: new Date(this.gate.updatedAt.getTime() + 1),
    };
    return this.gate;
  }

  async claimWork(input: {
    executorId: string;
    limit: number;
    leaseSeconds: typeof RUNTIME_LEASE_SECONDS;
    gateEpoch: bigint;
  }): Promise<RuntimeClaim[]> {
    if (!this.gate.enabled || input.gateEpoch !== this.gate.gateEpoch) return [];
    return this.claims.splice(0, input.limit);
  }

  async renewAndAuthorize(): Promise<RuntimeAuthorization | null> {
    this.renewals += 1;
    if (this.renewReturnsNull) return null;
    return { ...this.authorization };
  }

  async checkpoint(_fence: LeaseFence, input: RuntimeCheckpointInput): Promise<bigint | null> {
    if (input.expectedSequence !== this.authorization.workCheckpointSequence) return null;
    this.checkpoints.push(input);
    const next = input.expectedSequence + 1n;
    this.authorization.workCheckpointSequence = next;
    this.authorization.workCheckpoint = input.nextCheckpoint;
    if (input.providerOperationId) {
      this.authorization.providerOperationId = input.providerOperationId;
    }
    if (input.piInvocationId) this.authorization.piInvocationId = input.piInvocationId;
    if (input.eventCursor !== undefined) this.authorization.eventCursor = input.eventCursor;
    if (input.activityAt) {
      this.authorization.inactivityDeadlineAt = new Date(input.activityAt.getTime() + 10 * 60_000);
    }
    if (input.unknownEventCount !== undefined) {
      this.authorization.unknownEventCount = input.unknownEventCount;
    }
    if (input.malformedEventCount !== undefined) {
      this.authorization.malformedEventCount = input.malformedEventCount;
    }
    if (input.oversizedEventCount !== undefined) {
      this.authorization.oversizedEventCount = input.oversizedEventCount;
    }
    if (input.nextCheckpoint === "dispatch_write_intent") {
      this.authorization.dispatchState = "write_intent";
      this.authorization.attemptStatus = "dispatching";
      this.authorization.turnStatus = "dispatching";
    } else if (input.nextCheckpoint === "dispatch_accepted") {
      this.authorization.dispatchState = "accepted";
      this.authorization.attemptStatus = "running";
      this.authorization.turnStatus = "running";
      this.authorization.inactivityDeadlineAt = new Date("2026-08-16T12:10:00.000Z");
    } else if (input.nextCheckpoint === "dispatch_ambiguous") {
      this.authorization.dispatchState = "ambiguous";
    } else if (input.nextCheckpoint === "dispatch_rejected") {
      this.authorization.dispatchState = "rejected";
    } else if (input.nextCheckpoint === "agent_settled") {
      this.authorization.attemptStatus = "running";
    }
    return next;
  }

  async observeInstance(fence: LeaseFence, input: RuntimeObservationInput): Promise<bigint | null> {
    if (input.expectedSequence !== this.authorization.workCheckpointSequence) return null;
    const previousPiInvocationId = this.authorization.piInvocationId;
    this.observations.push(input);
    if (input.boxId) this.authorization.boxId = input.boxId;
    if (input.boxState) this.authorization.boxState = input.boxState;
    if (input.piState) this.authorization.piState = input.piState;
    if (input.piInvocationId) this.authorization.piInvocationId = input.piInvocationId;
    if (input.diskLayoutVersion !== undefined) {
      this.authorization.diskLayoutVersion = input.diskLayoutVersion;
    }
    if (fence.workKind !== "settings" && input.appliedSettingsRevision !== undefined) {
      this.authorization.appliedSettingsRevision = input.appliedSettingsRevision;
    }
    if (fence.workKind !== "settings" && input.appliedSkillsRevision !== undefined) {
      this.authorization.appliedSkillsRevision = input.appliedSkillsRevision;
    }
    let nextCheckpoint: string | null = null;
    const current = this.authorization.workCheckpoint;
    const kind = this.authorization.operationKind;
    if (kind === "start" && current === "resolving_box" && !input.boxId && input.boxState === "absent") {
      nextCheckpoint = "box_absence_observed";
    } else if (kind === "start" && current === "creating_box" && input.boxId) {
      nextCheckpoint = input.boxState === "ready" ? "box_ready_observed" : "box_created";
    } else if ((kind === "start" || kind === "restart_box") && current === "waiting_ready"
      && (input.boxState === "ready" || input.boxState === "idle" || input.boxState === "running")) {
      nextCheckpoint = "box_ready_observed";
    } else if ((kind === "start" || kind === "restart_pi" || kind === "restart_box")
      && current === "starting_pi" && input.piState === "idle" && input.piInvocationId) {
      nextCheckpoint = "pi_observed";
    } else if (kind === "apply_settings" && current === "applying_settings"
      && input.appliedSettingsRevision !== undefined
      && input.piState === "idle"
      && input.piInvocationId !== undefined
      && input.piInvocationId !== previousPiInvocationId) {
      nextCheckpoint = "settings_applied";
    } else if (kind === "delete" && current === "box_absence_observed"
      && !input.boxId && input.boxState === "absent") {
      nextCheckpoint = "box_absent";
    } else if (kind === "delete" && current === "waiting_deleted"
      && input.boxState === "absent") {
      nextCheckpoint = "provider_deleted";
    } else if (fence.workKind === "health" && current === "observing") {
      nextCheckpoint = "observed";
    } else if (fence.workKind === "settings" && current === "applying"
      && input.appliedSettingsRevision === this.authorization.desiredSettingsRevision
      && (this.authorization.clientSurface === "native_mobile"
        ? input.appliedSkillsRevision === undefined
        : input.appliedSkillsRevision === this.authorization.skillsRevision)
      && input.piState === "idle"
      && input.piInvocationId !== undefined
      && input.piInvocationId !== previousPiInvocationId) {
      nextCheckpoint = "applied";
    }
    if (nextCheckpoint) {
      const next = input.expectedSequence + 1n;
      this.authorization.workCheckpoint = nextCheckpoint;
      this.authorization.workCheckpointSequence = next;
      return next;
    }
    return input.expectedSequence;
  }

  async getMaterial(): Promise<RuntimeWorkMaterial | null> {
    return { ...this.material };
  }

  async getConfigCatalog(): Promise<RuntimeConfigCatalog | null> {
    return this.material.configCatalog;
  }

  async mintHubToken(): Promise<string | null> {
    return null;
  }

  async getAttemptTerminalProjection(): Promise<{
    checkpoint: "agent_settled" | "process_exited";
    eventCursor: bigint;
    hasVisibleOutput: boolean;
    outputsHarvested: boolean;
  } | null> {
    const checkpoint = this.authorization.workCheckpoint;
    if (
      (checkpoint !== "agent_settled" && checkpoint !== "process_exited")
      || this.authorization.eventCursor === null
    ) return null;
    return {
      checkpoint,
      eventCursor: this.authorization.eventCursor,
      hasVisibleOutput: this.material.hasVisibleOutput,
      outputsHarvested: this.outputsHarvested,
    };
  }

  /** What a recorded harvest committed, so a test can assert it happened exactly once. */
  outputsHarvested = false;
  recordedOutputs: RuntimeOutputAttachment[][] = [];
  recordOutputsFailure: Error | null = null;
  /** Set to model the fence being lost between Pi settling and the harvest commit. */
  recordOutputsFenceLost = false;
  /** Ordered effect log shared with the fake ports, so a test can assert durable-before-external. */
  effectLog: string[] = [];

  async recordAttemptOutputs(_fence: LeaseFence, input: {
    attachments: RuntimeOutputAttachment[];
    activityAt: Date;
  }): Promise<{ recorded: number; hasVisibleOutput: boolean } | null> {
    this.effectLog.push("record-outputs");
    if (this.recordOutputsFailure) throw this.recordOutputsFailure;
    if (this.recordOutputsFenceLost) return null;
    this.recordedOutputs.push(input.attachments);
    this.outputsHarvested = true;
    if (input.attachments.length > 0) this.material.hasVisibleOutput = true;
    return {
      recorded: input.attachments.length,
      hasVisibleOutput: this.material.hasVisibleOutput,
    };
  }

  async projectEventBatch(_fence: LeaseFence, input: {
    expectedSequence: bigint;
    piInvocationId: string;
    events: RuntimePiProjection[];
    throughCursor: bigint;
    activityAt?: Date;
    unknownEventCount: number;
    malformedEventCount: number;
    oversizedEventCount: number;
  }): Promise<{
    checkpointSequence: bigint;
    eventCursor: bigint;
    hasVisibleOutput: boolean;
  } | null> {
    if (input.expectedSequence !== this.authorization.workCheckpointSequence) return null;
    this.projected.push(input.events);
    const next = input.expectedSequence + 1n;
    const visible = this.material.hasVisibleOutput || input.events.some((event) =>
      event.type === "assistant" || event.type === "decision");
    this.material.hasVisibleOutput = visible;
    this.authorization.workCheckpointSequence = next;
    this.authorization.workCheckpoint = input.events.some((event) => event.type === "process_exit")
      ? "process_exited"
      : input.events.some((event) => event.type === "settled")
        ? "agent_settled"
        : "event_projected";
    this.authorization.eventCursor = input.throughCursor;
    this.authorization.unknownEventCount = input.unknownEventCount;
    this.authorization.malformedEventCount = input.malformedEventCount;
    this.authorization.oversizedEventCount = input.oversizedEventCount;
    // Mirrors companion_runtime_project_event_batch: a page whose decision is followed by a
    // settlement or a process exit is not waiting for input, it is finished.
    this.authorization.attemptStatus = input.events.some((event) => event.type === "decision")
      && !input.events.some((event) => event.type === "settled" || event.type === "process_exit")
      ? "needs_input"
      : "running";
    this.authorization.turnStatus = this.authorization.attemptStatus;
    return {
      checkpointSequence: next,
      eventCursor: input.throughCursor,
      hasVisibleOutput: visible,
    };
  }

  async registerDuplicateCleanups(_fence: LeaseFence, boxIds: string[]): Promise<DuplicateCleanup[]> {
    for (const boxId of boxIds) {
      if (!this.duplicateCleanups.has(boxId)) {
        this.duplicateCleanups.set(boxId, {
          boxId,
          status: "pending",
          providerOperationId: null,
          checkpointSequence: 0n,
        });
      }
    }
    return [...this.duplicateCleanups.values()].map((cleanup) => ({ ...cleanup }));
  }

  async checkpointDuplicateCleanup(_fence: LeaseFence, input: {
    boxId: string;
    expectedSequence: bigint;
    nextStatus: DuplicateCleanup["status"];
    providerOperationId?: string;
  }): Promise<DuplicateCleanup | null> {
    const cleanup = this.duplicateCleanups.get(input.boxId);
    if (!cleanup || cleanup.checkpointSequence !== input.expectedSequence) return null;
    cleanup.status = input.nextStatus;
    cleanup.providerOperationId ??= input.providerOperationId ?? null;
    cleanup.checkpointSequence += 1n;
    return { ...cleanup };
  }

  async casMcpOauth(): Promise<McpOauthCasResult | null> {
    return null;
  }

  async settle(fence: LeaseFence, input: RuntimeSettlementInput): Promise<boolean> {
    this.settlements.push(input);
    if (fence.workKind === "settings" && input.terminalStatus === "succeeded") {
      this.authorization.appliedSettingsRevision = this.authorization.desiredSettingsRevision;
      this.authorization.appliedSkillsRevision = this.authorization.skillsRevision;
    }
    return true;
  }

  async release(): Promise<boolean> {
    this.releases += 1;
    return true;
  }
}

export interface FakePorts {
  box: RuntimeBoxControl;
  pi: RuntimePiControl;
  resourceStager: RuntimeResourceStager;
  attachmentStager: RuntimeAttachmentStager;
  outboxHarvester: RuntimeOutboxHarvester;
  eventProjector: RuntimeEventProjector;
  log: string[];
  promptCalls: { attemptId: string; message: string }[];
  decisionCalls: { attemptId: string }[];
  eventReads: unknown[];
  stagedAttachments: { messageEventId: string; filenames: string[] }[];
  harvestedOutputs: RuntimeOutputAttachment[];
  /** `throws` models an unreadable outbox; `incomplete` alone models a partial harvest. */
  harvestFailure: { incomplete: boolean; throws?: boolean } | null;
  clearedOutboxes: string[];
}

export function fakePorts(store: MemoryRuntimeStore): FakePorts {
  const log: string[] = [];
  // One ordered log across ports and store, so a test can prove the durable record commits before
  // the external ACK rather than merely that both happened.
  store.effectLog = log;
  const promptCalls: FakePorts["promptCalls"] = [];
  const decisionCalls: FakePorts["decisionCalls"] = [];
  const eventReads: unknown[] = [];
  const stagedAttachments: FakePorts["stagedAttachments"] = [];
  const harvestedOutputs: RuntimeOutputAttachment[] = [];
  const clearedOutboxes: string[] = [];
  const harvest: { failure: { incomplete: boolean; throws?: boolean } | null } = { failure: null };
  const box: RuntimeBoxControl = {
    findGenerationBoxes: async ({ companionId, generation }) => ({
      name: `Companion ${companionId} g${generation.toString()}`,
      canonical: { id: BOX_ID, name: `Companion ${companionId} g${generation.toString()}` },
      duplicates: [],
    }),
    createGenerationBox: async ({ companionId, generation }) => ({
      outcome: "created",
      boxId: BOX_ID,
      name: `Companion ${companionId} g${generation.toString()}`,
    }),
    applyGenerationBoxSettings: async () => undefined,
    getStatus: async () => ({ state: "ready" }),
    setTtl: async () => { log.push("ttl"); },
    stopExistingBox: async () => undefined,
    resumeExistingBox: async () => undefined,
    requestPermanentDeletion: async () => ({ outcome: "absent" }),
    pollPermanentDeletion: async () => ({ status: "completed" }),
  };
  const pi: RuntimePiControl = {
    stopPiDaemon: async () => undefined,
    startPiDaemon: async () => ({ state: "idle", invocationId: PI_INVOCATION_ID }),
    restartPiDaemon: async () => ({ state: "idle", invocationId: PI_INVOCATION_ID }),
    piDaemonStatus: async () => ({ state: "idle", invocationId: PI_INVOCATION_ID }),
    brokerState: async () => ({
      invocationId: PI_INVOCATION_ID,
      activeAttemptId: store.authorization.dispatchState === "accepted" ? ATTEMPT_ID : null,
      tailCursor: store.authorization.eventCursor ?? 0n,
      acknowledgedCursor: store.authorization.eventCursor ?? 0n,
      counters: {
        malformedLines: 0,
        oversizedLines: 0,
        unterminatedLines: 0,
        unknownEvents: 0,
        unboundEvents: 0,
        orphanResponses: 0,
      },
      modelInput: ["text"],
    }),
    prompt: async (input) => {
      promptCalls.push({ attemptId: input.attemptId, message: input.message });
      return { outcome: "accepted", invocationId: PI_INVOCATION_ID };
    },
    readBrokerEvents: async () => eventReads.shift() ?? {
      events: [],
      nextCursor: Number(store.authorization.eventCursor ?? 0n),
      acknowledgedCursor: Number(store.authorization.eventCursor ?? 0n),
      hasMore: false,
    },
    ackBrokerEvents: async ({ through }) => {
      log.push("ack");
      return through;
    },
    respondExtensionUi: async (input) => {
      decisionCalls.push({ attemptId: input.attemptId });
      return { outcome: "accepted", invocationId: PI_INVOCATION_ID };
    },
  };
  const resourceStager: RuntimeResourceStager = {
    stageExistingBox: async (input) => ({
      diskLayoutVersion: 14,
      appliedSettingsRevision: input.targetSettingsRevision,
      appliedSkillsRevision: input.targetSkillsRevision,
    }),
    refreshLayout: async () => ({ applied: "none" }),
    invalidateLayout: async () => undefined,
  };
  const eventProjector: RuntimeEventProjector = {
    projectEventBatch: async (input) => {
      log.push("project");
      return await store.projectEventBatch(input.fence, {
        expectedSequence: input.expectedSequence,
        piInvocationId: input.piInvocationId,
        events: input.projections,
        throughCursor: input.throughCursor,
        ...(input.activityAt ? { activityAt: input.activityAt } : {}),
        unknownEventCount: input.unknownEventCount,
        malformedEventCount: input.malformedEventCount,
        oversizedEventCount: input.oversizedEventCount,
      });
    },
  };
  const attachmentStager: RuntimeAttachmentStager = {
    stageAttachments: async (input) => {
      log.push("stage-attachments");
      stagedAttachments.push({
        messageEventId: input.messageEventId,
        filenames: input.material.attachments.map((attachment) => attachment.filename),
      });
      return input.material.attachments.map((attachment) => ({
        position: attachment.position,
        filename: attachment.filename,
        contentType: attachment.contentType,
        byteSize: attachment.byteSize,
        path: `~/attachments/${input.messageEventId.slice(4)}/${attachment.position}-${attachment.filename}`,
      }));
    },
  };
  const outboxHarvester: RuntimeOutboxHarvester = {
    clearOutbox: async ({ boxId }) => {
      log.push("clear-outbox");
      clearedOutboxes.push(boxId);
    },
    harvestOutbox: async () => {
      log.push("harvest-outbox");
      if (harvest.failure?.throws) throw new Error("outbox read failed");
      return {
        attachments: [...harvestedOutputs],
        incomplete: harvest.failure?.incomplete ?? false,
      };
    },
  };
  return {
    box,
    pi,
    resourceStager,
    attachmentStager,
    outboxHarvester,
    eventProjector,
    log,
    promptCalls,
    decisionCalls,
    eventReads,
    stagedAttachments,
    harvestedOutputs,
    get harvestFailure() {
      return harvest.failure;
    },
    set harvestFailure(value: { incomplete: boolean; throws?: boolean } | null) {
      harvest.failure = value;
    },
    clearedOutboxes,
  };
}

export function engineDependencies(input: {
  store: MemoryRuntimeStore;
  clock?: TestClock;
  ports?: FakePorts;
  materialProvider?: RuntimeMaterialProvider;
  log?: RuntimeEngineDependencies["log"];
}): RuntimeEngineDependencies {
  const ports = input.ports ?? fakePorts(input.store);
  return {
    store: input.store,
    box: ports.box,
    pi: ports.pi,
    materialProvider: input.materialProvider ?? {
      getMaterial: async () => ({ ...input.store.material }),
    },
    projectionRedactorFactory: {
      forMaterial: () => (value) => value,
    },
    resourceStager: ports.resourceStager,
    attachmentStager: ports.attachmentStager,
    outboxHarvester: ports.outboxHarvester,
    eventProjector: ports.eventProjector,
    idFactory: { uuid: () => COMMAND_ID },
    clock: input.clock ?? new TestClock(),
    jitter: () => 0.5,
    executorId: "executor-test",
    eventPollIntervalMs: 1,
    ...(input.log ? { log: input.log } : {}),
  };
}
