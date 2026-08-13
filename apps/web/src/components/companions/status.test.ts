import { describe, expect, it } from "vitest";
import { companionBoxStatusLabel, companionStatus, relativeTime } from "./status";

describe("companionStatus", () => {
  it("pairs every runtime state with one operator word", () => {
    expect(companionStatus("running")).toEqual({ label: "Online", tone: "ok" });
    expect(companionStatus("provisioning")).toEqual({ label: "Starting", tone: "warn" });
    expect(companionStatus("stopping")).toEqual({ label: "Stopping", tone: "warn" });
    expect(companionStatus("error")).toEqual({ label: "Error", tone: "danger" });
    expect(companionStatus("stopped")).toEqual({ label: "Asleep", tone: "unknown" });
    expect(companionStatus("not_created")).toEqual({ label: "Asleep", tone: "unknown" });
  });

  it("names the compute in the chat chip without inventing a second vocabulary", () => {
    expect(companionBoxStatusLabel("running")).toBe("Box · online");
    expect(companionBoxStatusLabel("provisioning")).toBe("Box · starting");
    expect(companionBoxStatusLabel("stopped")).toBe("Box · asleep");
    expect(companionBoxStatusLabel("error")).toBe("Box · error");
  });
});

describe("relativeTime", () => {
  const now = Date.parse("2026-08-12T12:00:00.000Z");

  it("reads as elapsed time from the reference instant", () => {
    expect(relativeTime("2026-08-12T11:58:00.000Z", now)).toBe("2m ago");
    expect(relativeTime("2026-08-12T11:00:00.000Z", now)).toBe("1h ago");
    expect(relativeTime("2026-08-10T12:00:00.000Z", now)).toBe("2d ago");
  });

  it("keeps very recent activity readable instead of showing seconds", () => {
    expect(relativeTime("2026-08-12T11:59:50.000Z", now)).toBe("this minute");
  });
});
