#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const DEFAULT_API_BASE = "https://ascii.dev/api/box/v1";
const REQUEST_TIMEOUT_MS = 30_000;
const READY_TIMEOUT_MS = 3 * 60_000;
const ARCHIVE_TIMEOUT_MS = 2 * 60_000;
const POLL_INTERVAL_MS = 1_000;
const BOX_ID_PATTERN = /^bx_[23456789abcdefghjkmnpqrstuvwxyz]{8}$/;
const DELETION_OPERATION_PATTERN = /^bdop_[a-f0-9]{32}$/;
const IMAGE_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
const SAFE_CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const RUNNING_STATES = new Set(["ready", "idle", "running"]);
const STARTING_STATES = new Set(["init", "provisioning", "provisioned", "cloning"]);

export class BoxProviderE2EError extends Error {
  constructor(code) {
    super(code);
    this.name = "BoxProviderE2EError";
    this.code = SAFE_CODE_PATTERN.test(code) ? code : "box_e2e_failed";
  }
}

function required(env, name) {
  const value = env[name]?.trim();
  if (!value) throw new BoxProviderE2EError("missing_configuration");
  return value;
}

function apiBase(raw) {
  let value;
  try {
    value = new URL(raw);
  } catch {
    throw new BoxProviderE2EError("invalid_configuration");
  }
  const loopback = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(value.hostname);
  if (
    (value.protocol !== "https:" && !(value.protocol === "http:" && loopback))
    || (!loopback && value.hostname !== "ascii.dev")
    || value.username
    || value.password
    || value.search
    || value.hash
  ) {
    throw new BoxProviderE2EError("invalid_configuration");
  }
  return value.toString().replace(/\/+$/, "");
}

export function loadBoxProviderE2EConfig(env = process.env) {
  const image = env.COMPANION_BOX_E2E_IMAGE?.trim() || null;
  if (image !== null && !IMAGE_PATTERN.test(image)) {
    throw new BoxProviderE2EError("invalid_configuration");
  }
  return {
    apiKey: required(env, "COMPANION_BOX_API_KEY"),
    apiBase: apiBase(env.COMPANION_BOX_E2E_API_BASE?.trim() || DEFAULT_API_BASE),
    image,
    requestTimeoutMs: REQUEST_TIMEOUT_MS,
    readyTimeoutMs: READY_TIMEOUT_MS,
    archiveTimeoutMs: ARCHIVE_TIMEOUT_MS,
    pollIntervalMs: POLL_INTERVAL_MS,
  };
}

function safeErrorCode(error) {
  return error instanceof BoxProviderE2EError ? error.code : "box_e2e_failed";
}

function boxState(body, expectedId) {
  const id = body?.box?.id;
  const state = body?.box?.state;
  if (id !== expectedId || typeof state !== "string") {
    throw new BoxProviderE2EError("invalid_provider_response");
  }
  return state;
}

function createClient(config, fetchImpl) {
  async function request(path, options = {}) {
    let response;
    try {
      response = await fetchImpl(`${config.apiBase}${path}`, {
        method: options.method ?? "GET",
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          accept: "application/json",
          ...(options.body === undefined ? {} : { "content-type": "application/json" }),
          ...options.headers,
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: AbortSignal.timeout(config.requestTimeoutMs),
      });
    } catch (error) {
      const timedOut = error && typeof error === "object" && error.name === "TimeoutError";
      throw new BoxProviderE2EError(timedOut ? "request_timeout" : "network_error");
    }

    if (options.allowNotFound && response.status === 404) {
      await response.body?.cancel().catch(() => undefined);
      return { status: 404, body: null };
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new BoxProviderE2EError(`http_${response.status}`);
    }
    let body;
    try {
      body = await response.json();
    } catch {
      throw new BoxProviderE2EError("invalid_provider_response");
    }
    return { status: response.status, body };
  }

  return { request };
}

async function pollUntil({ timeoutMs, intervalMs, now, sleep, check, timeoutCode }) {
  const deadline = now() + timeoutMs;
  for (;;) {
    const result = await check();
    if (result?.done) return result.value;
    const remaining = deadline - now();
    if (remaining <= 0) throw new BoxProviderE2EError(timeoutCode);
    await sleep(Math.min(intervalMs, remaining));
  }
}

async function runPhase(name, logger, now, action) {
  const startedAt = now();
  logger({ phase: name, status: "started" });
  try {
    const value = await action();
    logger({ phase: name, status: "succeeded", duration_ms: Math.max(0, now() - startedAt) });
    return value;
  } catch (error) {
    logger({
      phase: name,
      status: "failed",
      duration_ms: Math.max(0, now() - startedAt),
      code: safeErrorCode(error),
    });
    throw error;
  }
}

async function waitForState({ client, boxId, states, timeoutMs, timeoutCode, now, sleep, config }) {
  return await pollUntil({
    timeoutMs,
    intervalMs: config.pollIntervalMs,
    timeoutCode,
    now,
    sleep,
    check: async () => {
      const result = await client.request(`/boxes/${encodeURIComponent(boxId)}`);
      const state = boxState(result.body, boxId);
      if (state === "error") throw new BoxProviderE2EError("box_entered_error");
      if (states.has(state)) return { done: true, value: state };
      if (!STARTING_STATES.has(state) && state !== "archiving") {
        throw new BoxProviderE2EError("unexpected_box_state");
      }
      return { done: false };
    },
  });
}

async function runCommand(client, boxId, command, expectedMarker) {
  const result = await client.request(`/boxes/${encodeURIComponent(boxId)}/commands`, {
    method: "POST",
    body: { command, timeoutSeconds: 60 },
  });
  if (
    result.body?.success !== true
    || result.body?.exitCode !== 0
    || result.body?.stdout?.trim() !== expectedMarker
  ) {
    throw new BoxProviderE2EError("command_failed");
  }
}

async function archiveBox({ client, boxId, config, now, sleep }) {
  const observed = await client.request(`/boxes/${encodeURIComponent(boxId)}`, {
    allowNotFound: true,
  });
  if (observed.status === 404) return false;
  const state = boxState(observed.body, boxId);
  if (state !== "archived" && state !== "archiving") {
    await client.request(`/boxes/${encodeURIComponent(boxId)}/stop`, {
      method: "POST",
      body: { force: false },
    });
  }
  if (state !== "archived") {
    await waitForState({
      client,
      boxId,
      states: new Set(["archived"]),
      timeoutMs: config.archiveTimeoutMs,
      timeoutCode: "archive_timeout",
      now,
      sleep,
      config,
    });
  }
  return true;
}

async function deletePermanently({ client, boxId }) {
  const accepted = await client.request(`/boxes/${encodeURIComponent(boxId)}`, {
    method: "DELETE",
    headers: { "X-Ascii-Confirm-Delete": boxId },
    allowNotFound: true,
  });
  if (accepted.status === 404) return;
  const operation = accepted.body?.operation;
  if (
    accepted.status !== 202
    || !DELETION_OPERATION_PATTERN.test(operation?.id ?? "")
    || operation?.targetId !== boxId
    || !["pending", "processing", "blocked", "completed"].includes(operation?.status)
  ) {
    throw new BoxProviderE2EError("invalid_provider_response");
  }
  // Accepted deletion cannot be cancelled, and the provider removes the Box from normal reads
  // immediately while physical deletion continues asynchronously. The canary proves both parts
  // without turning an unrelated storage-cleanup backlog into a flaky, long-running CI job.
  const after = await client.request(`/boxes/${encodeURIComponent(boxId)}`, {
    allowNotFound: true,
  });
  if (after.status !== 404) throw new BoxProviderE2EError("box_still_visible_after_delete");
}

function persistenceCommands(sentinel) {
  const file = "$HOME/.companion-box-e2e.bin";
  const script = "$HOME/.companion-box-e2e-probe";
  const token = "$HOME/.companion-box-e2e-token";
  return {
    prepare: `set -euo pipefail
dd if=/dev/zero of="${file}" bs=1048576 count=8 status=none
printf '%s\\n' '${sentinel}' > "${token}"
printf '%s\\n' '#!/usr/bin/env bash' 'set -euo pipefail' 'sha256sum "$HOME/.companion-box-e2e.bin" >/dev/null' > "${script}"
chmod 700 "${script}"
test "$(stat -c '%s' "${file}")" = 8388608
"${script}"
printf '%s\\n' box-provider-e2e-prepared`,
    restore: `set -euo pipefail
test "$(cat "${token}")" = '${sentinel}'
test "$(stat -c '%s' "${file}")" = 8388608
"${script}"
find "$HOME" -maxdepth 1 -type f -name '.companion-box-e2e-*' -exec cat {} + >/dev/null
printf '%s\\n' box-provider-e2e-restored`,
  };
}

export async function runBoxProviderE2E(config, dependencies = {}) {
  const fetchImpl = dependencies.fetch ?? fetch;
  const uuid = dependencies.randomUUID ?? randomUUID;
  const now = dependencies.now ?? Date.now;
  const sleep = dependencies.sleep ?? ((milliseconds) => new Promise((resolveSleep) => {
    setTimeout(resolveSleep, milliseconds);
  }));
  const logger = dependencies.logger ?? (() => undefined);
  const client = createClient(config, fetchImpl);
  const sentinel = uuid().replaceAll("-", "").toUpperCase();
  const commands = persistenceCommands(sentinel);
  const startedAt = now();
  let boxId = null;
  let primaryError = null;
  let cleanupError = null;
  let cleanup = "not_needed";

  try {
    boxId = await runPhase("create", logger, now, async () => {
      const result = await client.request("/boxes", {
        method: "POST",
        body: {
          ttlSeconds: 300,
          noEnv: true,
          ...(config.image === null ? {} : { from: config.image }),
        },
      });
      const id = result.body?.box?.id;
      if (result.status !== 202 || !BOX_ID_PATTERN.test(id ?? "")) {
        throw new BoxProviderE2EError("invalid_provider_response");
      }
      return id;
    });

    await runPhase("first_command", logger, now, async () => {
      await waitForState({
        client,
        boxId,
        states: RUNNING_STATES,
        timeoutMs: config.readyTimeoutMs,
        timeoutCode: "ready_timeout",
        now,
        sleep,
        config,
      });
      await runCommand(client, boxId, commands.prepare, "box-provider-e2e-prepared");
    });

    await runPhase("archive", logger, now, async () => {
      await archiveBox({ client, boxId, config, now, sleep });
    });

    await runPhase("resume_and_verify", logger, now, async () => {
      await client.request(`/boxes/${encodeURIComponent(boxId)}/resume`, {
        method: "POST",
        body: { noEnv: true, ttlSeconds: 300 },
      });
      await waitForState({
        client,
        boxId,
        states: RUNNING_STATES,
        timeoutMs: config.readyTimeoutMs,
        timeoutCode: "resume_timeout",
        now,
        sleep,
        config,
      });
      await runCommand(client, boxId, commands.restore, "box-provider-e2e-restored");
    });
  } catch (error) {
    primaryError = error;
  } finally {
    if (boxId !== null) {
      const cleanupStartedAt = now();
      try {
        const present = await archiveBox({ client, boxId, config, now, sleep });
        if (present) await deletePermanently({ client, boxId });
        cleanup = "succeeded";
      } catch (error) {
        cleanupError = error;
        cleanup = "failed";
      }
      logger({
        phase: "cleanup",
        status: cleanup,
        duration_ms: Math.max(0, now() - cleanupStartedAt),
        ...(cleanupError === null ? {} : { code: safeErrorCode(cleanupError) }),
      });
    }
  }

  const failed = primaryError !== null || cleanup === "failed";
  const report = {
    phase: "box_provider_e2e",
    status: failed ? "failed" : "succeeded",
    ...(failed ? { code: primaryError ? safeErrorCode(primaryError) : "cleanup_failed" } : {}),
    source: config.image === null ? "base" : "named_snapshot",
    total_duration_ms: Math.max(0, now() - startedAt),
    cleanup,
  };
  logger(report);
  return report;
}

function writeEvent(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

export async function main(env = process.env) {
  let config;
  try {
    config = loadBoxProviderE2EConfig(env);
  } catch (error) {
    writeEvent({
      phase: "configuration",
      status: "not_configured",
      code: safeErrorCode(error),
      cleanup: "not_started",
    });
    return 2;
  }
  const report = await runBoxProviderE2E(config, { logger: writeEvent });
  return report.status === "succeeded" ? 0 : 1;
}

const entrypoint = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (entrypoint === import.meta.url) {
  process.exitCode = await main();
}
