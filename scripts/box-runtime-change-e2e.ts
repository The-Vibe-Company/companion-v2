import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { z } from "zod";

import {
  AsciiBoxCompanionRuntime,
  AsciiBoxMaintenanceClient,
  BoxRuntimeAdapterError,
  BoxRuntimeProviderError,
  isCompanionRuntimeImageName,
  type BoxGenerationCreateInput,
  type BoxGenerationCreateResult,
  type BoxRuntimeLifecycleClient,
  type CompanionPiBrokerEventPage,
} from "../packages/box-runtime/src/index";

const BOX_ID_PATTERN = /^bx_[23456789abcdefghjkmnpqrstuvwxyz]{8}$/;
const SAFE_CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const POLL_INTERVAL_MS = 1_000;
const REPLY_TIMEOUT_MS = 3 * 60_000;
const IMAGE_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
// A missing named snapshot must still exercise the same cold install as production. Pin Pi to the
// layout-14 fixture rather than letting a fallback float to an untested release.
const E2E_PI_INSTALL_COMMAND = "npm install --global @earendil-works/pi-coding-agent@0.84.2";

interface ReportEvent {
  phase: string;
  status: string;
  duration_ms?: number;
  total_duration_ms?: number;
  code?: string;
  resource_id?: string;
  staging_mode?: string;
  skill_bytes_transferred?: number;
  initial_cursor?: number;
  provider_call_count?: number;
  operation_counts?: Record<string, number>;
}
type BrokerEvent = Extract<
  CompanionPiBrokerEventPage["events"][number],
  { kind: "pi_event" }
>["event"];
const assistantTextBlockSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
}).passthrough();
const ignoredAssistantBlockSchema = z.object({}).passthrough().transform(() => null);
const assistantMessageEndSchema = z.object({
  type: z.literal("message_end"),
  message: z.object({
    role: z.literal("assistant"),
    content: z.array(z.union([assistantTextBlockSchema, ignoredAssistantBlockSchema])),
  }).passthrough(),
}).passthrough();

class RuntimeChangeE2EError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "RuntimeChangeE2EError";
    this.code = SAFE_CODE_PATTERN.test(code) ? code : "runtime_change_e2e_failed";
  }
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new RuntimeChangeE2EError("missing_configuration");
  return value;
}

function positiveInteger(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RuntimeChangeE2EError("invalid_configuration");
  }
  return value;
}

function configuration(env: NodeJS.ProcessEnv) {
  const image = env.COMPANION_BOX_E2E_IMAGE?.trim() || null;
  const modelId = env.COMPANION_BOX_E2E_MODEL_ID?.trim() || "glm-5.3";
  if (
    (image !== null && !IMAGE_PATTERN.test(image))
    || modelId.length > 200
    || /[\r\n\0]/.test(modelId)
  ) {
    throw new RuntimeChangeE2EError("invalid_configuration");
  }
  const runtimeEnv: NodeJS.ProcessEnv = {
    ...env,
    COMPANION_BOX_API_KEY: required(env, "COMPANION_BOX_API_KEY"),
  };
  return {
    env: runtimeEnv,
    zaiApiKey: required(env, "COMPANION_BOX_E2E_ZAI_API_KEY"),
    image,
    modelId,
    generation: positiveInteger(env.COMPANION_BOX_E2E_GENERATION, 1),
  };
}

function errorFromCause(cause: unknown): Error {
  return cause instanceof Error ? cause : new RuntimeChangeE2EError("runtime_change_e2e_failed");
}

function safeCode(cause: unknown): string {
  if (cause instanceof RuntimeChangeE2EError) return cause.code;
  if (cause instanceof BoxRuntimeProviderError && SAFE_CODE_PATTERN.test(cause.stableCode)) {
    return cause.stableCode;
  }
  return "runtime_change_e2e_failed";
}

function write(event: ReportEvent): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

async function phase<T>(name: string, action: () => Promise<T>): Promise<T> {
  const startedAt = Date.now();
  write({ phase: name, status: "started" });
  try {
    const result = await action();
    write({ phase: name, status: "succeeded", duration_ms: Date.now() - startedAt });
    return result;
  } catch (error) {
    write({
      phase: name,
      status: "failed",
      duration_ms: Date.now() - startedAt,
      code: safeCode(error),
    });
    throw error;
  }
}

function pause(milliseconds: number): Promise<void> {
  return new Promise((resolvePause) => setTimeout(resolvePause, milliseconds));
}

type RuntimeChangeCreateInput = Omit<BoxGenerationCreateInput, "from">;
type RuntimeChangeCreateClient = Pick<
  BoxRuntimeLifecycleClient,
  | "createOrRecoverGenerationBox"
  | "createGenerationBoxAfterObservedAbsence"
  | "listNamedSnapshots"
>;
interface RuntimeChangeCreation {
  box: BoxGenerationCreateResult;
  source: "base" | "named_snapshot" | "replacement_snapshot" | "base_fallback";
}

function isConfirmedMissingSnapshot(cause: unknown): boolean {
  return cause instanceof BoxRuntimeAdapterError
    && !cause.outcomeUnknown
    && !cause.retryable
    && cause.status < 500
    && (cause.providerCode === "unknown_snapshot" || cause.stableCode === "box_not_found");
}

export async function createRuntimeChangeGenerationBox(input: {
  lifecycle: RuntimeChangeCreateClient;
  create: RuntimeChangeCreateInput;
  image: string | null;
}): Promise<RuntimeChangeCreation> {
  const createInput: BoxGenerationCreateInput = { ...input.create };
  if (input.image !== null) createInput.from = input.image;
  try {
    const box = await input.lifecycle.createOrRecoverGenerationBox(createInput);
    return { box, source: input.image === null ? "base" : "named_snapshot" };
  } catch (cause) {
    if (input.image === null || !isConfirmedMissingSnapshot(cause)) throw cause;
    const snapshots = await input.lifecycle.listNamedSnapshots({
      deadlineAt: input.create.deadlineAt,
    });
    const replacement = snapshots
      .filter((snapshot) => snapshot.status === "ready"
        && snapshot.name !== input.image
        && isCompanionRuntimeImageName(snapshot.name))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
    const fallbackInput: BoxGenerationCreateInput = { ...input.create };
    if (replacement !== undefined) fallbackInput.from = replacement.name;
    const box = await input.lifecycle.createGenerationBoxAfterObservedAbsence(fallbackInput);
    return { box, source: replacement === undefined ? "base_fallback" : "replacement_snapshot" };
  }
}

async function waitForReadyBox(runtime: AsciiBoxCompanionRuntime, boxId: string): Promise<void> {
  const deadline = Date.now() + 3 * 60_000;
  while (Date.now() < deadline) {
    const observed = await runtime.existingBoxStatus({ boxId });
    if (observed.state === "ready" || observed.state === "idle" || observed.state === "running") {
      return;
    }
    if (observed.state === "error" || observed.state === "archived") {
      throw new RuntimeChangeE2EError("box_not_ready");
    }
    await pause(POLL_INTERVAL_MS);
  }
  throw new RuntimeChangeE2EError("box_ready_timeout");
}

async function waitForArchivedBox(runtime: AsciiBoxCompanionRuntime, boxId: string): Promise<void> {
  const deadline = Date.now() + 3 * 60_000;
  while (Date.now() < deadline) {
    const observed = await runtime.existingBoxStatus({ boxId });
    if (observed.state === "archived") return;
    if (observed.state === "error") throw new RuntimeChangeE2EError("box_archive_failed");
    await pause(POLL_INTERVAL_MS);
  }
  throw new RuntimeChangeE2EError("box_archive_timeout");
}

async function requestPermanentDeletionWithRetry(
  lifecycle: AsciiBoxMaintenanceClient,
  boxId: string,
): Promise<Awaited<ReturnType<AsciiBoxMaintenanceClient["requestPermanentDeletion"]>>> {
  let lastError: Error = new RuntimeChangeE2EError("cleanup_failed");
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await lifecycle.requestPermanentDeletion({
        boxId,
        deadlineAt: Date.now() + 30_000,
      });
    } catch (cause) {
      lastError = errorFromCause(cause);
      if (attempt < 3) await pause(1_000);
    }
  }
  throw lastError;
}

function assistantText(event: BrokerEvent): string | null {
  const parsed = assistantMessageEndSchema.safeParse(event);
  if (!parsed.success) return null;
  return parsed.data.message.content
    .flatMap((block) => block === null ? [] : [block.text])
    .join("");
}

async function waitForReply(input: {
  runtime: AsciiBoxCompanionRuntime;
  boxId: string;
  attemptId: string;
  marker: string;
  cursor: number;
}): Promise<void> {
  const deadline = Date.now() + REPLY_TIMEOUT_MS;
  let cursor = input.cursor;
  let settled = false;
  let replyMatched = false;

  while (Date.now() < deadline) {
    const page = await input.runtime.readEvents({ boxId: input.boxId, after: cursor });
    cursor = page.nextCursor;
    for (const record of page.events) {
      if (record.attemptId !== input.attemptId) continue;
      if (record.kind === "pi_process_exit") {
        throw new RuntimeChangeE2EError("pi_process_exited");
      }
      if (record.event.type === "agent_settled") settled = true;
      const text = assistantText(record.event);
      if (text?.includes(input.marker)) replyMatched = true;
    }

    const state = await input.runtime.brokerState({ boxId: input.boxId });
    if (settled && state.activeAttemptId === null) {
      if (!replyMatched) throw new RuntimeChangeE2EError("reply_marker_missing");
      await input.runtime.ackEvents({ boxId: input.boxId, through: cursor });
      return;
    }
    await pause(POLL_INTERVAL_MS);
  }
  throw new RuntimeChangeE2EError("reply_timeout");
}

async function main(): Promise<number> {
  let config: ReturnType<typeof configuration>;
  try {
    config = configuration(process.env);
  } catch (error) {
    write({ phase: "configuration", status: "not_configured", code: safeCode(error) });
    return 2;
  }

  const providerCalls: string[] = [];
  const recordProviderCall = (sample: { operation: string }) => providerCalls.push(sample.operation);
  const runtime = new AsciiBoxCompanionRuntime({
    ...config.env,
    COMPANION_PI_INSTALL_COMMAND:
      config.env.COMPANION_PI_INSTALL_COMMAND?.trim() || E2E_PI_INSTALL_COMMAND,
  }, { onTiming: recordProviderCall });
  const lifecycle = new AsciiBoxMaintenanceClient(config.env, { onTiming: recordProviderCall });
  const companionId = randomUUID();
  const orgId = randomUUID();
  const generation = config.generation;
  let boxId: string | null = null;
  let primaryError: Error | null = null;
  let cleanupError: Error | null = null;
  let providerReadyAt: number | null = null;
  let providerStartAt: number | null = null;
  const startedAt = Date.now();
  try {
    await phase("create", async () => {
      providerStartAt = Date.now();
      const creation = await createRuntimeChangeGenerationBox({
        lifecycle,
        image: config.image,
        create: {
          companionId,
          generation,
          ttlSeconds: 300,
          deadlineAt: Date.now() + 30_000,
        },
      });
      const created = creation.box;
      if (creation.source === "base_fallback" || creation.source === "replacement_snapshot") {
        write({
          phase: "create_image_fallback",
          status: "succeeded",
          code: creation.source,
        });
      }
      if (!BOX_ID_PATTERN.test(created.boxId)) {
        throw new RuntimeChangeE2EError("invalid_provider_response");
      }
      boxId = created.boxId;
      await lifecycle.applyGenerationBoxSettings({
        boxId,
        companionId,
        generation,
        ttlSeconds: 900,
        deadlineAt: Date.now() + 30_000,
      });
    });

    const staged = await phase("stage_current_change", async () => {
      if (boxId === null) throw new RuntimeChangeE2EError("box_id_unavailable");
      await waitForReadyBox(runtime, boxId);
      providerReadyAt = Date.now();
      if (providerStartAt !== null) {
        write({
          phase: "provider_start",
          status: "succeeded",
          duration_ms: providerReadyAt - providerStartAt,
        });
      }
      return await runtime.stageExistingBox({
        companionId,
        runtimeGeneration: generation,
        orgId,
        boxId,
        clientSurface: "web",
        providerAuth: { zai: { type: "api_key", key: config.zaiApiKey } },
        replaceProviderAuth: true,
        modelId: config.modelId,
        mcpCredentials: [],
        mcpAccounts: [],
        skills: [],
        instructions: "You are a CI delivery probe. Follow the user request exactly.",
      });
    });
    write({
      phase: "staging_stats",
      status: "succeeded",
      staging_mode: staged.stagingMode,
      skill_bytes_transferred: staged.skillBytesTransferred,
    });

    const initial = await phase("start_pi", async () => {
      if (boxId === null) throw new RuntimeChangeE2EError("box_id_unavailable");
      await runtime.startPiDaemon({ boxId });
      const state = await runtime.brokerState({ boxId });
      if (state.activeAttemptId !== null) {
        throw new RuntimeChangeE2EError("unexpected_active_attempt");
      }
      return state;
    });

    await phase("first_message", async () => {
      if (boxId === null) throw new RuntimeChangeE2EError("box_id_unavailable");
      const attemptId = randomUUID();
      const marker = `E2E_${randomUUID().replaceAll("-", "").toUpperCase()}`;
      const promptAckStartedAt = Date.now();
      const dispatch = await runtime.dispatchPrompt({
        boxId,
        attemptId,
        requestId: `runtime-change-e2e:${attemptId}`,
        message: `Reply with exactly ${marker} and no other text.`,
      });
      if (dispatch.outcome !== "accepted" || dispatch.attemptId !== attemptId) {
        throw new RuntimeChangeE2EError(`dispatch_${dispatch.outcome}`);
      }
      write({
        phase: "prompt_ack",
        status: "succeeded",
        duration_ms: Date.now() - promptAckStartedAt,
        initial_cursor: dispatch.initialCursor,
      });
      if (providerReadyAt !== null) {
        write({
          phase: "ready_to_prompt_ack",
          status: "succeeded",
          duration_ms: Date.now() - providerReadyAt,
        });
      }
      await waitForReply({
        runtime,
        boxId,
        attemptId,
        marker,
        cursor: initial.tailCursor,
      });
    });

    await phase("stop_archive", async () => {
      if (boxId === null) throw new RuntimeChangeE2EError("box_id_unavailable");
      await runtime.stopPiDaemon({ boxId });
      await runtime.archiveExistingBox({ boxId });
      await waitForArchivedBox(runtime, boxId);
    });

    let resumeReadyAt = 0;
    const resumeStartedAt = Date.now();
    await phase("resume", async () => {
      if (boxId === null) throw new RuntimeChangeE2EError("box_id_unavailable");
      await runtime.resumeExistingBox({ boxId });
      await waitForReadyBox(runtime, boxId);
      resumeReadyAt = Date.now();
      write({
        phase: "resume_provider_start",
        status: "succeeded",
        duration_ms: resumeReadyAt - resumeStartedAt,
      });
      const refreshed = await runtime.stageExistingBox({
        companionId,
        runtimeGeneration: generation,
        orgId,
        boxId,
        clientSurface: "web",
        providerAuth: { zai: { type: "api_key", key: config.zaiApiKey } },
        replaceProviderAuth: false,
        modelId: config.modelId,
        mcpCredentials: [],
        mcpAccounts: [],
        skills: [],
        reuseSkills: true,
        instructions: "You are a CI delivery probe. Follow the user request exactly.",
      });
      write({
        phase: "resume_staging_stats",
        status: "succeeded",
        staging_mode: refreshed.stagingMode,
        skill_bytes_transferred: refreshed.skillBytesTransferred,
      });
      await runtime.startPiDaemon({ boxId });
    });

    if (boxId === null) throw new RuntimeChangeE2EError("box_id_unavailable");
    const resumed = await runtime.brokerState({ boxId });
    await phase("resume_message", async () => {
      if (boxId === null) throw new RuntimeChangeE2EError("box_id_unavailable");
      const attemptId = randomUUID();
      const marker = `E2E_RESUME_${randomUUID().replaceAll("-", "").toUpperCase()}`;
      const ackStartedAt = Date.now();
      const dispatch = await runtime.dispatchPrompt({
        boxId,
        attemptId,
        requestId: `runtime-change-e2e-resume:${attemptId}`,
        message: `Reply with exactly ${marker} and no other text.`,
      });
      if (dispatch.outcome !== "accepted" || dispatch.attemptId !== attemptId) {
        throw new RuntimeChangeE2EError(`dispatch_${dispatch.outcome}`);
      }
      write({
        phase: "resume_prompt_ack",
        status: "succeeded",
        duration_ms: Date.now() - ackStartedAt,
        initial_cursor: dispatch.initialCursor,
      });
      write({
        phase: "resume_ready_to_prompt_ack",
        status: "succeeded",
        duration_ms: Date.now() - resumeReadyAt,
      });
      await waitForReply({ runtime, boxId, attemptId, marker, cursor: resumed.tailCursor });
    });
  } catch (cause) {
    primaryError = errorFromCause(cause);
  } finally {
    const cleanupStartedAt = Date.now();
    try {
      if (boxId !== null) {
        await runtime.stopPiDaemon({ boxId }).catch(() => undefined);
        let credentialsCleared = true;
        try {
          await runtime.clearPersistedProviderAuth({ boxId });
        } catch {
          credentialsCleared = false;
        }
        let deletion;
        try {
          deletion = await requestPermanentDeletionWithRetry(lifecycle, boxId);
        } catch (cause) {
          if (!credentialsCleared) {
            throw new RuntimeChangeE2EError("credentials_and_delete_cleanup_failed");
          }
          throw cause;
        }
        if (deletion.outcome !== "absent" && deletion.operation.targetId !== boxId) {
          throw new RuntimeChangeE2EError("invalid_provider_response");
        }
        try {
          await runtime.existingBoxStatus({ boxId });
          throw new RuntimeChangeE2EError("box_still_visible_after_delete");
        } catch (cause) {
          if (!(cause instanceof BoxRuntimeProviderError) || cause.status !== 404) throw cause;
        }
      }
    } catch (cause) {
      cleanupError = errorFromCause(cause);
    }
    const cleanupEvent: ReportEvent = {
      phase: "cleanup",
      status: cleanupError === null ? "succeeded" : "failed",
      duration_ms: Date.now() - cleanupStartedAt,
    };
    if (cleanupError !== null) cleanupEvent.code = safeCode(cleanupError);
    if (cleanupError !== null && boxId !== null) cleanupEvent.resource_id = boxId;
    write(cleanupEvent);
  }

  const failed = primaryError !== null || cleanupError !== null;
  write({
    phase: "provider_call_stats",
    status: "succeeded",
    provider_call_count: providerCalls.length,
    operation_counts: Object.fromEntries(
      [...new Set(providerCalls)].sort().map((operation) => [
        operation,
        providerCalls.filter((candidate) => candidate === operation).length,
      ]),
    ),
  });
  const resultEvent: ReportEvent = {
    phase: "runtime_change_e2e",
    status: failed ? "failed" : "succeeded",
    total_duration_ms: Date.now() - startedAt,
  };
  if (failed) resultEvent.code = primaryError ? safeCode(primaryError) : "cleanup_failed";
  write(resultEvent);
  return failed ? 1 : 0;
}

const entryPath = process.argv[1];
if (entryPath !== undefined && import.meta.url === pathToFileURL(entryPath).href) {
  void main().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
