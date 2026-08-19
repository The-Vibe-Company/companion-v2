import type { RuntimeClock } from "./clock";
import type { RuntimeProcessLog } from "./logging";
import type { PiBrokerCounters, RuntimePiProjection } from "./piEvents";
import type { RuntimeVisibleTextRedactor } from "./projectionRedaction";
import type { RuntimeStore } from "./store";
import type {
  BoxObservedState,
  ClientSurface,
  LeaseFence,
  ModelInputCapability,
  PiObservedState,
  RuntimeAuthorization,
  RuntimeOutputAttachment,
  RuntimeWorkMaterial,
} from "./types";

export interface GenerationBox {
  id: string;
  name: string;
  state?: BoxObservedState;
}

export interface GenerationBoxDiscovery {
  name: string;
  canonical: GenerationBox | null;
  duplicates: GenerationBox[];
}

export type BoxCreateResult =
  | { outcome: "created"; boxId: string; name: string }
  | ({ outcome: "recovered"; boxId: string } & GenerationBoxDiscovery);

export type BoxDeleteRequest =
  | { outcome: "absent" }
  | { outcome: "accepted"; operationId: string };

/** `blocked` is in-progress at the provider; only `completed` is terminal success. */
export type BoxDeletePoll =
  | { status: "pending" | "processing" }
  | { status: "completed" }
  | { status: "blocked" };

export interface RuntimeBoxControl {
  findGenerationBoxes(input: {
    companionId: string;
    generation: bigint;
    deadlineAt?: Date;
    signal: AbortSignal;
  }): Promise<GenerationBoxDiscovery>;
  /** This is the sole Box-create port. Broad runtime `start()` methods are intentionally absent. */
  createGenerationBox(input: {
    companionId: string;
    generation: bigint;
    ttlSeconds: number;
    deadlineAt?: Date;
    signal: AbortSignal;
  }): Promise<BoxCreateResult>;
  applyGenerationBoxSettings(input: {
    boxId: string;
    companionId: string;
    generation: bigint;
    ttlSeconds: number;
    deadlineAt?: Date;
    signal: AbortSignal;
  }): Promise<void>;
  getStatus(input: { boxId: string; signal: AbortSignal }): Promise<{ state: BoxObservedState }>;
  setTtl(input: { boxId: string; ttlSeconds: number; signal: AbortSignal }): Promise<void>;
  stopExistingBox(input: { boxId: string; signal: AbortSignal }): Promise<void>;
  resumeExistingBox(input: { boxId: string; signal: AbortSignal }): Promise<void>;
  requestPermanentDeletion(input: {
    boxId: string;
    signal: AbortSignal;
  }): Promise<BoxDeleteRequest>;
  pollPermanentDeletion(input: {
    boxId: string;
    operationId: string;
    signal: AbortSignal;
  }): Promise<BoxDeletePoll>;
}

export type BrokerWriteOutcome =
  | { outcome: "accepted"; invocationId: string }
  | { outcome: "rejected"; code: string }
  | { outcome: "ambiguous"; code: string };

export interface RuntimePiControl {
  stopPiDaemon(input: { boxId: string; signal: AbortSignal }): Promise<void>;
  startPiDaemon(input: { boxId: string; signal: AbortSignal }): Promise<{
    state: PiObservedState;
    invocationId: string;
  }>;
  restartPiDaemon(input: { boxId: string; signal: AbortSignal }): Promise<{
    state: PiObservedState;
    invocationId: string;
  }>;
  piDaemonStatus(input: { boxId: string; signal: AbortSignal }): Promise<{
    state: PiObservedState;
    invocationId: string | null;
  }>;
  brokerState(input: { boxId: string; signal: AbortSignal }): Promise<{
    invocationId: string;
    activeAttemptId: string | null;
    tailCursor: bigint;
    acknowledgedCursor: bigint;
    counters: PiBrokerCounters;
    /** Current Pi `get_state.model.input`; never inferred from a global capability table. */
    modelInput: ModelInputCapability[];
  }>;
  prompt(input: {
    boxId: string;
    commandId: string;
    attemptId: string;
    message: string;
    signal: AbortSignal;
  }): Promise<BrokerWriteOutcome>;
  /** Best-effort Pi abort for an Owner/Editor stop. Does not go through the turn lease signal. */
  abort(input: {
    boxId: string;
    commandId: string;
    attemptId: string;
    signal: AbortSignal;
  }): Promise<BrokerWriteOutcome>;
  readBrokerEvents(input: {
    boxId: string;
    after: bigint;
    signal: AbortSignal;
  }): Promise<unknown>;
  ackBrokerEvents(input: {
    boxId: string;
    through: bigint;
    signal: AbortSignal;
  }): Promise<bigint>;
  respondExtensionUi(input: {
    boxId: string;
    commandId: string;
    attemptId: string;
    response: Record<string, unknown>;
    signal: AbortSignal;
  }): Promise<BrokerWriteOutcome>;
}

export interface RuntimeMaterialProvider {
  getMaterial(input: {
    store: RuntimeStore;
    fence: LeaseFence;
    signal?: AbortSignal;
  }): Promise<RuntimeWorkMaterial | null>;
}

export interface RuntimeProjectionRedactorFactory {
  forMaterial(input: {
    orgId: string;
    material: RuntimeWorkMaterial;
  }): RuntimeVisibleTextRedactor;
}

export interface RuntimeResourceStager {
  stageExistingBox(input: {
    orgId: string;
    companionId: string;
    boxId: string;
    allowBoxCreate: false;
    authorization: RuntimeAuthorization;
    material: RuntimeWorkMaterial;
    clientSurface: ClientSurface;
    targetSettingsRevision: bigint;
    targetSkillsRevision: number | null;
    signal: AbortSignal;
  }): Promise<{
    diskLayoutVersion: 14;
    appliedSettingsRevision: bigint;
    appliedSkillsRevision: number | null;
  }>;
  /**
   * Apply the current Pi layout to a Box that is already running. Overlay-only changes rewrite the
   * broker without reinstalling packages. The caller restarts Pi when `applied` is not `none`.
   */
  refreshLayout(input: {
    boxId: string;
    signal: AbortSignal;
  }): Promise<{ applied: "none" | "overlay" | "base" }>;
  /**
   * Drop the overlay suffix from the on-disk marker so the next refresh is not a no-op. Used when
   * files were rewritten but Pi could not be recycled.
   */
  invalidateLayout(input: {
    boxId: string;
    signal: AbortSignal;
  }): Promise<void>;
}

/** Where one attachment landed on the Box, as the prompt suffix will name it to Pi. */
export interface StagedRuntimeAttachment {
  position: number;
  filename: string;
  contentType: string;
  byteSize: number;
  path: string;
}

/**
 * Fetch a turn's uploaded files and land them read-only on the Box.
 *
 * This runs before the dispatch write intent is checkpointed, so a failure here is a proven
 * negative: no prompt was written, the turn fails with a retryable code, and a retry re-stages the
 * same paths idempotently.
 */
export interface RuntimeAttachmentStager {
  stageAttachments(input: {
    orgId: string;
    companionId: string;
    boxId: string;
    messageEventId: string;
    /** The files to stage live on the material; passing them twice would let the two disagree. */
    material: RuntimeWorkMaterial;
    authorization: RuntimeAuthorization;
    signal: AbortSignal;
  }): Promise<StagedRuntimeAttachment[]>;
}

/**
 * Pi's outbox: the one place on the Box where an image it produced becomes something the thread can
 * show.
 *
 * Both halves are bounded and neither may fail a turn. Clearing runs before dispatch so one attempt's
 * leftovers are never attributed to the next turn. Harvesting runs after Pi settles and before the
 * turn does; `incomplete` says some file could not be read whole, which is a degradation to log, not
 * a reply to retract.
 */
export interface RuntimeOutboxHarvester {
  clearOutbox(input: { boxId: string; signal: AbortSignal }): Promise<void>;
  harvestOutbox(input: {
    orgId: string;
    companionId: string;
    boxId: string;
    attemptId: string;
    /** Wall-clock bound for the whole harvest; whatever is complete by then is what gets recorded. */
    deadlineAt: Date;
    signal: AbortSignal;
  }): Promise<{ attachments: RuntimeOutputAttachment[]; incomplete: boolean }>;
}

export interface RuntimeEventProjector {
  projectEventBatch(input: {
    store: RuntimeStore;
    fence: LeaseFence;
    expectedSequence: bigint;
    piInvocationId: string;
    projections: RuntimePiProjection[];
    throughCursor: bigint;
    activityAt?: Date;
    unknownEventCount: number;
    malformedEventCount: number;
    oversizedEventCount: number;
  }): Promise<{
    checkpointSequence: bigint;
    eventCursor: bigint;
    hasVisibleOutput: boolean;
  } | null>;
}

export interface RuntimeIdFactory {
  uuid(): string;
}

export interface RuntimeEngineDependencies {
  store: RuntimeStore;
  box: RuntimeBoxControl;
  pi: RuntimePiControl;
  materialProvider: RuntimeMaterialProvider;
  projectionRedactorFactory: RuntimeProjectionRedactorFactory;
  resourceStager: RuntimeResourceStager;
  attachmentStager: RuntimeAttachmentStager;
  outboxHarvester: RuntimeOutboxHarvester;
  eventProjector: RuntimeEventProjector;
  idFactory: RuntimeIdFactory;
  clock: RuntimeClock;
  jitter: () => number;
  executorId: string;
  eventPollIntervalMs?: number;
  /** Process logs for failures. Absent in unit tests unless a test captures them. */
  log?: RuntimeProcessLog;
}

export const storeMaterialProvider: RuntimeMaterialProvider = {
  getMaterial: async ({ store, fence }) => await store.getMaterial(fence, 30),
};

export const storeEventProjector: RuntimeEventProjector = {
  projectEventBatch: async (input) => await input.store.projectEventBatch(input.fence, {
    expectedSequence: input.expectedSequence,
    piInvocationId: input.piInvocationId,
    events: input.projections,
    throughCursor: input.throughCursor,
    ...(input.activityAt ? { activityAt: input.activityAt } : {}),
    unknownEventCount: input.unknownEventCount,
    malformedEventCount: input.malformedEventCount,
    oversizedEventCount: input.oversizedEventCount,
  }),
};
