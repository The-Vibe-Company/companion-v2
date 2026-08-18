#!/usr/bin/env -S node --import tsx

import { pathToFileURL } from "node:url";

import { createBoxSimServer, type BoxSimServerHandle } from "./server";

function integerEnv(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative integer`);
  return parsed;
}

export async function runBoxSimCli(env: NodeJS.ProcessEnv = process.env): Promise<BoxSimServerHandle> {
  const server = createBoxSimServer({
    host: env.BOX_SIM_HOST?.trim() || "127.0.0.1",
    port: integerEnv(env.BOX_SIM_PORT, 13_400, "BOX_SIM_PORT"),
    apiKey: env.BOX_SIM_API_KEY?.trim() || "box-sim-api-key",
    controlToken: env.BOX_SIM_CONTROL_TOKEN?.trim() || "box-sim-control-token",
    bodyLimitBytes: integerEnv(
      env.BOX_SIM_BODY_LIMIT_BYTES,
      12 * 1024 * 1024,
      "BOX_SIM_BODY_LIMIT_BYTES",
    ),
  });
  await server.listen();
  process.stdout.write(`${JSON.stringify({
    type: "box-sim.ready",
    baseUrl: server.baseUrl,
    controlUrl: server.controlUrl,
  })}\n`);

  let closing = false;
  const close = (): void => {
    if (closing) return;
    closing = true;
    void server.close().catch((error: unknown) => {
      process.stderr.write(`box-sim shutdown failed: ${error instanceof Error ? error.message : "unknown error"}\n`);
      process.exitCode = 1;
    });
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
  return server;
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  runBoxSimCli().catch((error: unknown) => {
    process.stderr.write(`box-sim failed: ${error instanceof Error ? error.message : "unknown error"}\n`);
    process.exitCode = 1;
  });
}
