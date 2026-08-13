/**
 * Serializes the thread requests that can reach Pi. Sending and syncing both hand the pending
 * messages to the daemon, so two overlapping requests can read the same pending message and give Pi
 * the same prompt twice. A poll skips a tick that an in-flight request already covers
 * (`skipWhenBusy`), while a person's send waits for that request instead of racing it.
 */
export interface ThreadQueue {
  run<T>(task: () => Promise<T>, options: { skipWhenBusy: boolean }): Promise<T | undefined>;
}

export function createThreadQueue(): ThreadQueue {
  let tail: Promise<unknown> = Promise.resolve();
  let busy = false;

  return {
    run(task, options) {
      if (options.skipWhenBusy && busy) return Promise.resolve(undefined);
      busy = true;
      // `then(task, task)` keeps the queue running after a failed request instead of wedging it.
      const queued = tail.then(task, task);
      const settled = queued.then(() => undefined, () => undefined);
      tail = settled;
      // Only the current tail clears the flag, so work queued behind this task keeps it raised.
      void settled.then(() => {
        if (tail === settled) busy = false;
      });
      return queued;
    },
  };
}
