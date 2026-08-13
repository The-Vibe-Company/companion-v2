// @vitest-environment happy-dom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type {
  Companion,
  CompanionProvidersResponse,
  CompanionThread as Thread,
} from "@companion/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanionsApp, type CompanionNavigation } from "./CompanionsApp";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {}, refresh: () => {} }) }));

const companionsApi = vi.hoisted(() => ({
  getCompanionRuntime: vi.fn(),
  getCompanionThread: vi.fn(),
  openCompanionDesktop: vi.fn(),
  sendCompanionMessage: vi.fn(),
  setCompanionProvider: vi.fn(),
  startCompanionRuntime: vi.fn(),
  syncCompanionThread: vi.fn(),
}));

vi.mock("@/lib/companions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/companions")>()),
  ...companionsApi,
}));

const companionId = "11111111-1111-4111-8111-111111111111";

const org = {
  id: "org-1",
  name: "The Vibe Company",
  slug: "vibe",
  kind: "team" as const,
  myRole: "owner" as const,
  color: null,
  logoUrl: null,
};

const navigation: CompanionNavigation = {
  mineTreeRows: [],
  orgTreeRows: [],
  mineCount: 0,
  orgCount: 0,
  installedCount: 0,
  installedUpdateCount: 0,
  localUpdateCount: 0,
  archivedCount: 0,
};

const providers: CompanionProvidersResponse = {
  catalog: [
    { id: "anthropic", name: "Claude", auth_methods: ["api_key"], description: "" },
  ],
  connections: [{
    provider_id: "anthropic",
    auth_method: "api_key",
    connected_by: "user-1",
    created_at: "2026-08-12T12:00:00.000Z",
    updated_at: "2026-08-12T12:00:00.000Z",
  }],
  default_provider_id: "anthropic",
  can_manage: true,
};

function companion(overrides: Partial<Companion> = {}): Companion {
  return {
    id: companionId,
    name: "Luna",
    persona: "Content marketing assistant",
    owner_id: "user-1",
    access: "owner",
    runtime: {
      state: "running",
      daemon_state: "running",
      box_id: "bx_23456789",
      provider_ids: ["anthropic"],
      provider_credential_generation: null,
      disk_layout_version: 2,
      desktop_available: true,
      last_error: null,
      last_observed_at: null,
      last_started_at: null,
      last_stopped_at: null,
    },
    created_at: "2026-08-12T12:00:00.000Z",
    updated_at: "2026-08-12T12:00:00.000Z",
    ...overrides,
  };
}

function thread(overrides: Partial<Thread> = {}): Thread {
  return {
    companion_id: companionId,
    viewer_id: "user-1",
    access: "owner",
    read_only: false,
    can_send: true,
    entries: [],
    pending_count: 0,
    last_message_at: null,
    ...overrides,
  };
}

const roots: Root[] = [];

async function open(initial: Companion) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(React.createElement(CompanionsApp, {
      orgs: [org],
      currentOrg: org,
      navigation,
      initialCompanions: [initial],
      initialProviders: providers,
      initialPlugins: [],
      initialCompanionId: companionId,
    }));
  });
  return container;
}

async function clickBoxChip(container: HTMLElement) {
  const chip = container.querySelector(".chat-box") as HTMLElement;
  await act(async () => {
    chip.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  return chip;
}

/** Stands in for the tab a click claims: it records where it was sent and whether it was closed. */
function tabStub() {
  return {
    opener: {} as unknown,
    location: { replace: vi.fn() },
    close: vi.fn(),
  };
}

/** A handoff that stays in flight until the test resolves it, the way a real POST does. */
function deferredDesktop() {
  let settle: (value: unknown) => void = () => {};
  companionsApi.openCompanionDesktop.mockReturnValue(
    new Promise((resolve) => { settle = resolve; }),
  );
  return async (value: unknown) => {
    await act(async () => {
      settle(value);
    });
  };
}

describe("CompanionsApp Box desktop", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    companionsApi.getCompanionThread.mockResolvedValue(thread());
    companionsApi.syncCompanionThread.mockResolvedValue(thread());
    companionsApi.getCompanionRuntime.mockResolvedValue(companion());
    window.open = vi.fn();
  });

  afterEach(() => {
    act(() => roots.splice(0).forEach((root) => root.unmount()));
    document.body.innerHTML = "";
    vi.useRealTimers();
  });

  it("opens the Lux desktop of a running Box in its own tab for a runner", async () => {
    const tab = tabStub();
    (window.open as ReturnType<typeof vi.fn>).mockReturnValue(tab);
    const resolveDesktop = deferredDesktop();
    const container = await open(companion());

    await clickBoxChip(container);

    // A browser only honours a tab the click itself asked for, so it is claimed blank while the
    // handoff is still in flight rather than after it answers.
    expect(window.open).toHaveBeenCalledWith("", "_blank");
    expect(tab.location.replace).not.toHaveBeenCalled();
    expect(companionsApi.openCompanionDesktop).toHaveBeenCalledWith("org-1", companionId);
    expect(container.textContent).toContain("Box · opening desktop");

    await resolveDesktop({
      desktop_url: "https://box.ascii.dev/desktop/bx_23456789?token=opaque",
      provisioning: false,
      automation: "lux",
    });

    expect(tab.location.replace).toHaveBeenCalledWith(
      "https://box.ascii.dev/desktop/bx_23456789?token=opaque",
    );
    // The claimed tab must not keep a handle on this one, and it must survive the handoff.
    expect(tab.opener).toBeNull();
    expect(tab.close).not.toHaveBeenCalled();
    // Reaching the desktop observes the Box; it must never start one.
    expect(companionsApi.startCompanionRuntime).not.toHaveBeenCalled();
  });

  it("explains a desktop Box is still provisioning instead of leaving a blank tab", async () => {
    const tab = tabStub();
    (window.open as ReturnType<typeof vi.fn>).mockReturnValue(tab);
    companionsApi.openCompanionDesktop.mockResolvedValue({
      desktop_url: null,
      provisioning: true,
      automation: "lux",
    });
    const container = await open(companion());

    await clickBoxChip(container);

    expect(tab.location.replace).not.toHaveBeenCalled();
    expect(tab.close).toHaveBeenCalled();
    expect(container.textContent).toContain("The Box desktop is still starting");
  });

  it("says so on the thread when the browser blocks the desktop tab", async () => {
    (window.open as ReturnType<typeof vi.fn>).mockReturnValue(null);
    companionsApi.openCompanionDesktop.mockResolvedValue({
      desktop_url: "https://box.ascii.dev/desktop/bx_23456789?token=opaque",
      provisioning: false,
      automation: "lux",
    });
    const container = await open(companion());

    await clickBoxChip(container);

    expect(container.textContent).toContain("blocked the Box desktop tab");
    // The handoff URL carries a Box token, so a failure never spells it out on the thread.
    expect(container.textContent).not.toContain("token=opaque");
    expect(container.textContent).toContain("Box · online");
  });

  it("closes the claimed tab and reports a failed handoff", async () => {
    const tab = tabStub();
    (window.open as ReturnType<typeof vi.fn>).mockReturnValue(tab);
    companionsApi.openCompanionDesktop.mockRejectedValue(new Error("Box is unreachable."));
    const container = await open(companion());

    await clickBoxChip(container);

    expect(tab.close).toHaveBeenCalled();
    expect(tab.location.replace).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Box is unreachable.");
    expect(container.textContent).toContain("Box · online");
  });

  it("keeps a Viewer's open thread free of every Box call, including status", async () => {
    vi.useFakeTimers();
    companionsApi.getCompanionThread.mockResolvedValue(
      thread({ viewer_id: "user-9", access: "viewer", read_only: true, can_send: false }),
    );
    const container = await open(companion({ access: "viewer", runtime: {
      ...companion().runtime,
      box_id: null,
      desktop_available: false,
    } }));

    await clickBoxChip(container);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });

    expect(companionsApi.openCompanionDesktop).not.toHaveBeenCalled();
    expect(companionsApi.startCompanionRuntime).not.toHaveBeenCalled();
    expect(companionsApi.syncCompanionThread).not.toHaveBeenCalled();
    expect(window.open).not.toHaveBeenCalled();
    // A Viewer's chip is a read-only projection: no live observation is requested for them.
    expect(companionsApi.getCompanionRuntime).not.toHaveBeenCalled();
    expect(companionsApi.getCompanionThread).toHaveBeenCalled();
  });

  it("re-observes a runner's running Box so the chip cannot go stale", async () => {
    vi.useFakeTimers();
    companionsApi.getCompanionRuntime.mockResolvedValue(companion({
      runtime: { ...companion().runtime, state: "stopped", daemon_state: "stopped" },
    }));
    const container = await open(companion());

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });

    expect(companionsApi.getCompanionRuntime).toHaveBeenCalledWith("org-1", companionId, {
      live: true,
    });
    expect(companionsApi.startCompanionRuntime).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Box · asleep");
  });
});
