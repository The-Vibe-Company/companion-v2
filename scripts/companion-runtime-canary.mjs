#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const POLL_INTERVAL_MS = 3_000;
const REQUEST_TIMEOUT_MS = 30_000;
const COLD_REPLY_TIMEOUT_MS = 3 * 60_000;
const HOT_REPLY_TIMEOUT_MS = 10 * 60_000 + POLL_INTERVAL_MS;
const LIFECYCLE_TIMEOUT_MS = 10 * 60_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

export class CompanionCanaryError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = "CompanionCanaryError";
    this.code = SAFE_CODE_PATTERN.test(code) ? code : "canary_failed";
  }
}

function required(env, name) {
  const value = env[name]?.trim();
  if (!value) throw new CompanionCanaryError("missing_configuration");
  return value;
}

function serviceUrl(raw, name) {
  let value;
  try {
    value = new URL(raw);
  } catch {
    throw new CompanionCanaryError("invalid_configuration", `${name} is invalid`);
  }
  const loopback = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(value.hostname);
  if (
    (value.protocol !== "https:" && !(value.protocol === "http:" && loopback))
    || value.username
    || value.password
    || value.search
    || value.hash
  ) {
    throw new CompanionCanaryError("invalid_configuration", `${name} is invalid`);
  }
  return value.toString().replace(/\/+$/, "");
}

function publicImageUrl(raw) {
  const requiredRaw = required({ COMPANION_CANARY_IMAGE_URL: raw }, "COMPANION_CANARY_IMAGE_URL");
  let value;
  try {
    value = new URL(requiredRaw);
  } catch {
    throw new CompanionCanaryError("invalid_configuration", "image URL is invalid");
  }
  const loopback = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(value.hostname);
  if (
    (value.protocol !== "https:" && !(value.protocol === "http:" && loopback))
    || value.username
    || value.password
    || value.search
    || value.hash
  ) {
    throw new CompanionCanaryError("invalid_configuration", "image URL is invalid");
  }
  return value.toString();
}

function imageExpectedText(raw) {
  const value = required(
    { COMPANION_CANARY_IMAGE_EXPECTED_TEXT: raw },
    "COMPANION_CANARY_IMAGE_EXPECTED_TEXT",
  );
  if (!/^[A-Z0-9][A-Z0-9_-]{3,63}$/.test(value)) {
    throw new CompanionCanaryError("invalid_configuration", "image expected text is invalid");
  }
  return value;
}

function releaseId(raw) {
  const value = String(raw ?? "").trim();
  if (
    !value
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)
    || value === "unknown"
    || value === "local"
    || value === "local-development"
  ) {
    throw new CompanionCanaryError("invalid_configuration", "release ID is invalid");
  }
  return value;
}

function safeReleaseId(raw) {
  try {
    return releaseId(raw);
  } catch {
    return "unknown";
  }
}

function runLabel(env, uuid) {
  const runId = env.GITHUB_RUN_ID?.trim()
    || env.COMPANION_CANARY_RUN_ID?.trim()
    || `manual-${uuid()}`;
  const raw = `${runId}-${env.GITHUB_RUN_ATTEMPT ?? "1"}`;
  return raw.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 72) || "manual-1";
}

function assertImageUrlDoesNotRevealExpectedText(imageUrl, expectedText) {
  let decoded = imageUrl;
  // Every changing decode removes at least one percent escape, so the input
  // length is a deterministic upper bound even for deliberately nested URLs.
  for (let index = 0; index <= imageUrl.length; index += 1) {
    let next;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      throw new CompanionCanaryError(
        "invalid_configuration",
        "image URL contains invalid percent encoding",
      );
    }
    if (next === decoded) break;
    decoded = next;
    if (index === imageUrl.length) {
      throw new CompanionCanaryError("invalid_configuration");
    }
  }
  if (decoded.toLocaleUpperCase("en-US").includes(expectedText.toLocaleUpperCase("en-US"))) {
    throw new CompanionCanaryError(
      "invalid_configuration",
      "image URL must not reveal the expected text",
    );
  }
}

export function loadCompanionCanaryConfig(env = process.env, dependencies = {}) {
  const apiUrl = serviceUrl(required(env, "COMPANION_CANARY_API_URL"), "API URL");
  const orgId = required(env, "COMPANION_CANARY_ORG_ID");
  const providerId = required(env, "COMPANION_CANARY_PROVIDER_ID");
  const modelId = required(env, "COMPANION_CANARY_MODEL_ID");
  if (!UUID_PATTERN.test(orgId) || !/^[a-z][a-z0-9-]{0,62}$/.test(providerId)) {
    throw new CompanionCanaryError("invalid_configuration");
  }
  if (!modelId || modelId.length > 200 || /[\r\n\0]/.test(modelId)) {
    throw new CompanionCanaryError("invalid_configuration");
  }
  const imageUrl = publicImageUrl(env.COMPANION_CANARY_IMAGE_URL?.trim());
  const expectedText = imageExpectedText(env.COMPANION_CANARY_IMAGE_EXPECTED_TEXT);
  assertImageUrlDoesNotRevealExpectedText(imageUrl, expectedText);
  return {
    apiUrl,
    email: required(env, "COMPANION_CANARY_EMAIL"),
    password: required(env, "COMPANION_CANARY_PASSWORD"),
    orgId,
    providerId,
    modelId,
    imageUrl,
    imageExpectedText: expectedText,
    runLabel: runLabel(env, dependencies.randomUUID ?? randomUUID),
    releaseId: releaseId(env.COMPANION_CANARY_RELEASE_ID || env.GITHUB_SHA),
    pollIntervalMs: POLL_INTERVAL_MS,
    requestTimeoutMs: REQUEST_TIMEOUT_MS,
    coldReplyTimeoutMs: COLD_REPLY_TIMEOUT_MS,
    hotReplyTimeoutMs: HOT_REPLY_TIMEOUT_MS,
    lifecycleTimeoutMs: LIFECYCLE_TIMEOUT_MS,
  };
}

function splitSetCookie(value) {
  return value.split(/,(?=\s*[^;,\s]+=)/g);
}

function responseCookies(headers) {
  const values = typeof headers.getSetCookie === "function" ? headers.getSetCookie() : [];
  if (values.length > 0) return values;
  const fallback = headers.get("set-cookie");
  return fallback ? splitSetCookie(fallback) : [];
}

async function responseCode(response) {
  // Do not even parse an error body: upstream payloads may contain provider diagnostics or material
  // that must never reach a canary exception, reporter, or workflow log.
  await response.body?.cancel().catch(() => undefined);
  return `http_${response.status}`;
}

function createApiClient(config, fetchImpl) {
  const cookies = new Map();

  function cookieHeader() {
    return [...cookies].map(([name, value]) => `${name}=${value}`).join("; ");
  }

  async function request(path, options = {}) {
    const headers = new Headers({ accept: "application/json" });
    if (options.body !== undefined) headers.set("content-type", "application/json");
    if (options.org !== false) headers.set("x-companion-org", config.orgId);
    if (options.idempotencyKey) headers.set("Idempotency-Key", options.idempotencyKey);
    const cookie = cookieHeader();
    if (cookie) headers.set("cookie", cookie);

    let response;
    try {
      response = await fetchImpl(new URL(path, `${config.apiUrl}/`), {
        method: options.method ?? "GET",
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        redirect: "manual",
        signal: AbortSignal.timeout(config.requestTimeoutMs),
      });
    } catch (error) {
      const timedOut = error && typeof error === "object" && error.name === "TimeoutError";
      throw new CompanionCanaryError(timedOut ? "request_timeout" : "network_error");
    }

    for (const value of responseCookies(response.headers)) {
      const pair = value.split(";", 1)[0];
      const separator = pair.indexOf("=");
      if (separator > 0) cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
    }
    if (options.allowNotFound && response.status === 404) {
      return { status: response.status, data: null };
    }
    if (!response.ok) throw new CompanionCanaryError(await responseCode(response));

    const text = await response.text();
    if (!text) return { status: response.status, data: null };
    try {
      return { status: response.status, data: JSON.parse(text) };
    } catch {
      throw new CompanionCanaryError("invalid_api_response");
    }
  }

  return { request };
}

function safeErrorCode(error) {
  return error instanceof CompanionCanaryError ? error.code : "canary_failed";
}

function generationFrom(companion) {
  const value = companion?.runtime?.generation;
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

async function pollUntil({ timeoutMs, intervalMs, now, sleep, check, timeoutCode }) {
  const deadline = now() + timeoutMs;
  for (;;) {
    const result = await check();
    if (result?.done) return result.value;
    const remaining = deadline - now();
    if (remaining <= 0) throw new CompanionCanaryError(timeoutCode);
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

function marker(prefix, uuid) {
  return `CANARY_${prefix}_${uuid.replaceAll("-", "").toUpperCase()}`;
}

async function sendAndWaitForReply({
  api,
  companionId,
  content,
  requiredReplyValues,
  clientMessageId,
  timeoutMs,
  config,
  now,
  sleep,
}) {
  const accepted = await api.request(`/v1/companions/${encodeURIComponent(companionId)}/messages`, {
    method: "POST",
    body: { content, client_message_id: clientMessageId, client_surface: "web" },
  });
  if (accepted.status !== 202 || typeof accepted.data?.turn?.id !== "string") {
    throw new CompanionCanaryError("send_not_accepted");
  }
  const turnId = accepted.data.turn.id;
  const userEventId = `msg:${clientMessageId}`;

  await pollUntil({
    timeoutMs,
    intervalMs: config.pollIntervalMs,
    now,
    sleep,
    timeoutCode: "reply_timeout",
    check: async () => {
      const result = await api.request(
        `/v1/companions/${encodeURIComponent(companionId)}/thread`,
      );
      const thread = result.data?.thread;
      if (!thread || !Array.isArray(thread.entries)) {
        throw new CompanionCanaryError("invalid_thread_projection");
      }
      if (thread.interrupted_turn?.id === turnId) {
        throw new CompanionCanaryError("turn_interrupted");
      }
      const user = thread.entries.find((entry) => entry?.event_id === userEventId);
      const reply = user
        ? thread.entries.find(
          (entry) => entry?.role === "assistant"
            && Number(entry.ordinal) > Number(user.ordinal)
            && typeof entry.content === "string"
            && requiredReplyValues.every((value) => entry.content.includes(value)),
        )
        : null;
      const finished = user
        && thread.active_turn === null
        && thread.interrupted_turn === null
        && Number(thread.queued_count ?? 0) === 0;
      if (reply && finished) return { done: true };
      if (finished) throw new CompanionCanaryError("uncorrelated_or_failed_reply");
      return { done: false };
    },
  });
}

async function verifyPublicImage(config, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(config.imageUrl, {
      method: "GET",
      redirect: "follow",
      signal: AbortSignal.timeout(config.requestTimeoutMs),
    });
  } catch (error) {
    const timedOut = error && typeof error === "object" && error.name === "TimeoutError";
    throw new CompanionCanaryError(timedOut ? "image_timeout" : "image_unreachable");
  }
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  await response.body?.cancel().catch(() => undefined);
  if (!response.ok || !contentType.startsWith("image/")) {
    throw new CompanionCanaryError("image_fixture_invalid");
  }
}

async function waitForStopped({ api, companionId, config, now, sleep }) {
  await pollUntil({
    timeoutMs: config.lifecycleTimeoutMs,
    intervalMs: config.pollIntervalMs,
    now,
    sleep,
    timeoutCode: "stop_timeout",
    check: async () => {
      const result = await api.request(
        `/v1/companions/${encodeURIComponent(companionId)}/runtime`,
      );
      const state = result.data?.companion?.runtime?.state;
      if (state === "stopped") return { done: true };
      if (state === "error") throw new CompanionCanaryError("stop_failed");
      return { done: false };
    },
  });
}

async function waitForDeleted({ api, companionId, config, now, sleep }) {
  await pollUntil({
    timeoutMs: config.lifecycleTimeoutMs,
    intervalMs: config.pollIntervalMs,
    now,
    sleep,
    timeoutCode: "delete_timeout",
    check: async () => {
      const result = await api.request(`/v1/companions/${encodeURIComponent(companionId)}`, {
        allowNotFound: true,
      });
      if (result.status === 404) return { done: true };
      if (result.data?.companion?.runtime?.state === "error") {
        throw new CompanionCanaryError("delete_failed");
      }
      return { done: false };
    },
  });
}

function acceptedOperation(result, kind) {
  if (
    result.status !== 202
    || result.data?.operation?.kind !== kind
    || typeof result.data.operation.id !== "string"
  ) {
    throw new CompanionCanaryError("operation_not_accepted");
  }
}

export async function runCompanionRuntimeCanary(config, dependencies = {}) {
  const fetchImpl = dependencies.fetch ?? globalThis.fetch;
  const now = dependencies.now ?? Date.now;
  const sleep = dependencies.sleep ?? ((milliseconds) => new Promise(
    (resolveSleep) => setTimeout(resolveSleep, milliseconds),
  ));
  const uuid = dependencies.randomUUID ?? randomUUID;
  const logger = dependencies.logger ?? (() => undefined);
  const api = createApiClient(config, fetchImpl);

  const companionName = `Runtime canary ${config.runLabel}`.slice(0, 120);
  let authenticated = false;
  let companionId = null;
  let generation = null;
  let deleted = false;
  let primaryError = null;
  let cleanup = "not_needed";
  const deleteRequestId = uuid();

  try {
    await runPhase("release", logger, now, async () => {
      const result = await api.request("/health", { org: false });
      if (result.data?.release_id !== config.releaseId) {
        throw new CompanionCanaryError("release_mismatch");
      }
    });

    await runPhase("login", logger, now, async () => {
      const result = await api.request("/v1/auth/login", {
        method: "POST",
        org: false,
        body: { email: config.email, password: config.password },
      });
      if (result.status !== 200) throw new CompanionCanaryError("login_failed");
      authenticated = true;
    });

    const created = await runPhase("create", logger, now, async () => {
      const result = await api.request("/v1/companions", {
        method: "POST",
        body: {
          name: companionName,
          persona: "Disposable daily Box/Pi reliability canary.",
          provider_id: config.providerId,
          model_id: config.modelId,
          selected_skill_ids: [],
          selected_mcp_account_ids: [],
          can_write_skills: false,
        },
      });
      if (result.status !== 201 || !UUID_PATTERN.test(result.data?.companion?.id ?? "")) {
        throw new CompanionCanaryError("create_failed");
      }
      const createdGeneration = generationFrom(result.data.companion);
      if (createdGeneration === null) {
        throw new CompanionCanaryError("invalid_runtime_generation");
      }
      return { companion: result.data.companion, generation: createdGeneration };
    });
    companionId = created.companion.id;
    generation = created.generation;

    await runPhase("cold_send", logger, now, async () => {
      const clientMessageId = uuid();
      const correlation = marker("COLD", uuid());
      await sendAndWaitForReply({
        api,
        companionId,
        clientMessageId,
        requiredReplyValues: [correlation],
        content: `Reply with this exact correlation token and no other text: ${correlation}`,
        timeoutMs: config.coldReplyTimeoutMs,
        config,
        now,
        sleep,
      });
    });

    await runPhase("image_fixture", logger, now, async () => {
      await verifyPublicImage(config, fetchImpl);
    });

    await runPhase("vision", logger, now, async () => {
      const clientMessageId = uuid();
      const correlation = marker("VISION", uuid());
      const content = [
        `Download ${config.imageUrl} to /tmp/companion-canary-image.png.`,
        "Use the read tool on that local image and verify that pixels were actually inspected.",
        "Transcribe the exact uppercase canary code visible inside the image.",
        `Then reply with ${correlation}, that code, and one short visual description.`,
      ].join(" ");
      await sendAndWaitForReply({
        api,
        companionId,
        clientMessageId,
        requiredReplyValues: [correlation, config.imageExpectedText],
        content,
        timeoutMs: config.hotReplyTimeoutMs,
        config,
        now,
        sleep,
      });
    });

    await runPhase("stop", logger, now, async () => {
      const result = await api.request(
        `/v1/companions/${encodeURIComponent(companionId)}/runtime/stop`,
        { method: "POST", body: {}, idempotencyKey: uuid() },
      );
      acceptedOperation(result, "stop");
      await waitForStopped({ api, companionId, config, now, sleep });
    });

    await runPhase("wake_send", logger, now, async () => {
      const clientMessageId = uuid();
      const correlation = marker("WAKE", uuid());
      await sendAndWaitForReply({
        api,
        companionId,
        clientMessageId,
        requiredReplyValues: [correlation],
        content: `Wake only because of this send, then reply exactly: ${correlation}`,
        timeoutMs: config.coldReplyTimeoutMs,
        config,
        now,
        sleep,
      });
    });

    await runPhase("delete", logger, now, async () => {
      const result = await api.request(`/v1/companions/${encodeURIComponent(companionId)}`, {
        method: "DELETE",
        idempotencyKey: deleteRequestId,
      });
      acceptedOperation(result, "delete");
      await waitForDeleted({ api, companionId, config, now, sleep });
      deleted = true;
    });
  } catch (error) {
    primaryError = error;
  } finally {
    const cleanupStartedAt = now();
    if (!deleted && authenticated) {
      try {
        let cleanupIds = companionId ? [companionId] : [];
        if (cleanupIds.length === 0) {
          const roster = await api.request("/v1/companions?preview=false");
          const companions = Array.isArray(roster.data?.companions) ? roster.data.companions : [];
          cleanupIds = companions
            .filter((candidate) => candidate?.name === companionName && UUID_PATTERN.test(candidate?.id ?? ""))
            .map((candidate) => candidate.id);
        }
        for (const cleanupId of cleanupIds) {
          const result = await api.request(`/v1/companions/${encodeURIComponent(cleanupId)}`, {
            method: "DELETE",
            idempotencyKey: cleanupId === companionId ? deleteRequestId : uuid(),
            allowNotFound: true,
          });
          if (result.status !== 404) {
            acceptedOperation(result, "delete");
            await waitForDeleted({ api, companionId: cleanupId, config, now, sleep });
          }
        }
        deleted = cleanupIds.length > 0;
        cleanup = cleanupIds.length > 0 ? "succeeded" : "not_needed";
      } catch {
        cleanup = "failed";
      }
    }
    logger({
      phase: "cleanup",
      status: cleanup,
      duration_ms: Math.max(0, now() - cleanupStartedAt),
    });
  }

  const failed = primaryError !== null || cleanup === "failed";
  const report = {
    phase: "canary",
    status: failed ? "failed" : "succeeded",
    ...(failed ? { code: primaryError ? safeErrorCode(primaryError) : "cleanup_failed" } : {}),
    generation,
    release_id: config.releaseId,
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
    config = loadCompanionCanaryConfig(env);
  } catch (error) {
    writeEvent({
      phase: "configuration",
      status: "not_configured",
      code: safeErrorCode(error),
      release_id: safeReleaseId(env.COMPANION_CANARY_RELEASE_ID || env.GITHUB_SHA),
      cleanup: "not_started",
    });
    return 2;
  }
  const report = await runCompanionRuntimeCanary(config, { logger: writeEvent });
  return report.status === "succeeded" ? 0 : 1;
}

const entrypoint = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (entrypoint === import.meta.url) {
  process.exitCode = await main();
}
