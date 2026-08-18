#!/usr/bin/env node

import { pathToFileURL } from "node:url";

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export async function waitForHttpReady({
  url,
  pid,
  timeoutMs,
  fetchImpl = globalThis.fetch,
  processAlive = (candidate) => {
    process.kill(candidate, 0);
    return true;
  },
  now = Date.now,
  sleep = delay,
}) {
  const deadline = now() + timeoutMs;
  for (;;) {
    try {
      if (!processAlive(pid)) throw new Error("process_exited");
    } catch {
      throw new Error("process_exited");
    }

    try {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(500) });
      await response.body?.cancel().catch(() => undefined);
      if (response.ok) return;
    } catch {
      // A connection refusal is expected while the child is binding.
    }

    const remaining = deadline - now();
    if (remaining <= 0) throw new Error("readiness_timeout");
    await sleep(Math.min(100, remaining));
  }
}

async function main(env = process.env) {
  const rawUrl = env.COMPANION_WAIT_READY_URL?.trim();
  const pid = Number(env.COMPANION_WAIT_READY_PID);
  const timeoutMs = Number(env.COMPANION_WAIT_READY_TIMEOUT_MS);
  let parsed;
  try {
    parsed = new URL(rawUrl ?? "");
  } catch {
    process.exitCode = 64;
    return;
  }
  if (
    parsed.protocol !== "http:"
    || !["127.0.0.1", "localhost", "::1", "[::1]"].includes(parsed.hostname)
    || !Number.isSafeInteger(pid)
    || pid <= 0
    || !Number.isSafeInteger(timeoutMs)
    || timeoutMs <= 0
    || timeoutMs > 60_000
  ) {
    process.exitCode = 64;
    return;
  }
  try {
    await waitForHttpReady({ url: parsed.toString(), pid, timeoutMs });
  } catch {
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
