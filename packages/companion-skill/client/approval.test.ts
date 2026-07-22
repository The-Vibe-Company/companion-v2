import type { ApprovalInfo } from "@auth/agent";
import { describe, expect, it } from "vitest";

import { approvalBrowserCommand } from "./approval.js";

function approval(url?: string): ApprovalInfo {
  return {
    method: "device_authorization",
    verification_uri_complete: url,
    expires_in: 300,
    interval: 5,
  };
}

describe("approvalBrowserCommand", () => {
  it("launches Windows approval URLs without passing through cmd.exe", () => {
    expect(approvalBrowserCommand(
      approval("https://companion.example/device/capabilities?code=A&calc.exe"),
      "win32",
    )).toEqual({
      command: "explorer.exe",
      args: ["https://companion.example/device/capabilities?code=A&calc.exe"],
    });
  });

  it.each([
    "javascript:alert(1)",
    "file:///etc/passwd",
    "https://user:password@companion.example/device/capabilities",
  ])("rejects an unsafe approval URL: %s", (url) => {
    expect(() => approvalBrowserCommand(approval(url), "win32")).toThrow(/approval URL/);
  });

  it("returns null when the server did not provide a browser URL", () => {
    expect(approvalBrowserCommand(approval(), "linux")).toBeNull();
  });
});
