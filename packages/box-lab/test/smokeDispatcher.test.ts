import { createServer, type Server } from "node:http";

import { getGlobalDispatcher } from "undici";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { withBoxLabSmokeDispatcher } from "../src/smokeDispatcher";

function gate() {
  let resolveWait: (() => void) | undefined;
  const wait = new Promise<void>((resolvePromise) => {
    resolveWait = resolvePromise;
  });
  return {
    wait,
    open: () => {
      const resolvePromise = resolveWait;
      if (!resolvePromise) throw new Error("Test gate did not initialize");
      resolvePromise();
    },
  };
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectPromise);
      resolvePromise();
    });
  });
  const address = z.object({ port: z.number().int().positive() }).safeParse(server.address());
  if (!address.success) throw new Error("Test HTTP server did not bind TCP");
  return address.data.port;
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.close((error) => error ? rejectPromise(error) : resolvePromise());
  });
}

describe.sequential("Box Lab smoke HTTP dispatcher", () => {
  it("restores the previous global dispatcher after success and failure", async () => {
    const previous = getGlobalDispatcher();
    const result = await withBoxLabSmokeDispatcher(async () => {
      expect(getGlobalDispatcher()).not.toBe(previous);
      return "complete";
    });

    expect(result).toBe("complete");
    expect(getGlobalDispatcher()).toBe(previous);

    const failure = new Error("smoke failed");
    await expect(withBoxLabSmokeDispatcher(async () => {
      expect(getGlobalDispatcher()).not.toBe(previous);
      throw failure;
    })).rejects.toBe(failure);
    expect(getGlobalDispatcher()).toBe(previous);

    await expect(withBoxLabSmokeDispatcher(async () => "after-failure"))
      .resolves.toBe("after-failure");
    expect(getGlobalDispatcher()).toBe(previous);
  });

  it("serializes concurrent replacements in FIFO order", async () => {
    const previous = getGlobalDispatcher();
    const firstEntered = gate();
    const releaseFirst = gate();
    let firstDispatcher: ReturnType<typeof getGlobalDispatcher> | undefined;
    let secondDispatcher: ReturnType<typeof getGlobalDispatcher> | undefined;

    const first = withBoxLabSmokeDispatcher(async () => {
      firstDispatcher = getGlobalDispatcher();
      expect(firstDispatcher).not.toBe(previous);
      firstEntered.open();
      await releaseFirst.wait;
      expect(getGlobalDispatcher()).toBe(firstDispatcher);
      return "first";
    });
    await firstEntered.wait;

    const secondAction = vi.fn(async () => {
      secondDispatcher = getGlobalDispatcher();
      expect(secondDispatcher).not.toBe(previous);
      expect(secondDispatcher).not.toBe(firstDispatcher);
      return "second";
    });
    const second = withBoxLabSmokeDispatcher(secondAction);
    await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));

    expect(secondAction).not.toHaveBeenCalled();
    expect(getGlobalDispatcher()).toBe(firstDispatcher);
    releaseFirst.open();

    await expect(first).resolves.toBe("first");
    await expect(second).resolves.toBe("second");
    expect(secondAction).toHaveBeenCalledOnce();
    expect(secondDispatcher).toBeDefined();
    expect(getGlobalDispatcher()).toBe(previous);
  });

  it("keeps caller AbortSignals authoritative", async () => {
    const server = createServer(() => undefined);
    const port = await listen(server);
    const startedAt = Date.now();
    try {
      await withBoxLabSmokeDispatcher(async () => {
        await expect(fetch(`http://127.0.0.1:${port}/never-responds`, {
          signal: AbortSignal.timeout(25),
        })).rejects.toMatchObject({ name: "TimeoutError" });
      });
      expect(Date.now() - startedAt).toBeLessThan(1_000);
    } finally {
      await close(server);
    }
  });
});
