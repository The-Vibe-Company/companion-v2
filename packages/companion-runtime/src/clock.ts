import type { RetryClock } from "./retry";

export interface RuntimeClock extends RetryClock {
  setTimeout(callback: () => void, milliseconds: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const systemRuntimeClock: RuntimeClock = {
  now: () => new Date(),
  sleep: async (milliseconds, signal) => {
    await new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason ?? new Error("Runtime sleep aborted"));
        return;
      }
      const timer = setTimeout(finish, milliseconds);
      const abort = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        reject(signal?.reason ?? new Error("Runtime sleep aborted"));
      };
      function finish(): void {
        signal?.removeEventListener("abort", abort);
        resolve();
      }
      signal?.addEventListener("abort", abort, { once: true });
    });
  },
  setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};
