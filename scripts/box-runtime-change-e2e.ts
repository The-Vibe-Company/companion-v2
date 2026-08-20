import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

import {
  AsciiBoxCompanionRuntime,
  AsciiBoxMaintenanceClient,
  BoxRuntimeAdapterError,
  BoxRuntimeProviderError,
  type BoxGenerationCreateInput,
  type BoxGenerationCreateResult,
  type BoxRuntimeLifecycleClient,
} from "../packages/box-runtime/src/index";

const BOX_ID_PATTERN = /^bx_[23456789abcdefghjkmnpqrstuvwxyz]{8}$/;
const SAFE_CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const POLL_INTERVAL_MS = 1_000;
const REPLY_TIMEOUT_MS = 3 * 60_000;
const IMAGE_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

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
  return {
    env: { ...env, COMPANION_BOX_API_KEY: required(env, "COMPANION_BOX_API_KEY") },
    zaiApiKey: required(env, "COMPANION_BOX_E2E_ZAI_API_KEY"),
    image,
    modelId,
    generation: positiveInteger(env.COMPANION_BOX_E2E_GENERATION, 1),
  };
}

function safeCode(error: unknown): string {
  if (error instanceof RuntimeChangeE2EError) return error.code;
  if (error && typeof error === "object" && "stableCode" in error) {
    const value = String(error.stableCode);
    if (SAFE_CODE_PATTERN.test(value)) return value;
  }
  return "runtime_change_e2e_failed";
}

function write(event: Record<string, unknown>): void {
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
  "createOrRecoverGenerationBox" | "createGenerationBoxAfterObservedAbsence"
>;

export async function createRuntimeChangeGenerationBox(input: {
  lifecycle: RuntimeChangeCreateClient;
  create: RuntimeChangeCreateInput;
  image: string | null;
}): Promise<{
  box: BoxGenerationCreateResult;
  source: "base" | "named_snapshot" | "base_fallback";
}> {
  try {
    const box = await input.lifecycle.createOrRecoverGenerationBox({
      ...input.create,
      ...(input.image === null ? {} : { from: input.image }),
    });
    return { box, source: input.image === null ? "base" : "named_snapshot" };
  } catch (error) {
    const missingSnapshot = error instanceof BoxRuntimeAdapterError
      && !error.outcomeUnknown
      && !error.retryable
      && error.status < 500
      && (error.providerCode === "unknown_snapshot" || error.stableCode === "box_not_found");
    if (input.image === null || !missingSnapshot) throw error;
    const box = await input.lifecycle.createGenerationBoxAfterObservedAbsence(input.create);
    return { box, source: "base_fallback" };
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
  let lastError: unknown = new RuntimeChangeE2EError("cleanup_failed");
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await lifecycle.requestPermanentDeletion({
        boxId,
        deadlineAt: Date.now() + 30_000,
      });
    } catch (error) {
      lastError = error;
      if (attempt < 3) await pause(1_000);
    }
  }
  throw lastError;
}

function assistantText(event: Record<string, unknown>): string | null {
  if (event.type !== "message_end") return null;
  const message = event.message;
  if (!message || typeof message !== "object" || !("role" in message) || message.role !== "assistant") {
    return null;
  }
  if (!("content" in message) || !Array.isArray(message.content)) return null;
  return message.content
    .filter((block): block is { type: "text"; text: string } =>
      Boolean(block)
      && typeof block === "object"
      && "type" in block
      && block.type === "text"
      && "text" in block
      && typeof block.text === "string")
    .map((block) => block.text)
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
  const runtime = new AsciiBoxCompanionRuntime(config.env, { onTiming: recordProviderCall });
  const lifecycle = new AsciiBoxMaintenanceClient(config.env, { onTiming: recordProviderCall });
  const companionId = randomUUID();
  const orgId = randomUUID();
  const generation = config.generation;
  let boxId: string | null = null;
  let primaryError: unknown = null;
  let cleanupError: unknown = null;
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
      if (creation.source === "base_fallback") {
        write({
          phase: "create_image_fallback",
          status: "succeeded",
          code: "unknown_snapshot",
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
  } catch (error) {
    primaryError = error;
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
        } catch (error) {
          if (!credentialsCleared) {
            throw new RuntimeChangeE2EError("credentials_and_delete_cleanup_failed");
          }
          throw error;
        }
        if (deletion.outcome !== "absent" && deletion.operation.targetId !== boxId) {
          throw new RuntimeChangeE2EError("invalid_provider_response");
        }
        try {
          await runtime.existingBoxStatus({ boxId });
          throw new RuntimeChangeE2EError("box_still_visible_after_delete");
        } catch (error) {
          if (!(error instanceof BoxRuntimeProviderError) || error.status !== 404) throw error;
        }
      }
    } catch (error) {
      cleanupError = error;
    }
    write({
      phase: "cleanup",
      status: cleanupError === null ? "succeeded" : "failed",
      duration_ms: Date.now() - cleanupStartedAt,
      ...(cleanupError === null ? {} : { code: safeCode(cleanupError) }),
      ...(cleanupError === null || boxId === null ? {} : { resource_id: boxId }),
    });
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
  write({
    phase: "runtime_change_e2e",
    status: failed ? "failed" : "succeeded",
    total_duration_ms: Date.now() - startedAt,
    ...(failed ? { code: primaryError ? safeCode(primaryError) : "cleanup_failed" } : {}),
  });
  return failed ? 1 : 0;
}

const entrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (entrypoint === import.meta.url) {
  void main().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
