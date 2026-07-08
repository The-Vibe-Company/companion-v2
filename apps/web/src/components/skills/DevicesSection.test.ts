// @vitest-environment happy-dom

import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeviceRow } from "@companion/contracts";
import { DevicesSection } from "./DevicesSection";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const queryMocks = vi.hoisted(() => ({
  fetchDevices: vi.fn(),
  revokeDevice: vi.fn(),
}));

vi.mock("@/lib/queries", () => ({
  fetchDevices: queryMocks.fetchDevices,
  revokeDevice: queryMocks.revokeDevice,
}));

const mountedRoots: Root[] = [];

const device: DeviceRow = {
  id: "device-1",
  org_id: "org-1",
  user_id: "user-1",
  name: "stan-mac",
  platform: "darwin",
  agent_version: "0.0.0",
  companion_skill_version: "1.18.0",
  inventory: { skills: [], tools: [] },
  inventory_skills: [
    {
      name: "archived-skill",
      slug: "archived-skill",
      skillId: null,
      companionSkillId: null,
      version: "1.0.0",
      checksum: null,
      path: null,
      targets: [],
      resolved_skill_id: "skill-1",
      resolved_slug: "archived-skill",
      current_version: "1.0.0",
      archived: true,
      outdated: false,
      managed: true,
    },
  ],
  inventory_reported_at: "2026-07-06T10:00:00.000Z",
  last_seen_at: "2026-07-06T10:00:00.000Z",
  created_at: "2026-07-06T09:00:00.000Z",
  revoked_at: null,
  online: true,
  agent_update_available: false,
};

async function mount(props: React.ComponentProps<typeof DevicesSection>) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mountedRoots.push(root);
  await act(async () => {
    root.render(React.createElement(DevicesSection, props));
  });
  return container;
}

describe("DevicesSection", () => {
  beforeEach(() => {
    queryMocks.fetchDevices.mockResolvedValue([]);
    queryMocks.revokeDevice.mockResolvedValue(undefined);
  });

  afterEach(() => {
    act(() => {
      for (const root of mountedRoots.splice(0)) root.unmount();
    });
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("does not show the no-device empty state when the initial load failed", async () => {
    const container = await mount({ initialDevices: [], initialError: "Could not load devices." });

    expect(container.textContent).toContain("Could not load devices.");
    expect(container.textContent).not.toContain("No local agent yet");
  });

  it("styles archived inventory as attention rather than success", async () => {
    const container = await mount({ initialDevices: [device] });
    const badge = Array.from(container.querySelectorAll(".devbadge")).find((node) => node.textContent === "Archived");

    expect(badge?.classList.contains("devbadge--warn")).toBe(true);
    expect(badge?.classList.contains("devbadge--ok")).toBe(false);
    expect(badge?.getAttribute("aria-label")).toBe("Status: Archived");
  });
});
