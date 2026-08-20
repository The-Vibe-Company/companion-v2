import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { z } from "zod";

import {
  AsciiBoxCompanionRuntime,
  AsciiBoxMaintenanceClient,
  BoxRuntimeAdapterError,
  BoxRuntimeProviderError,
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

interface ReportEvent {
  phase: string;
  status: string;
  duration_ms?: number;
  total_duration_ms?: number;
  code?: string;
  resource_id?: string;
}
type BrokerEvent = Extract<
  CompanionPiBrokerEventPage["events"][number],
  { kind: "pi_event" }
>["event"];
type GenerationBoxCreator = Pick<BoxRuntimeLifecycleClient, "createOrRecoverGenerationBox">;

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
  return {
    env: { ...env, COMPANION_BOX_API_KEY: required(env, "COMPANION_BOX_API_KEY") },
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

export async function createGenerationBoxWithImageFallback(
  lifecycle: GenerationBoxCreator,
  input: Omit<BoxGenerationCreateInput, "from">,
  image: string | null,
): Promise<BoxGenerationCreateResult> {
  const createInput: BoxGenerationCreateInput = { ...input };
  if (image !== null) createInput.from = image;
  try {
    return await lifecycle.createOrRecoverGenerationBox(createInput);
  } catch (cause) {
    const staleImage = cause instanceof BoxRuntimeAdapterError
      && (cause.providerCode === "unknown_snapshot" || cause.stableCode === "box_not_found");
    if (image === null || !staleImage) throw cause;
    return await lifecycle.createOrRecoverGenerationBox(input);
  }
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

  const runtime = new AsciiBoxCompanionRuntime(config.env);
  const lifecycle = new AsciiBoxMaintenanceClient(config.env);
  const companionId = randomUUID();
  const orgId = randomUUID();
  const generation = config.generation;
  let boxId: string | null = null;
  let primaryError: Error | null = null;
  let cleanupError: Error | null = null;
  const startedAt = Date.now();
  try {
    await phase("create", async () => {
      const created = await createGenerationBoxWithImageFallback(lifecycle, {
        companionId,
        generation,
        ttlSeconds: 300,
        deadlineAt: Date.now() + 30_000,
      }, config.image);
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

    await phase("stage_current_change", async () => {
      if (boxId === null) throw new RuntimeChangeE2EError("box_id_unavailable");
      await runtime.resumeExistingBox({ boxId });
      await runtime.stageExistingBox({
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

    const initial = await phase("start_pi", async () => {
      if (boxId === null) throw new RuntimeChangeE2EError("box_id_unavailable");
      await runtime.restartPiDaemon({ boxId });
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
      const dispatch = await runtime.dispatchPrompt({
        boxId,
        attemptId,
        requestId: `runtime-change-e2e:${attemptId}`,
        message: `Reply with exactly ${marker} and no other text.`,
      });
      if (dispatch.outcome !== "accepted" || dispatch.attemptId !== attemptId) {
        throw new RuntimeChangeE2EError(`dispatch_${dispatch.outcome}`);
      }
      await waitForReply({
        runtime,
        boxId,
        attemptId,
        marker,
        cursor: initial.tailCursor,
      });
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
