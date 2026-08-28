#!/usr/bin/env node

import { access, rm } from "node:fs/promises";

import { BOX_LAB_CLI_USAGE, resolveLocalSmokeSelection } from "./cliOptions";
import { resolveBoxLabConfig, type BoxLabConfig } from "./config";
import { createBoxLabDriver } from "./factory";
import { BoxLabService } from "./lab";
import { createBoxLabServer } from "./server";
import { runBoxLabSmoke } from "./smoke";
import { BoxLabStateStore } from "./state";

interface BoxLabCliOutput {
  type: string;
  [key: string]: string | number | boolean | null | undefined;
}

function output(value: BoxLabCliOutput): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function serviceFor(config: BoxLabConfig): BoxLabService {
  return new BoxLabService({
    driver: createBoxLabDriver(config),
    store: new BoxLabStateStore(config.stateDirectory, config.workspaceScope),
    resourcePrefix: config.resourcePrefix,
    diagnosticsDirectory: config.diagnosticsDirectory,
  });
}

async function doctor(config: BoxLabConfig): Promise<boolean> {
  const checks = await createBoxLabDriver(config).doctor();
  for (const check of checks) output({ type: "box-lab.doctor", driver: config.driver, ...check });
  const ok = checks.every((check) => check.ok);
  output({ type: "box-lab.doctor.complete", driver: config.driver, ok });
  return ok;
}

async function dev(config: BoxLabConfig): Promise<void> {
  const handle = createBoxLabServer({ config, service: serviceFor(config) });
  await handle.listen();
  output({
    type: "box-lab.ready",
    baseUrl: handle.baseUrl,
    driver: config.driver,
    workspaceId: config.workspaceId,
  });
  let closing = false;
  const close = (signal: string): void => {
    if (closing) return;
    closing = true;
    void handle.close().then(() => {
      output({ type: "box-lab.stopped", signal });
      process.exitCode = 0;
    }).catch(() => {
      process.exitCode = 1;
    });
  };
  process.once("SIGINT", () => close("SIGINT"));
  process.once("SIGTERM", () => close("SIGTERM"));
}

function isolatedSmokeConfig(env: NodeJS.ProcessEnv): BoxLabConfig {
  const base = resolveBoxLabConfig(env);
  const scopedEnv: NodeJS.ProcessEnv = {
    ...env,
    BOX_LAB_WORKSPACE_ID: `${base.workspaceId}-smoke-${process.pid}`,
  };
  return resolveBoxLabConfig(scopedEnv);
}

async function smoke(env: NodeJS.ProcessEnv): Promise<void> {
  const selection = resolveLocalSmokeSelection(process.argv.slice(3));
  const config = isolatedSmokeConfig(env);
  await runBoxLabSmoke({
    config,
    driver: createBoxLabDriver(config),
    ...selection,
    env,
    report: output,
  });
}

async function reset(config: BoxLabConfig): Promise<void> {
  const statePath = new BoxLabStateStore(config.stateDirectory, config.workspaceScope).path;
  let knownState = true;
  try { await access(statePath); } catch { knownState = false; }
  try {
    await createBoxLabDriver(config).reset();
    await rm(config.stateDirectory, { recursive: true, force: true });
    output({ type: "box-lab.reset", ok: true, result: knownState ? "removed" : "already_clean" });
  } catch (error) {
    const missingDriver = error instanceof Error && "code" in error && error.code === "ENOENT";
    if (missingDriver && !knownState) {
      output({ type: "box-lab.reset", ok: true, result: "already_clean" });
      return;
    }
    throw error;
  }
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? "dev";
  const config = resolveBoxLabConfig();
  switch (command) {
    case "dev":
      await dev(config);
      return;
    case "doctor":
      if (!await doctor(config)) process.exitCode = 1;
      return;
    case "smoke":
      await smoke(process.env);
      return;
    case "shell": {
      const boxId = process.argv[3];
      if (!boxId) throw new Error("shell requires an exact Box id");
      process.exitCode = await serviceFor(config).shell(boxId);
      return;
    }
    case "reset":
      await reset(config);
      return;
    default:
      throw new Error(`Usage: ${BOX_LAB_CLI_USAGE}`);
  }
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : "Box Lab command failed";
  output({ ok: false, type: "box-lab.error", code: "box_lab_command_failed", message });
  process.exitCode = 1;
});
