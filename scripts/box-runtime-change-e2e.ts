import { randomUUID } from "node:crypto";

import {
  AsciiBoxCompanionRuntime,
  AsciiBoxMaintenanceClient,
  BoxRuntimeProviderError,
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

  const runtime = new AsciiBoxCompanionRuntime(config.env);
  const lifecycle = new AsciiBoxMaintenanceClient(config.env);
  const companionId = randomUUID();
  const orgId = randomUUID();
  const generation = config.generation;
  let boxId: string | null = null;
  let primaryError: unknown = null;
  let cleanupError: unknown = null;
  const startedAt = Date.now();
  try {
    await phase("create", async () => {
      const created = await lifecycle.createOrRecoverGenerationBox({
        companionId,
        generation,
        ttlSeconds: 300,
        deadlineAt: Date.now() + 30_000,
        ...(config.image === null ? {} : { from: config.image }),
      });
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
    phase: "runtime_change_e2e",
    status: failed ? "failed" : "succeeded",
    total_duration_ms: Date.now() - startedAt,
    ...(failed ? { code: primaryError ? safeCode(primaryError) : "cleanup_failed" } : {}),
  });
  return failed ? 1 : 0;
}

void main().then((exitCode) => {
  process.exitCode = exitCode;
});
