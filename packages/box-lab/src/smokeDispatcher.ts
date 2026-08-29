import { Agent, getGlobalDispatcher, setGlobalDispatcher } from "undici";

const BOX_LAB_SMOKE_HTTP_TIMEOUT_MS = 20 * 60_000;
let smokeDispatcherQueue: Promise<void> = Promise.resolve();

/**
 * Let the contained Lab's explicit command deadlines govern long QEMU operations. Node's bundled
 * Undici otherwise drops a request after five minutes without response headers, before the Lab can
 * return a valid result for its bounded 900-second command API.
 */
async function runWithBoxLabSmokeDispatcher<Result>(
  action: () => Promise<Result>,
): Promise<Result> {
  const previous = getGlobalDispatcher();
  const dispatcher = new Agent({
    headersTimeout: BOX_LAB_SMOKE_HTTP_TIMEOUT_MS,
    bodyTimeout: BOX_LAB_SMOKE_HTTP_TIMEOUT_MS,
  });
  let installed = false;
  try {
    setGlobalDispatcher(dispatcher);
    installed = true;
    return await action();
  } finally {
    try {
      if (installed) setGlobalDispatcher(previous);
    } finally {
      await dispatcher.close();
    }
  }
}

/** Serialize process-global dispatcher replacement in call order without letting one failure poison later runs. */
export function withBoxLabSmokeDispatcher<Result>(
  action: () => Promise<Result>,
): Promise<Result> {
  const run = smokeDispatcherQueue.then(async () => await runWithBoxLabSmokeDispatcher(action));
  smokeDispatcherQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}
