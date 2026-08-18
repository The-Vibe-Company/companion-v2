import type { RuntimeService } from "./composition";

export interface RuntimeSignalPort {
  once(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  off(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
}

/** Latch the first process signal, including signals received while composition or startup runs. */
export async function runRuntimeUntilSignal(input: {
  build(): Promise<RuntimeService>;
  signals?: RuntimeSignalPort;
}): Promise<void> {
  const signals = input.signals ?? process;
  let signalled = false;
  let resolveSignal!: () => void;
  const signalReceived = new Promise<void>((resolve) => { resolveSignal = resolve; });
  const stop = (): void => {
    if (signalled) return;
    signalled = true;
    resolveSignal();
  };
  const removeListeners = (): void => {
    signals.off("SIGINT", stop);
    signals.off("SIGTERM", stop);
  };
  signals.once("SIGINT", stop);
  signals.once("SIGTERM", stop);

  try {
    const service = await input.build();
    if (signalled) {
      await service.application.stop();
      return;
    }
    const startup = service.application.start();
    const first = await Promise.race([
      startup.then(() => "started" as const),
      signalReceived.then(() => "signal" as const),
    ]);
    if (first === "signal") {
      // RuntimeApplication.stop waits for any in-flight startup and performs partial cleanup.
      await service.application.stop();
      return;
    }
    await signalReceived;
    await service.application.stop();
  } finally {
    removeListeners();
  }
}
