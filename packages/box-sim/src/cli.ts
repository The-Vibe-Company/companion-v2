#!/usr/bin/env -S node --import tsx

/* oxlint-disable anti-slop/no-unknown-parameters -- Existing CLI rejection boundaries predate the incremental anti-slop gate. */

import { pathToFileURL } from "node:url";

import { createBoxSimServer, type BoxSimServerHandle, type BoxSimServerOptions } from "./server";

/** The single machine-readable line the CLI prints once every listener is bound. */
interface BoxSimReadyLine {
  type: "box-sim.ready";
  baseUrl: string;
  controlUrl: string;
  agentUrl?: string;
}

function integerEnv(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative integer`);
  return parsed;
}

export async function runBoxSimCli(env: NodeJS.ProcessEnv = process.env): Promise<BoxSimServerHandle> {
  const agentPortValue = env.BOX_SIM_AGENT_PORT?.trim();
  const options: BoxSimServerOptions = {
    host: env.BOX_SIM_HOST?.trim() || "127.0.0.1",
    port: integerEnv(env.BOX_SIM_PORT, 13_400, "BOX_SIM_PORT"),
    apiKey: env.BOX_SIM_API_KEY?.trim() || "box-sim-api-key",
    controlToken: env.BOX_SIM_CONTROL_TOKEN?.trim() || "box-sim-control-token",
    bodyLimitBytes: integerEnv(
      env.BOX_SIM_BODY_LIMIT_BYTES,
      12 * 1024 * 1024,
      "BOX_SIM_BODY_LIMIT_BYTES",
    ),
  };
  // The agent listener is opt-in: without BOX_SIM_AGENT_PORT the CLI keeps its historical single
  // provider listener, and hosted agent URLs minted by registrations stay deliberately unroutable.
  if (agentPortValue) options.agentPort = integerEnv(agentPortValue, 0, "BOX_SIM_AGENT_PORT");
  const server = createBoxSimServer(options);
  await server.listen();
  const ready: BoxSimReadyLine = {
    type: "box-sim.ready",
    baseUrl: server.baseUrl,
    controlUrl: server.controlUrl,
  };
  if (agentPortValue) ready.agentUrl = server.agentBaseUrl;
  process.stdout.write(`${JSON.stringify(ready)}\n`);

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
