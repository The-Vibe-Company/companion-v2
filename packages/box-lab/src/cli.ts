#!/usr/bin/env node

import { BOX_LAB_CLI_USAGE, resolveLocalSmokeSelection } from "./cliOptions";
import { runBoxLabLeasedActivity } from "./cliLifecycle";
import { resolveBoxLabConfig, type BoxLabConfig } from "./config";
import { createBoxLabDriver } from "./factory";
import { BoxLabService } from "./lab";
import { createBoxLabServer, type BoxLabServerHandle } from "./server";
import { runBoxLabSmoke } from "./smoke";
import { resetBoxLab } from "./reset";
import { BoxLabStateStore } from "./state";
import {
  acquireBoxLabActivityLease,
  BoxLabWorkspaceLockError,
} from "./workspaceLock";

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
  const service = serviceFor(config);
  const lease = await acquireBoxLabActivityLease(config.stateDirectory);
  let handle: BoxLabServerHandle | undefined;
  const signal = await runBoxLabLeasedActivity({
    lease,
    async run() {
      handle = createBoxLabServer({ config, service });
      await handle.listen();
      output({
        type: "box-lab.ready",
        baseUrl: handle.baseUrl,
        driver: config.driver,
        workspaceId: config.workspaceId,
      });
      return await new Promise<"SIGINT" | "SIGTERM">((resolvePromise) => {
        const onInterrupt = (): void => {
          process.off("SIGTERM", onTerminate);
          resolvePromise("SIGINT");
        };
        const onTerminate = (): void => {
          process.off("SIGINT", onInterrupt);
          resolvePromise("SIGTERM");
        };
        process.once("SIGINT", onInterrupt);
        process.once("SIGTERM", onTerminate);
      });
    },
    async drain() {
      if (handle) await handle.close();
      else await service.close();
    },
  });
  output({ type: "box-lab.stopped", signal });
  process.exitCode = 0;
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
  const lease = await acquireBoxLabActivityLease(config.stateDirectory);
  try {
    await runBoxLabSmoke({
      config,
      driver: createBoxLabDriver(config),
      ...selection,
      env,
      report: output,
    });
  } finally {
    await lease.release();
  }
}

async function reset(config: BoxLabConfig): Promise<void> {
  const result = await resetBoxLab(config);
  output({ type: "box-lab.reset", ok: true, result });
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
      const service = serviceFor(config);
      const lease = await acquireBoxLabActivityLease(config.stateDirectory);
      process.exitCode = await runBoxLabLeasedActivity({
        lease,
        run: async () => await service.shell(boxId),
        drain: async () => await service.close(),
      });
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
  const code = error instanceof BoxLabWorkspaceLockError
    ? error.code
    : "box_lab_command_failed";
  output({ ok: false, type: "box-lab.error", code, message });
  process.exitCode = 1;
});
