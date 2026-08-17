import {
  createRuntimeApplication,
  type RuntimeApplication,
  type RuntimeApplicationScheduler,
  type RuntimeApplicationStore,
} from "./application";
import type { RuntimeServiceConfig } from "./config";
import {
  createRuntimeHttpServer,
  type RuntimeDesktopPort,
  type RuntimeDesktopReplayPort,
  type RuntimeHttpServer,
} from "./server";

export interface RuntimeService {
  application: RuntimeApplication;
  server: RuntimeHttpServer;
}

export interface RuntimeServiceDependencies {
  config: RuntimeServiceConfig;
  store: RuntimeApplicationStore;
  scheduler: RuntimeApplicationScheduler;
  /** Required only for an enabled product; disabled configuration never invokes it. */
  desktop?: RuntimeDesktopPort;
  /** Required with desktop ingress; production supplies the PostgreSQL-backed implementation. */
  desktopReplay?: RuntimeDesktopReplayPort;
  closeResources(): Promise<void>;
}

/** Small, dependency-injected composition seam; production construction stays in `index.ts`. */
export function composeRuntimeService(input: RuntimeServiceDependencies): RuntimeService {
  if (input.config.companionsEnabled && (!input.desktop || !input.desktopReplay)) {
    throw new Error("enabled runtime requires desktop authorization and replay adapters");
  }
  let resourcesClose: Promise<void> | null = null;
  const closeResources = (): Promise<void> => {
    resourcesClose ??= input.closeResources();
    return resourcesClose;
  };
  const server = createRuntimeHttpServer({
    host: input.config.listenHost,
    port: input.config.listenPort,
    sweepIntervalMs: input.config.sweepIntervalMs,
    desktopHmacSecret: input.config.desktopHmacSecret,
    desktopMaxSkewSeconds: input.config.desktopMaxSkewSeconds,
    health: {
      ping: () => input.store.ping(),
      snapshot: () => input.scheduler.snapshot(),
    },
    desktop: input.desktop ?? disabledDesktop,
    desktopReplay: input.desktopReplay ?? disabledDesktopReplay,
  });
  return {
    server,
    application: createRuntimeApplication({
      config: input.config,
      store: input.store,
      scheduler: input.scheduler,
      server,
      closeResources,
    }),
  };
}

const disabledDesktop: RuntimeDesktopPort = {
  authorizeAndMint: async () => null,
};

const disabledDesktopReplay: RuntimeDesktopReplayPort = {
  consume: async () => false,
};
