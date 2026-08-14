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

/** Open or close the Computer panel the way a runner does: the toggle in the thread header. */
async function clickComputerToggle(container: HTMLElement) {
  const toggle = container.querySelector(".chat-computer-toggle") as HTMLButtonElement | null;
  if (toggle) {
    await act(async () => {
      toggle.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  }
  return toggle;
}

function panelFrame(container: HTMLElement) {
  return container.querySelector(".chat-computer__frame") as HTMLIFrameElement | null;
}

function desktopPayload(url: string | null, overrides: Record<string, unknown> = {}) {
  return {
    desktop_url: url,
    provisioning: url === null,
    automation: "lux",
    transport: url === null ? null : "vnc",
    ...overrides,
  };
}

/**
 * Stands in for the tab a click claims: it records where it was sent, whether it still had a handle
 * on this window at that moment, and whether it was closed.
 */
function tabStub(refuses: { replace?: Error; disown?: Error } = {}) {
  const tab = {
    opener: {} as unknown,
    openerWhenSent: null as unknown,
    location: { replace: vi.fn() },
    close: vi.fn(),
  };
  tab.location.replace.mockImplementation(() => {
    tab.openerWhenSent = tab.opener;
    if (refuses.replace) throw refuses.replace;
  });
  if (refuses.disown) {
    // A tab that has left for a cross-origin desktop refuses to have its opener written.
    Object.defineProperty(tab, "opener", {
      get: () => "held",
      set: () => { throw refuses.disown; },
    });
  }
  return tab;
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

    // A browser only honours a tab the click itself asked for, so it is claimed while the handoff is
    // still in flight rather than after it answers. The claim names `about:blank`: asked for the
    // empty URL, a browser may claim a copy of this page instead of a tab to hand off.
    expect(window.open).toHaveBeenCalledWith("about:blank", "_blank");
    expect(window.open).not.toHaveBeenCalledWith("", "_blank");
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
    // Disowning the tab before the handoff can detach the handle the handoff needs, and the desktop
    // URL then silently never lands, so the tab still holds its handle while it is being sent.
    expect(tab.openerWhenSent).not.toBeNull();
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

    // The claimed tab is blank, so closing it is allowed and no copy of the app is left behind.
    expect(window.open).toHaveBeenCalledWith("about:blank", "_blank");
    expect(tab.location.replace).not.toHaveBeenCalled();
    expect(tab.close).toHaveBeenCalled();
    expect(container.textContent).toContain("The Box desktop is still starting");
  });

  it("keeps a handed-off tab when it refuses to be disowned afterwards", async () => {
    const tab = tabStub({ disown: new Error("Blocked a frame from accessing a cross-origin frame.") });
    (window.open as ReturnType<typeof vi.fn>).mockReturnValue(tab);
    companionsApi.openCompanionDesktop.mockResolvedValue({
      desktop_url: "https://box.ascii.dev/desktop/bx_23456789?token=opaque",
      provisioning: false,
      automation: "lux",
    });
    const container = await open(companion());

    await clickBoxChip(container);

    // The desktop was reached, so a refused disown is not a failed handoff: the tab stays and the
    // thread says nothing went wrong.
    expect(tab.location.replace).toHaveBeenCalledWith(
      "https://box.ascii.dev/desktop/bx_23456789?token=opaque",
    );
    expect(tab.close).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain("cross-origin");
    expect(container.textContent).toContain("Box · online");
  });

  it("closes the claimed tab when the browser refuses to send it to the desktop", async () => {
    const tab = tabStub({ replace: new Error("The desktop tab could not be reached.") });
    (window.open as ReturnType<typeof vi.fn>).mockReturnValue(tab);
    companionsApi.openCompanionDesktop.mockResolvedValue({
      desktop_url: "https://box.ascii.dev/desktop/bx_23456789?token=opaque",
      provisioning: false,
      automation: "lux",
    });
    const container = await open(companion());

    await clickBoxChip(container);

    // A refused handoff must never read as a success: the blank tab goes and the reason is said,
    // without the Box token the URL carries.
    expect(tab.close).toHaveBeenCalled();
    expect(container.textContent).toContain("The desktop tab could not be reached.");
    expect(container.textContent).not.toContain("token=opaque");
    expect(container.textContent).toContain("Box · online");
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

  it("keeps a failed handoff readable while the thread keeps polling", async () => {
    vi.useFakeTimers();
    const tab = tabStub();
    (window.open as ReturnType<typeof vi.fn>).mockReturnValue(tab);
    companionsApi.openCompanionDesktop.mockResolvedValue({
      desktop_url: null,
      provisioning: true,
      automation: "lux",
    });
    const container = await open(companion());

    await clickBoxChip(container);
    expect(container.textContent).toContain("The Box desktop is still starting");

    // An awake thread re-reads itself every couple of seconds. That refresh clears its own load
    // failure, and it must not take this answer with it: a wiped notice reads as nothing happened.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });

    expect(companionsApi.syncCompanionThread).toHaveBeenCalled();
    expect(container.textContent).toContain("The Box desktop is still starting");
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

/**
 * Product promise:
 * A runner opens the Computer panel and watches the Box desktop in the thread. Every join mints its
 * own URL, the desktop tab is still one click away, and no part of this can start a Box.
 *
 * Regression guarded:
 * Box rotates the stream token on every state change, so a URL held from an earlier join is one that
 * has already stopped working. A panel that replayed a stored URL would show a dead stream, and a
 * panel that kept one across a Box that stopped would show a screen belonging to nothing.
 */
describe("CompanionsApp Computer panel", () => {
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

  it("mints a desktop when a runner opens the panel and shows it in the thread", async () => {
    companionsApi.openCompanionDesktop.mockResolvedValue(
      desktopPayload("https://box.ascii.dev/vnc/bx_23456789?token=first"),
    );
    const container = await open(companion());

    // Opening the thread alone contacts no desktop: the panel is what a runner asks for.
    expect(companionsApi.openCompanionDesktop).not.toHaveBeenCalled();
    expect(panelFrame(container)).toBeNull();

    await clickComputerToggle(container);

    expect(companionsApi.openCompanionDesktop).toHaveBeenCalledWith("org-1", companionId);
    expect(panelFrame(container)?.getAttribute("src"))
      .toBe("https://box.ascii.dev/vnc/bx_23456789?token=first");
    // A live desktop is a read of a Box that is already running, never a start.
    expect(companionsApi.startCompanionRuntime).not.toHaveBeenCalled();
    // The tab handoff is untouched by the panel being open.
    expect(window.open).not.toHaveBeenCalled();
  });

  it("mints another desktop each time the panel is joined", async () => {
    companionsApi.openCompanionDesktop
      .mockResolvedValueOnce(desktopPayload("https://box.ascii.dev/vnc/bx_23456789?token=first"))
      .mockResolvedValueOnce(desktopPayload("https://box.ascii.dev/vnc/bx_23456789?token=second"));
    const container = await open(companion());

    await clickComputerToggle(container);

    expect(panelFrame(container)?.getAttribute("src")).toContain("token=first");

    // Closing the panel drops the stream, and opening it again is a new join rather than a replay.
    await clickComputerToggle(container);

    expect(panelFrame(container)).toBeNull();

    await clickComputerToggle(container);

    expect(companionsApi.openCompanionDesktop).toHaveBeenCalledTimes(2);
    expect(panelFrame(container)?.getAttribute("src")).toContain("token=second");
  });

  it("keeps a desktop the panel could not mint off screen and says why", async () => {
    companionsApi.openCompanionDesktop.mockResolvedValue(desktopPayload(null));
    const container = await open(companion());

    await clickComputerToggle(container);

    expect(panelFrame(container)).toBeNull();
    expect(container.textContent).toContain("The Box desktop is still starting");
  });

  it("reports a refused join on the panel without the token the URL carries", async () => {
    companionsApi.openCompanionDesktop.mockRejectedValue(new Error("Box is unreachable."));
    const container = await open(companion());

    await clickComputerToggle(container);

    expect(container.textContent).toContain("Box is unreachable.");
    expect(container.textContent).not.toContain("token=");
    expect(panelFrame(container)).toBeNull();
  });

  it("drops the stream when the Box stops under an open panel", async () => {
    vi.useFakeTimers();
    companionsApi.openCompanionDesktop.mockResolvedValue(
      desktopPayload("https://box.ascii.dev/vnc/bx_23456789?token=first"),
    );
    // The runner's slow re-observation finds the Box has stopped underneath the stream.
    companionsApi.getCompanionRuntime.mockResolvedValue(companion({
      runtime: { ...companion().runtime, state: "stopped", daemon_state: "stopped" },
    }));
    const container = await open(companion());

    await clickComputerToggle(container);

    expect(panelFrame(container)?.getAttribute("src")).toContain("token=first");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });

    // A stopped Box has no screen, and its last URL must not be left on one.
    expect(panelFrame(container)).toBeNull();
    expect(container.innerHTML).not.toContain("token=first");
    expect(container.textContent).toContain("this Box is not running");
    expect(companionsApi.startCompanionRuntime).not.toHaveBeenCalled();
  });

  it("wakes an asleep Box from the panel only when a runner asks", async () => {
    companionsApi.startCompanionRuntime.mockResolvedValue(companion());
    companionsApi.openCompanionDesktop.mockResolvedValue(
      desktopPayload("https://box.ascii.dev/vnc/bx_23456789?token=first"),
    );
    const asleep = companion({
      runtime: { ...companion().runtime, state: "stopped", daemon_state: "stopped" },
    });
    const container = await open(asleep);

    await clickComputerToggle(container);

    // Opening the panel on a sleeping Box mints nothing and starts nothing.
    expect(companionsApi.openCompanionDesktop).not.toHaveBeenCalled();
    expect(companionsApi.startCompanionRuntime).not.toHaveBeenCalled();
    expect(container.textContent).toContain("this Box is not running");

    const wake = [...container.querySelectorAll(".chat-computer__actions button")]
      .find((button) => (button.textContent ?? "").includes("Wake")) as HTMLButtonElement;
    await act(async () => {
      wake.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    // The wake is the existing one, and the Box it brings up is then joined for its screen.
    expect(companionsApi.startCompanionRuntime).toHaveBeenCalledWith("org-1", companionId);
    expect(companionsApi.openCompanionDesktop).toHaveBeenCalledTimes(1);
    expect(panelFrame(container)?.getAttribute("src")).toContain("token=first");
  });

  it("never gives a Viewer a panel to open, so it cannot become their wake", async () => {
    vi.useFakeTimers();
    companionsApi.getCompanionThread.mockResolvedValue(
      thread({ viewer_id: "user-9", access: "viewer", read_only: true, can_send: false }),
    );
    const container = await open(companion({
      access: "viewer",
      runtime: { ...companion().runtime, box_id: null, desktop_available: false },
    }));

    const toggle = await clickComputerToggle(container);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });

    expect(toggle).toBeNull();
    expect(panelFrame(container)).toBeNull();
    expect(companionsApi.openCompanionDesktop).not.toHaveBeenCalled();
    expect(companionsApi.startCompanionRuntime).not.toHaveBeenCalled();
  });
});
