import { setTimeout as sleep } from "node:timers/promises";
import { COMPANION_AGENT_VERSION } from "@companion/contracts";
import { CliError } from "../lib/errors";
import { acquireAgentLock } from "./lock";
import { loadAgentCredentials } from "./credentials";
import { buildHeartbeatPayload, postHeartbeat } from "./heartbeat";
import { appendAgentLog } from "./log";
import { writeAgentStatus } from "./statusFile";
import { updateStatusFromHeartbeat } from "./selfUpdate";

function jitteredDelayMs(intervalSeconds: number): number {
  const jitter = 0.9 + Math.random() * 0.2;
  return Math.round(intervalSeconds * 1000 * jitter);
}

async function beatOnce(): Promise<number> {
  const credentials = await loadAgentCredentials();
  if (!credentials) throw new CliError("agent is not installed. Run: companion agent install", 3);
  const payload = await buildHeartbeatPayload(credentials);
  const response = await postHeartbeat(credentials, payload);
  const update = updateStatusFromHeartbeat(response);
  const delayMs = jitteredDelayMs(response.interval_seconds);
  const now = new Date();
  await writeAgentStatus({
    schemaVersion: 1,
    pid: process.pid,
    lastBeatAt: now.toISOString(),
    nextBeatAt: new Date(now.getTime() + delayMs).toISOString(),
    ok: true,
    error: null,
    agentVersion: COMPANION_AGENT_VERSION,
    latestAgentVersion: update.latestVersion,
    updateAvailable: update.available,
    intervalSeconds: response.interval_seconds,
  });
  await appendAgentLog(`heartbeat ok next=${Math.round(delayMs / 1000)}s update=${update.available ? "yes" : "no"}`);
  return delayMs;
}

async function recordFailure(error: unknown): Promise<number> {
  const message = error instanceof Error ? error.message : String(error);
  const delayMs = 60_000;
  await writeAgentStatus({
    schemaVersion: 1,
    pid: process.pid,
    lastBeatAt: null,
    nextBeatAt: new Date(Date.now() + delayMs).toISOString(),
    ok: false,
    error: message,
    agentVersion: COMPANION_AGENT_VERSION,
    latestAgentVersion: null,
    updateAvailable: false,
    intervalSeconds: null,
  });
  await appendAgentLog(`heartbeat failed error=${message}`);
  return delayMs;
}

function isAbortError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "name" in error && error.name === "AbortError";
}

export async function sleepUntilNextBeat(delayMs: number, signal: AbortSignal): Promise<void> {
  try {
    await sleep(delayMs, undefined, { ref: true, signal });
  } catch (error) {
    if (signal.aborted && isAbortError(error)) return;
    throw error;
  }
}

export async function runAgentDaemon(opts: { once?: boolean } = {}): Promise<void> {
  const release = await acquireAgentLock();
  let stopping = false;
  const sleepAbort = new AbortController();
  const stop = () => {
    stopping = true;
    sleepAbort.abort();
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  try {
    do {
      let delayMs: number;
      try {
        delayMs = await beatOnce();
      } catch (error) {
        delayMs = await recordFailure(error);
      }
      if (opts.once || stopping) break;
      await sleepUntilNextBeat(delayMs, sleepAbort.signal);
    } while (!stopping);
  } finally {
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
    await release();
  }
}
