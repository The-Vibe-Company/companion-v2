import { describe, expect, it } from "vitest";
import { sleepUntilNextBeat } from "./daemon";

describe("agent daemon", () => {
  it("aborts the heartbeat sleep on stop signals", async () => {
    const controller = new AbortController();
    const wait = sleepUntilNextBeat(900_000, controller.signal);
    controller.abort();
    await expect(wait).resolves.toBeUndefined();
  });
});
