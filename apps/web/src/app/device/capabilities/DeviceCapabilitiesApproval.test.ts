// @vitest-environment happy-dom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiFetchError } from "@/lib/apiClient";
import { DeviceCapabilitiesApproval } from "./DeviceCapabilitiesApproval";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/apiClient", () => ({
  apiFetch,
  ApiFetchError: class ApiFetchError extends Error {
    readonly status: number;

    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  },
}));

const request = {
  request: {
    agent_id: "11111111-1111-4111-8111-111111111111",
    agent_name: "Codex on Mac",
    host: { id: "host-1", name: "stan-mac" },
    capabilities: [
      { name: "skills:read", constraints: { workspaceId: { eq: "org-1" } }, reason: "Read workspace skills" },
      { name: "public-skills:install", constraints: null, reason: "Install public skills" },
    ],
    workspace_id: "org-1",
    workspace_name: "Georgetown",
    expires_at: "2026-07-21T10:05:00.000Z",
  },
};

describe("DeviceCapabilitiesApproval", () => {
  let root: Root;
  let host: HTMLDivElement;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    apiFetch.mockResolvedValueOnce(request);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.clearAllMocks();
  });

  it("shows agent, host, workspace, and requested constraints before approval", async () => {
    await act(async () => {
      root.render(React.createElement(DeviceCapabilitiesApproval, {
        agentId: "11111111-1111-4111-8111-111111111111",
        code: "ABCD-1234",
      }));
    });
    expect(host.textContent).toContain("Codex on Mac");
    expect(host.textContent).toContain("stan-mac");
    expect(host.textContent).toContain("Georgetown");
    expect(host.textContent).toContain("org-1");
    expect(host.textContent).toContain("skills:read");
    expect(host.textContent).toContain("workspaceId=org-1");
    expect(host.textContent).not.toContain("[object Object]");
    expect(host.textContent).toContain("public-skills:install");
  });

  it("approves only the capabilities left selected", async () => {
    apiFetch.mockResolvedValueOnce({ ok: true, status: "approved" });
    await act(async () => {
      root.render(React.createElement(DeviceCapabilitiesApproval, {
        agentId: "11111111-1111-4111-8111-111111111111",
        code: "ABCD-1234",
      }));
    });
    const checks = host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    await act(async () => checks[1]?.click());
    const approve = [...host.querySelectorAll("button")].find((button) => button.textContent?.includes("Approve selected"));
    await act(async () => approve?.click());
    expect(apiFetch).toHaveBeenLastCalledWith(
      "/v1/agent-auth/device-approval/approve",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          agent_id: "11111111-1111-4111-8111-111111111111",
          code: "ABCD-1234",
          capabilities: ["skills:read"],
        }),
      }),
    );
    expect(host.textContent).toContain("Agent approved");
  });

  it("offers a return-preserving reauthentication action for a stale session", async () => {
    apiFetch.mockReset().mockRejectedValueOnce(new ApiFetchError("fresh_session_required", 403));

    await act(async () => {
      root.render(React.createElement(DeviceCapabilitiesApproval, {
        agentId: "11111111-1111-4111-8111-111111111111",
        code: "ABCD-1234",
      }));
    });

    expect(host.textContent).toContain("Sign in again to continue");
    const form = host.querySelector<HTMLFormElement>('form[action="/v1/auth/logout"]');
    expect(form).not.toBeNull();
    expect(form?.querySelector<HTMLInputElement>('input[name="next"]')?.value).toBe(
      "/device/capabilities?agent_id=11111111-1111-4111-8111-111111111111&code=ABCD-1234",
    );
    expect(form?.querySelector("button")?.textContent).toContain("Sign in again");
    expect(host.textContent).not.toContain("Try again");
  });
});
