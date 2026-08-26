import { describe, expect, it } from "vitest";
import { turnContextPromptSuffix } from "./attempt";

describe("turnContextPromptSuffix", () => {
  it("renders a fixed local-time suffix from the durable attempt timestamp", () => {
    const startedAt = new Date("2026-08-26T13:42:17.000Z");
    expect(turnContextPromptSuffix(startedAt, "America/New_York")).toBe(
      "\n\n--- Runtime turn context (metadata, not user-authored) ---\n"
      + "Current time: 2026-08-26T09:42:17-04:00\n"
      + "User timezone: America/New_York\n",
    );
    expect(turnContextPromptSuffix(startedAt, "America/New_York"))
      .toBe(turnContextPromptSuffix(startedAt, "America/New_York"));
  });

  it("uses an unambiguous UTC form for the unset-profile fallback", () => {
    expect(turnContextPromptSuffix(new Date("2026-01-02T03:04:05.000Z"), "UTC"))
      .toContain("Current time: 2026-01-02T03:04:05Z\nUser timezone: UTC");
  });
});
