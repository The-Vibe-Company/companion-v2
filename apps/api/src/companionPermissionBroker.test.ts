import { describe, expect, it } from "vitest";
import {
  COMPANION_PERMISSION_BROKER_EXTENSION_FILE,
  COMPANION_PERMISSION_BROKER_EXTENSION_SOURCE,
} from "./companionPermissionBroker";

describe("Companion Pi interaction extension", () => {
  it("overwrites the legacy broker without gating shell or file tools", () => {
    expect(COMPANION_PERMISSION_BROKER_EXTENSION_FILE).toBe("companion-permission-broker.ts");
    expect(COMPANION_PERMISSION_BROKER_EXTENSION_SOURCE).not.toContain('pi.on("tool_call"');
    expect(COMPANION_PERMISSION_BROKER_EXTENSION_SOURCE).not.toContain("GATED_TOOLS");
    expect(COMPANION_PERMISSION_BROKER_EXTENSION_SOURCE).not.toContain("ctx.ui.confirm");
  });

  it("keeps ask_user as an explicit blocking question", () => {
    expect(COMPANION_PERMISSION_BROKER_EXTENSION_SOURCE).toContain('name: "ask_user"');
    expect(COMPANION_PERMISSION_BROKER_EXTENSION_SOURCE).toContain("ctx.ui.input(");
    expect(COMPANION_PERMISSION_BROKER_EXTENSION_SOURCE).toContain("companion:question:");
  });
});
