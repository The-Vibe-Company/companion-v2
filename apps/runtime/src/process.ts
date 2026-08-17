import type { RuntimeService } from "./composition";

export interface RuntimeSignalPort {
  once(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  off(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
}

/** Start once, then turn the first process signal into the bounded application shutdown. */
export async function runRuntimeUntilSignal(input: {
  build(): Promise<RuntimeService>;
  signals?: RuntimeSignalPort;
}): Promise<void> {
  const signals = input.signals ?? process;
  const service = await input.build();
  await service.application.start();
  await new Promise<void>((resolve, reject) => {
    let stopping = false;
    const stop = (): void => {
      if (stopping) return;
      stopping = true;
      signals.off("SIGINT", stop);
      signals.off("SIGTERM", stop);
      void service.application.stop().then(resolve, reject);
    };
    signals.once("SIGINT", stop);
    signals.once("SIGTERM", stop);
  });
}
