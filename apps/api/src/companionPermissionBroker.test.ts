import { describe, expect, it } from "vitest";
import {
  COMPANION_IMAGE_READ_REFUSAL,
  COMPANION_PERMISSION_BROKER_EXTENSION_FILE,
  COMPANION_PERMISSION_BROKER_EXTENSION_SOURCE,
  companionImageReadRefusal,
} from "./companionPermissionBroker";

describe("Companion Pi interaction extension", () => {
  it("overwrites the legacy broker without gating shell or file tools", () => {
    expect(COMPANION_PERMISSION_BROKER_EXTENSION_FILE).toBe("companion-permission-broker.ts");
    expect(COMPANION_PERMISSION_BROKER_EXTENSION_SOURCE).not.toContain("GATED_TOOLS");
    expect(COMPANION_PERMISSION_BROKER_EXTENSION_SOURCE).not.toContain("ctx.ui.confirm");
  });

  it("keeps ask_user as an explicit blocking question", () => {
    expect(COMPANION_PERMISSION_BROKER_EXTENSION_SOURCE).toContain('name: "ask_user"');
    expect(COMPANION_PERMISSION_BROKER_EXTENSION_SOURCE).toContain("ctx.ui.input(");
    expect(COMPANION_PERMISSION_BROKER_EXTENSION_SOURCE).toContain("companion:question:");
  });

  it.each([
    "/tmp/conductor-cli.png",
    "screen.JPEG",
    "capture.webp?download=1",
  ])("refuses image read before Pi vision can block: %s", (path) => {
    expect(companionImageReadRefusal("read", { path })).toBe(COMPANION_IMAGE_READ_REFUSAL);
  });

  it("leaves text reads and other tools available", () => {
    expect(companionImageReadRefusal("read", { path: "docs/vision.md" })).toBeNull();
    expect(companionImageReadRefusal("bash", { path: "/tmp/conductor-cli.png" })).toBeNull();
  });

  it("stages the refusal and a 90-second abort timer for every execution tool", () => {
    expect(COMPANION_PERMISSION_BROKER_EXTENSION_SOURCE).toContain(COMPANION_IMAGE_READ_REFUSAL);
    expect(COMPANION_PERMISSION_BROKER_EXTENSION_SOURCE).toContain("const TOOL_TIMEOUT_MS = 90000");
    expect(COMPANION_PERMISSION_BROKER_EXTENSION_SOURCE).toContain("ctx.abort()");
    expect(COMPANION_PERMISSION_BROKER_EXTENSION_SOURCE).toContain('pi.on("tool_result"');
    expect(COMPANION_PERMISSION_BROKER_EXTENSION_SOURCE).toContain('pi.on("turn_end"');
    expect(COMPANION_PERMISSION_BROKER_EXTENSION_SOURCE).toContain("startToolTimeout(event.toolCallId, ctx)");
    expect(COMPANION_PERMISSION_BROKER_EXTENSION_SOURCE).toContain("clearToolTimeouts()");
    expect(COMPANION_PERMISSION_BROKER_EXTENSION_SOURCE).toContain(
      'if (event.toolName === "ask_user") return undefined',
    );
    expect(COMPANION_PERMISSION_BROKER_EXTENSION_SOURCE).not.toContain("runtime.abortTurn");
  });
});
