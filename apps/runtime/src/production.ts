import {
  AsciiBoxCompanionRuntime,
  AsciiBoxMaintenanceClient,
  type BoxRuntimeLifecycleClient,
  type CompanionBoxRuntimeV2,
  type CompanionRuntimeSkill,
} from "@companion/box-runtime";
import {
  createRuntimeKernel,
  PostgresRuntimeStore,
  type CreateRuntimeKernelInput,
  type RuntimeBoxControl,
  type RuntimePiControl,
  type RuntimeResourceStager,
  type RuntimeStore,
} from "@companion/companion-runtime";
import {
  createStorageClient,
  getSkillArchive,
  getStorageConfig,
} from "@companion/storage";

import { createRuntimeBoxControl, createRuntimePiControl } from "./boxAdapters";
import { composeRuntimeService, type RuntimeService } from "./composition";
import { loadRuntimeServiceConfig, type RuntimeServiceConfig } from "./config";
import { createRuntimeDatabase, type RuntimeDatabase } from "./database";
import {
  createRuntimeDesktopPort,
  PostgresRuntimeDesktopAuthorizer,
  PostgresRuntimeDesktopReplayGuard,
} from "./desktop";
import {
  createRuntimeMaterialPipeline,
  loadBundledCompanionRuntimeSkill,
} from "./materialPipeline";
import {
  createRuntimeSchedulerAdapter,
  type RuntimeKernelScheduler,
} from "./schedulerAdapter";

export interface RuntimeArchiveStorage {
  load(storagePath: string, signal: AbortSignal): Promise<Buffer>;
  close(): void | Promise<void>;
}

export interface RuntimeProductionFactories {
  createDatabase(config: RuntimeServiceConfig): RuntimeDatabase;
  createStore(database: RuntimeDatabase): RuntimeStore;
  createLifecycle(env: NodeJS.ProcessEnv): BoxRuntimeLifecycleClient;
  createBoxRuntime(env: NodeJS.ProcessEnv): CompanionBoxRuntimeV2;
  createArchiveStorage(): RuntimeArchiveStorage;
  loadBundledSkill(): Promise<CompanionRuntimeSkill>;
  createKernel(input: CreateRuntimeKernelInput): { scheduler: RuntimeKernelScheduler };
}

export interface BuildProductionRuntimeOptions {
  env?: NodeJS.ProcessEnv;
  factories?: Partial<RuntimeProductionFactories>;
}

const defaultFactories: RuntimeProductionFactories = {
  createDatabase: createRuntimeDatabase,
  createStore: (database) => new PostgresRuntimeStore(database.sql),
  createLifecycle: (env) => new AsciiBoxMaintenanceClient(env),
  createBoxRuntime: (env) => new AsciiBoxCompanionRuntime(env),
  createArchiveStorage: () => {
    const config = getStorageConfig();
    const client = createStorageClient(config);
    return {
      load: async (storagePath, signal) => await getSkillArchive({
        key: storagePath,
        signal,
        client,
        config,
      }),
      close: () => client.destroy(),
    };
  },
  loadBundledSkill: loadBundledCompanionRuntimeSkill,
  createKernel: (input) => createRuntimeKernel(input),
};

/** Build the sole process that may claim Runtime v2 work or contact Box/Pi. */
export async function buildProductionRuntimeService(
  options: BuildProductionRuntimeOptions = {},
): Promise<RuntimeService> {
  const env = options.env ?? process.env;
  const factories: RuntimeProductionFactories = {
    ...defaultFactories,
    ...options.factories,
  };
  const config = loadRuntimeServiceConfig(env);
  const database = factories.createDatabase(config);
  let archiveStorage: RuntimeArchiveStorage | null = null;
  const closeResources = resourceCloser({
    database,
    archiveStorage: () => archiveStorage,
    config,
  });

  try {
    // A valid URL is insufficient: a mistakenly privileged API/owner login must fail startup.
    await database.verifyRole();
    const store = factories.createStore(database);
    if (!config.companionsEnabled) {
      const kernel = factories.createKernel({
        store,
        box: disabledBoxControl,
        pi: disabledPiControl,
        resourceStager: disabledResourceStager,
        executorId: config.executorId,
        concurrency: config.concurrency,
        sweepIntervalMs: config.sweepIntervalMs,
        claimsEnabled: false,
      });
      return composeRuntimeService({
        config,
        store,
        scheduler: createRuntimeSchedulerAdapter(kernel.scheduler),
        closeResources,
      });
    }

    const boxEnv = runtimeBoxEnvironment(config, env);
    const lifecycle = factories.createLifecycle(boxEnv);
    // Staging is a multi-request transaction with one shared abort budget. Keep adapter instances
    // call-local so that budget cannot leak into a later lifecycle or broker operation.
    const freshRuntime = (): CompanionBoxRuntimeV2 => factories.createBoxRuntime(boxEnv);
    archiveStorage = factories.createArchiveStorage();
    const bundledSkill = await factories.loadBundledSkill();
    const material = createRuntimeMaterialPipeline({
      masterKey: config.masterKey,
      apiUrl: config.apiUrl,
      bundledSkill,
      runtime: freshRuntime,
      loadSkillArchive: async (storagePath, signal) => {
        const storage = archiveStorage;
        if (!storage) throw new Error("runtime archive storage is closed");
        return await storage.load(storagePath, signal);
      },
    });
    const adapters = { lifecycle, runtime: freshRuntime };
    const kernel = factories.createKernel({
      store,
      box: createRuntimeBoxControl(adapters),
      pi: createRuntimePiControl(adapters),
      materialProvider: material.materialProvider,
      projectionRedactorFactory: material.projectionRedactorFactory,
      resourceStager: material.resourceStager,
      executorId: config.executorId,
      concurrency: config.concurrency,
      sweepIntervalMs: config.sweepIntervalMs,
      claimsEnabled: true,
    });
    const desktop = createRuntimeDesktopPort({
      authorization: new PostgresRuntimeDesktopAuthorizer(database.sql),
      box: {
        desktop: async (input) => await freshRuntime().desktop(input),
      },
    });
    return composeRuntimeService({
      config,
      store,
      scheduler: createRuntimeSchedulerAdapter(kernel.scheduler),
      desktop,
      desktopReplay: new PostgresRuntimeDesktopReplayGuard(database.sql),
      closeResources,
    });
  } catch (error) {
    await closeResources().catch(() => undefined);
    throw error;
  }
}

const BOX_RUNTIME_ENV_KEYS = [
  "COMPANION_BOX_ENVIRONMENT",
  "COMPANION_BOX_POLL_INTERVAL_MS",
  "COMPANION_BOX_READY_TIMEOUT_MS",
  "COMPANION_BOX_DESKTOP_MINT_BUDGET_MS",
  "COMPANION_PI_BROKER_COMMAND",
  "COMPANION_PI_BROKER_SOCKET",
  "COMPANION_PI_BROKER_TIMEOUT_MS",
  "COMPANION_PI_DAEMON_ACTIVE_TIMEOUT_MS",
  "COMPANION_PI_INSTALL_COMMAND",
  "COMPANION_PI_MCP_ADAPTER_PACKAGE",
] as const;

/** Construct the Box-only environment without forwarding database or encryption credentials. */
export function runtimeBoxEnvironment(
  config: Extract<RuntimeServiceConfig, { companionsEnabled: true }>,
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {
    COMPANION_BOX_API_KEY: config.boxApiKey,
    COMPANION_BOX_API_BASE: config.boxApiBase,
    COMPANION_BOX_TTL_SECONDS: String(config.boxTtlSeconds),
  };
  for (const key of BOX_RUNTIME_ENV_KEYS) {
    const value = env[key];
    if (value !== undefined) result[key] = value;
  }
  return result;
}

function resourceCloser(input: {
  database: RuntimeDatabase;
  archiveStorage(): RuntimeArchiveStorage | null;
  config: RuntimeServiceConfig;
}): () => Promise<void> {
  let closing: Promise<void> | null = null;
  return () => {
    closing ??= (async () => {
      let failure: unknown;
      try {
        await input.archiveStorage()?.close();
      } catch (error) {
        failure = error;
      }
      try {
        await input.database.close();
      } catch (error) {
        failure ??= error;
      } finally {
        input.config.masterKey?.fill(0);
        input.config.desktopHmacSecret?.fill(0);
      }
      if (failure) throw failure;
    })();
    return closing;
  };
}

function runtimeDisabled(): never {
  throw new Error("runtime external ports are disabled");
}

const disabledBoxControl: RuntimeBoxControl = {
  findGenerationBoxes: async () => runtimeDisabled(),
  createGenerationBox: async () => runtimeDisabled(),
  applyGenerationBoxSettings: async () => runtimeDisabled(),
  getStatus: async () => runtimeDisabled(),
  setTtl: async () => runtimeDisabled(),
  stopExistingBox: async () => runtimeDisabled(),
  resumeExistingBox: async () => runtimeDisabled(),
  requestPermanentDeletion: async () => runtimeDisabled(),
  pollPermanentDeletion: async () => runtimeDisabled(),
};

const disabledPiControl: RuntimePiControl = {
  stopPiDaemon: async () => runtimeDisabled(),
  startPiDaemon: async () => runtimeDisabled(),
  restartPiDaemon: async () => runtimeDisabled(),
  piDaemonStatus: async () => runtimeDisabled(),
  brokerState: async () => runtimeDisabled(),
  prompt: async () => runtimeDisabled(),
  readBrokerEvents: async () => runtimeDisabled(),
  ackBrokerEvents: async () => runtimeDisabled(),
  respondExtensionUi: async () => runtimeDisabled(),
};

const disabledResourceStager: RuntimeResourceStager = {
  stageExistingBox: async () => runtimeDisabled(),
};
