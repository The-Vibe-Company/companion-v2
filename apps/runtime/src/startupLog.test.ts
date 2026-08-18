import { describe, expect, it } from "vitest";

import { logRuntimeStartupFailure } from "./startupLog";

describe("runtime startup failure logs", () => {
  it("prints the thrown cause instead of a generic startup line", () => {
    const lines: string[] = [];
    logRuntimeStartupFailure(
      new Error("Box runtime is not configured; set COMPANION_BOX_API_KEY"),
      (line) => lines.push(line),
    );
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0] ?? "{}") as {
      event?: string;
      thrown?: { message?: string };
    };
    expect(parsed.event).toBe("runtime.startup.failed");
    expect(parsed.thrown?.message).toContain("COMPANION_BOX_API_KEY");
    expect(lines[0]).not.toBe("runtime failed to start");
  });
});
