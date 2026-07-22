// @vitest-environment happy-dom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectedAgentsPane } from "./ConnectedAgentsPane";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  fetchConnectedAgents: vi.fn(),
  revokeAgentGrant: vi.fn(),
  revokeConnectedAgent: vi.fn(),
  revokeAgentHost: vi.fn(),
}));

vi.mock("@/lib/agentAuth", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/agentAuth")>(),
  ...mocks,
}));

const agent = {
  id: "agent-1",
  name: "Codex on Mac",
  status: "active",
  host: { id: "host-1", name: "stan-mac", status: "active" },
  last_used_at: "2026-07-21T10:30:00.000Z",
  created_at: "2026-07-21T10:00:00.000Z",
  grants: [{
    id: "grant-1",
    capability: "skills:read",
    constraints: { workspaceId: { eq: "org-1" } },
    status: "active",
    created_at: "2026-07-21T10:00:00.000Z",
    last_used_at: null,
  }],
};

describe("ConnectedAgentsPane", () => {
  let root: Root;
  let host: HTMLDivElement;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    mocks.fetchConnectedAgents.mockResolvedValue([agent]);
    mocks.revokeAgentGrant.mockResolvedValue(undefined);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.clearAllMocks();
  });

  it("shows constrained grants and confirms capability revocation", async () => {
    mocks.fetchConnectedAgents
      .mockResolvedValueOnce([agent])
      .mockResolvedValueOnce([{ ...agent, grants: [{ ...agent.grants[0]!, status: "revoked" }] }]);
    await act(async () => {
      root.render(React.createElement(ConnectedAgentsPane));
    });
    expect(host.textContent).toContain("Codex on Mac");
    expect(host.textContent).toContain("skills:read");
    expect(host.textContent).toContain("workspace org-1");

    const revoke = [...host.querySelectorAll("button")].find((button) => button.textContent?.includes("Revoke capability"));
    await act(async () => revoke?.click());
    expect(host.textContent).toContain("Revoke grant access?");

    const confirm = [...host.querySelectorAll("button")].find((button) => button.textContent?.includes("Confirm revoke"));
    await act(async () => confirm?.click());
    expect(mocks.revokeAgentGrant).toHaveBeenCalledWith("grant-1");
    expect(host.textContent).toContain("revoked");
    expect([...host.querySelectorAll("button")].some((button) => button.textContent?.includes("Revoke capability"))).toBe(false);
  });

  it("does not present agent activity as usage of each capability grant", async () => {
    await act(async () => {
      root.render(React.createElement(ConnectedAgentsPane));
    });

    expect(host.textContent).toContain("Last used");
    expect(host.querySelector(".connected-grant__used")?.textContent).toBe("Usage unavailable");
    expect(host.querySelector(".connected-grant__used")?.textContent).not.toContain("Used");
  });

  it("allows a second revocation after the first one succeeds", async () => {
    const secondGrant = {
      ...agent.grants[0]!,
      id: "grant-2",
      capability: "skills:write",
    };
    const twoGrantAgent = { ...agent, grants: [agent.grants[0]!, secondGrant] };
    mocks.fetchConnectedAgents
      .mockReset()
      .mockResolvedValueOnce([twoGrantAgent])
      .mockResolvedValueOnce([{
        ...twoGrantAgent,
        grants: [{ ...agent.grants[0]!, status: "revoked" }, secondGrant],
      }])
      .mockResolvedValue([{
        ...twoGrantAgent,
        grants: [
          { ...agent.grants[0]!, status: "revoked" },
          { ...secondGrant, status: "revoked" },
        ],
      }]);

    await act(async () => {
      root.render(React.createElement(ConnectedAgentsPane));
    });
    const firstRevoke = [...host.querySelectorAll("button")].find((button) => button.textContent?.includes("Revoke capability"));
    await act(async () => firstRevoke?.click());
    const firstConfirm = [...host.querySelectorAll("button")].find((button) => button.textContent?.includes("Confirm revoke"));
    await act(async () => firstConfirm?.click());

    const secondRevoke = [...host.querySelectorAll("button")].find((button) => button.textContent?.includes("Revoke capability"));
    await act(async () => secondRevoke?.click());
    const secondConfirm = [...host.querySelectorAll("button")].find((button) => button.textContent?.includes("Confirm revoke"));
    expect(secondConfirm?.disabled).toBe(false);
    await act(async () => secondConfirm?.click());

    expect(mocks.revokeAgentGrant).toHaveBeenNthCalledWith(1, "grant-1");
    expect(mocks.revokeAgentGrant).toHaveBeenNthCalledWith(2, "grant-2");
  });
});
