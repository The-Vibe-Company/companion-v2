import { describe, expect, it } from "vitest";
import {
  COMPANION_PERMISSION_BROKER_EXTENSION_FILE,
  COMPANION_PERMISSION_BROKER_EXTENSION_SOURCE,
  parseCompanionDecisionTitle,
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

  it("allows image reads and keeps a kind-aware abort timer around every execution tool", () => {
    expect(COMPANION_PERMISSION_BROKER_EXTENSION_SOURCE).toContain("const TOOL_TIMEOUT_MS = 90000");
    expect(COMPANION_PERMISSION_BROKER_EXTENSION_SOURCE)
      .toContain("const EXEC_TOOL_TIMEOUT_MS = 600000");
    expect(COMPANION_PERMISSION_BROKER_EXTENSION_SOURCE).toContain("ctx.abort()");
    expect(COMPANION_PERMISSION_BROKER_EXTENSION_SOURCE).toContain('pi.on("tool_result"');
    expect(COMPANION_PERMISSION_BROKER_EXTENSION_SOURCE).toContain('pi.on("turn_end"');
    expect(COMPANION_PERMISSION_BROKER_EXTENSION_SOURCE)
      .toContain("startToolTimeout(event.toolCallId, event.toolName, ctx)");
    expect(COMPANION_PERMISSION_BROKER_EXTENSION_SOURCE).not.toContain("block: true");
    expect(COMPANION_PERMISSION_BROKER_EXTENSION_SOURCE).not.toContain("Image reads are disabled");
    expect(COMPANION_PERMISSION_BROKER_EXTENSION_SOURCE).toContain("clearToolTimeouts()");
    expect(COMPANION_PERMISSION_BROKER_EXTENSION_SOURCE).toContain(
      'if (event.toolName === "ask_user") return undefined',
    );
    expect(COMPANION_PERMISSION_BROKER_EXTENSION_SOURCE).not.toContain("runtime.abortTurn");
  });

  it("accepts config proposal titles without treating them as questions", () => {
    expect(parseCompanionDecisionTitle("companion:config:propose_config")).toEqual({
      kind: "config",
      name: "propose_config",
    });
    expect(parseCompanionDecisionTitle("companion:question:ask_user")?.kind).toBe("question");
    expect(parseCompanionDecisionTitle("companion:hub:write")).toBeNull();
  });

  it("classifies shell runs with the control plane's own catalog, priority order included", () => {
    // The embedded table must match core's classifier verbatim so the Box-side deadline and the
    // control-plane settlement can never disagree on which runs are shell runs.
    expect(COMPANION_PERMISSION_BROKER_EXTENSION_SOURCE).toContain('["shell",');
    expect(COMPANION_PERMISSION_BROKER_EXTENSION_SOURCE).toContain('"bash"');
    expect(COMPANION_PERMISSION_BROKER_EXTENSION_SOURCE)
      .toContain('toolRunKind(toolName) === "shell" ? EXEC_TOOL_TIMEOUT_MS : TOOL_TIMEOUT_MS');
    const shellIndex = COMPANION_PERMISSION_BROKER_EXTENSION_SOURCE.indexOf('["shell",');
    const browseIndex = COMPANION_PERMISSION_BROKER_EXTENSION_SOURCE.indexOf('["browse",');
    expect(browseIndex).toBeGreaterThan(-1);
    expect(browseIndex).toBeLessThan(shellIndex);
  });
});
