// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { copyRunText } from "./clipboard";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("copyRunText", () => {
  it("reports success without exposing clipboard failures", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    await expect(copyRunText("answer")).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith("answer");

    writeText.mockRejectedValueOnce(new Error("permission denied"));
    await expect(copyRunText("private")).resolves.toBe(false);
  });
});
