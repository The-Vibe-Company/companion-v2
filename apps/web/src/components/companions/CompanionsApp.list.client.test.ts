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

const routerPush = vi.hoisted(() => vi.fn());

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: routerPush, refresh: () => {} }) }));

const companionsApi = vi.hoisted(() => ({
  duplicateCompanion: vi.fn(),
  getCompanionRuntime: vi.fn(),
  getCompanionThread: vi.fn(),
  listCompanions: vi.fn(),
  listCompanionProviders: vi.fn(),
  openCompanionDesktop: vi.fn(),
  sendCompanionMessage: vi.fn(),
  setCompanionProvider: vi.fn(),
  startCompanionRuntime: vi.fn(),
  syncCompanionThread: vi.fn(),
  updateCompanionMemberState: vi.fn(),
}));

vi.mock("@/lib/companions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/companions")>()),
  ...companionsApi,
}));

const companionId = "11111111-1111-4111-8111-111111111111";
const viewer = {
  id: "user-1",
  name: "Ada",
  email: "ada@example.test",
  initials: "A",
  avatarUrl: null,
};

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
  catalog: [{
    id: "anthropic",
    name: "Claude",
    auth_methods: ["api_key"],
    description: "",
    models: [{ id: "claude-opus-4-8", name: "Claude Opus 4.8", default: true }],
  }],
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
    model_id: "claude-opus-4-8",
    selected_skill_ids: [],
    can_write_skills: false,
    selected_mcp_account_ids: [],
    owner_id: "user-1",
    access: "owner",
    pinned: false,
    hidden: false,
    unread: false,
    last_message: {
      preview: "Drafted the launch note.",
      role: "assistant",
      author_id: null,
      author_name: null,
      created_at: "2026-08-14T09:05:00.000Z",
    },
    runtime: {
      state: "stopped",
      daemon_state: "stopped",
      box_id: null,
      provider_ids: ["anthropic"],
      provider_credential_generation: null,
      disk_layout_version: 6,
      desktop_available: false,
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
    last_read_ordinal: null,
    ...overrides,
  };
}

const roots: Root[] = [];

async function render(
  companions: Companion[],
  openedId: string | null = null,
  initialProviderSettings: CompanionProvidersResponse | null = providers,
) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(React.createElement(CompanionsApp, {
      orgs: [org],
      currentOrg: org,
      viewer,
      navigation,
      skills: [],
      initialCompanions: companions,
      initialProviders: initialProviderSettings,
      initialPlugins: [],
      initialCompanionId: openedId,
    }));
  });
  return container;
}

function row(container: HTMLElement, index = 0) {
  return container.querySelectorAll(".cmprow")[index] as HTMLElement;
}

function setControlled(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("CompanionsApp conversation list", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    companionsApi.listCompanions.mockResolvedValue([companion()]);
    companionsApi.listCompanionProviders.mockResolvedValue(providers);
    companionsApi.getCompanionThread.mockResolvedValue(thread());
    companionsApi.syncCompanionThread.mockResolvedValue(thread());
    companionsApi.getCompanionRuntime.mockResolvedValue(companion());
    companionsApi.updateCompanionMemberState.mockImplementation(
      async (_orgId: string, _companionId: string, patch: Partial<Companion>) => companion(patch),
    );
    companionsApi.duplicateCompanion.mockResolvedValue(companion({
      id: "33333333-3333-4333-8333-333333333333",
      name: "Luna copy",
    }));
  });

  afterEach(() => {
    act(() => roots.splice(0).forEach((root) => root.unmount()));
    document.body.innerHTML = "";
    vi.useRealTimers();
  });

  it("shows each thread's last line, and marks the ones the reader's own watermark is behind", async () => {
    const container = await render([companion({ unread: true })]);

    expect(row(container).textContent).toContain("Drafted the launch note.");
    expect(row(container).querySelector(".cmprow__unread")).not.toBeNull();
  });

  it("renders the conversation list before the live provider catalog resolves", async () => {
    let resolveProviders!: (value: CompanionProvidersResponse) => void;
    companionsApi.listCompanionProviders.mockReturnValue(new Promise((resolve) => {
      resolveProviders = resolve;
    }));

    const container = await render([companion()], null, null);
    const newCompanion = [...container.querySelectorAll("button")]
      .find((button) => button.textContent?.includes("New companion")) as HTMLButtonElement;

    expect(row(container).textContent).toContain("Drafted the launch note.");
    expect(newCompanion.disabled).toBe(true);
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      "Loading provider settings",
    );
    expect(companionsApi.listCompanionProviders).toHaveBeenCalledWith("org-1");

    await act(async () => {
      resolveProviders(providers);
      await Promise.resolve();
    });

    expect(newCompanion.disabled).toBe(false);
    expect(container.querySelector('[role="status"]')).toBeNull();
  });

  it("recovers provider actions after a failed request is retried", async () => {
    companionsApi.listCompanionProviders
      .mockRejectedValueOnce(new Error("Provider catalog unavailable."))
      .mockResolvedValueOnce(providers);

    const container = await render([], null, null);
    const alert = container.querySelector('[role="alert"]') as HTMLElement;
    const retry = [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "Retry") as HTMLButtonElement;

    expect(alert.textContent).toContain("Provider catalog unavailable.");
    expect(retry).toBeDefined();

    await act(async () => {
      retry.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    const newCompanion = [...container.querySelectorAll("button")]
      .find((button) => button.textContent?.includes("New companion")) as HTMLButtonElement;
    expect(companionsApi.listCompanionProviders).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(newCompanion.disabled).toBe(false);
  });

  it("shows provider failure and Retry without leaving an open thread", async () => {
    companionsApi.listCompanionProviders
      .mockRejectedValueOnce(new Error("Provider catalog unavailable."))
      .mockResolvedValueOnce(providers);

    const container = await render([companion()], companionId, null);
    const alert = container.querySelector('[role="alert"]') as HTMLElement;
    const retry = [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "Retry") as HTMLButtonElement;

    expect(alert.textContent).toContain("Provider catalog unavailable.");
    expect(container.textContent).toContain("Drafted the launch note.");

    await act(async () => {
      retry.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    expect(companionsApi.listCompanionProviders).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect([...container.querySelectorAll("button")]
      .some((button) => button.textContent === "Providers")).toBe(true);
  });

  it("leaves a caught-up thread unmarked, whatever it last said", async () => {
    // Read state is the control plane's per-member watermark (THE-351), not this device's guess.
    const container = await render([companion({ unread: false })]);

    expect(row(container).textContent).toContain("Drafted the launch note.");
    expect(row(container).querySelector(".cmprow__unread")).toBeNull();
  });

  it("keeps the shared search toolbar visible for empty and no-match states", async () => {
    const empty = await render([]);
    expect(empty.querySelector<HTMLInputElement>('input[aria-label="Search companions"]')).not.toBeNull();
    expect(empty.querySelector(".empty__title")?.textContent).toBe("No Companions yet");

    act(() => roots.pop()?.unmount());
    empty.remove();

    const container = await render([
      companion(),
      companion({
        id: "22222222-2222-4222-8222-222222222222",
        name: "Stashed",
        hidden: true,
      }),
    ]);
    const search = container.querySelector<HTMLInputElement>('input[aria-label="Search companions"]')!;
    await act(async () => setControlled(search, "missing"));

    expect(container.querySelector(".empty__title")?.textContent).toBe("No Companions match");
    expect(container.querySelector(".companions-hidden")).toBeNull();
  });

  it("opens the single row menu from the keyboard without opening the chat", async () => {
    const container = await render([companion()]);
    const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Actions for Luna"]')!;
    trigger.focus();

    await act(async () => {
      trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    });

    const menu = document.body.querySelector<HTMLElement>('[role="menu"][aria-label="Actions for Luna"]');
    expect(menu).not.toBeNull();
    expect(menu?.textContent).toContain("Settings");
    expect(menu?.textContent).toContain("Share");
    expect(menu?.textContent).toContain("Pin");
    expect(menu?.textContent).toContain("Mark as unread");
    expect(menu?.textContent).toContain("Duplicate");
    expect(menu?.textContent).toContain("Hide");
    expect(document.activeElement?.textContent).toBe("Settings");
    expect(container.textContent).not.toContain("Chat with Luna");

    await act(async () => {
      menu?.querySelector<HTMLButtonElement>('button[role="menuitem"]')?.click();
    });
    expect(routerPush).toHaveBeenCalledWith(`/companions/${companionId}/settings`);
    expect(container.textContent).not.toContain("Chat with Luna");
  });

  it("keeps owner-only actions out of a Viewer's row menu", async () => {
    const container = await render([companion({ access: "viewer", owner_id: "user-2" })]);
    const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Actions for Luna"]')!;

    await act(async () => trigger.click());

    const menu = document.body.querySelector<HTMLElement>('[role="menu"][aria-label="Actions for Luna"]');
    expect(menu?.textContent).toContain("Settings");
    expect(menu?.textContent).toContain("Pin");
    expect(menu?.textContent).toContain("Mark as unread");
    expect(menu?.textContent).toContain("Hide");
    expect(menu?.textContent).not.toContain("Share");
    expect(menu?.textContent).not.toContain("Duplicate");
  });

  it("opens the last menu action with ArrowUp", async () => {
    const container = await render([companion()]);
    const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Actions for Luna"]')!;
    trigger.focus();

    await act(async () => {
      trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    });

    expect(document.activeElement?.textContent).toBe("Hide");
  });

  it("routes member-state actions through the row menu and applies the server result", async () => {
    const container = await render([companion()]);
    const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Actions for Luna"]')!;

    await act(async () => trigger.click());
    const pin = [...document.body.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
      .find((item) => item.textContent === "Pin")!;
    await act(async () => pin.click());
    await act(async () => {
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    });

    expect(companionsApi.updateCompanionMemberState).toHaveBeenCalledWith(
      "org-1",
      companionId,
      { pinned: true },
    );
    expect(container.querySelector(".companions-row--pinned")).not.toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("moves focus to search after hiding removes the active row", async () => {
    companionsApi.updateCompanionMemberState.mockResolvedValue(companion({ hidden: true }));
    const container = await render([companion()]);
    const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Actions for Luna"]')!;

    await act(async () => trigger.click());
    const hide = [...document.body.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
      .find((item) => item.textContent === "Hide")!;
    await act(async () => hide.click());
    await act(async () => {
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    });

    expect(document.activeElement).toBe(
      container.querySelector<HTMLInputElement>('input[aria-label="Search companions"]'),
    );
    expect(container.querySelector(".companions-hidden")?.textContent).toContain("Luna");
  });

  it("duplicates from the row menu and renders the returned Companion", async () => {
    const container = await render([companion()]);
    const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Actions for Luna"]')!;

    await act(async () => trigger.click());
    const duplicate = [...document.body.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
      .find((item) => item.textContent === "Duplicate")!;
    await act(async () => duplicate.click());

    expect(companionsApi.duplicateCompanion).toHaveBeenCalledWith("org-1", companionId);
    expect(container.textContent).toContain("Luna copy");
  });

  it("keeps hidden Companions in the same row grammar with a focused restore menu", async () => {
    const container = await render([
      companion({ name: "Visible" }),
      companion({
        id: "22222222-2222-4222-8222-222222222222",
        name: "Stashed",
        hidden: true,
      }),
    ]);
    const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Actions for Stashed"]')!;

    await act(async () => trigger.click());

    const menu = document.body.querySelector<HTMLElement>('[role="menu"][aria-label="Actions for Stashed"]');
    expect(menu?.textContent).toContain("Settings");
    expect(menu?.textContent).toContain("Unhide");
    expect(menu?.textContent).not.toContain("Hide");
  });

  it("opens the chat from the primary row button", async () => {
    const container = await render([companion()]);
    const main = container.querySelector<HTMLButtonElement>(".companions-row__main")!;

    await act(async () => main.click());

    expect(container.querySelector('[aria-label="Back to Companions"]')).not.toBeNull();
  });

  it("clears the mark on the thread it opens, including one reached by a deep link", async () => {
    companionsApi.getCompanionThread.mockResolvedValue(thread({
      entries: [{
        event_id: "pi:1",
        ordinal: 0,
        role: "assistant",
        content: "Drafted the launch note.",
        author_id: null,
        author_name: null,
        tool: null,
        decision: null,
        reasoning: null,
        created_at: "2026-08-14T09:05:00.000Z",
      }],
    }));

    // Nobody clicked this row, so the optimistic clear on open never ran; the read that answers is
    // what the control plane already marked, and the row has to agree with it. Asserting the dot on
    // the open thread would prove nothing — an open thread is never dotted — so the thread is
    // closed first, which is the moment a row that never cleared would show one.
    const container = await render([companion({ unread: true })], companionId);

    const back = [...container.querySelectorAll("button")]
      .find((button) => button.getAttribute("aria-label") === "Back to Companions") as HTMLButtonElement;
    await act(async () => {
      back.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(row(container).querySelector(".cmprow__unread")).toBeNull();
  });

  it("keeps a preview a mutation did not answer with", async () => {
    // Every mutation reports `last_message: null`; replacing the row wholesale would blank the line
    // the sidebar is showing. A wake is the mutation a reader is most likely to be watching.
    companionsApi.startCompanionRuntime.mockResolvedValue(
      companion({ last_message: null, runtime: { ...companion().runtime, state: "provisioning" } }),
    );
    const container = await render([companion()], companionId);

    const wake = [...container.querySelectorAll("button")]
      .find((button) => button.textContent?.includes("Wake")) as HTMLButtonElement;
    await act(async () => {
      wake.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(row(container).textContent).toContain("Drafted the launch note.");
  });

  const said = (ordinal: number) => ({
    event_id: `pi:${ordinal}`,
    ordinal,
    role: "assistant" as const,
    content: `Line ${ordinal}`,
    author_id: null,
    author_name: null,
    tool: null,
    decision: null,
    reasoning: null,
    created_at: `2026-08-14T09:0${ordinal}:00.000Z`,
  });

  it("takes the read watermark once per thread, however often the thread is re-read", async () => {
    // The read that reports the watermark is also the read that advances it, so the next poll
    // reports a newer one. Capturing that would draw a divider above a line this reader is watching
    // arrive, seconds after they opened a thread they had never opened before.
    vi.useFakeTimers();
    let reads = 0;
    companionsApi.getCompanionThread.mockImplementation(async () => {
      reads += 1;
      return thread({
        entries: [said(0), said(1), said(2), said(3)],
        // A first visit, and then the watermark that this reader's own first read just moved.
        last_read_ordinal: reads === 1 ? null : 2,
      });
    });

    const container = await render([companion()], companionId);
    expect(container.querySelector("[data-slot='chat-new-separator']")).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(9_000);
    });

    expect(reads).toBeGreaterThan(1);
    expect(container.querySelector("[data-slot='chat-new-separator']")).toBeNull();
  });

  it("takes it again when the sidebar moves to another thread", async () => {
    // One thread's watermark must never judge another thread's transcript.
    const nova = "22222222-2222-4222-8222-222222222222";
    companionsApi.getCompanionThread.mockImplementation(async (_org: string, id: string) =>
      thread({
        companion_id: id,
        entries: [said(0), said(1), said(2), said(3)],
        // Luna is caught up; Nova has two lines this reader has not seen.
        last_read_ordinal: id === companionId ? 3 : 1,
      }));
    const container = await render(
      [companion(), companion({ id: nova, name: "Nova" })],
      companionId,
    );

    expect(container.querySelector("[data-slot='chat-new-separator']")).toBeNull();

    const nextRow = [...container.querySelectorAll(".cmprow")]
      .find((row) => row.querySelector(".cmprow__name")?.textContent === "Nova") as HTMLButtonElement;
    await act(async () => {
      nextRow.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(container.querySelector("[data-slot='chat-new-separator']")).not.toBeNull();
  });

  it("leaves the roster's order to the control plane when a read answers", async () => {
    // Pin order is the server's — pin age first, then recency — and the client does not know pin age.
    // Re-sorting here on every answer would move rows under the cursor and then lose the argument to
    // the next list poll, which puts them back.
    const nova = "22222222-2222-4222-8222-222222222222";
    const luna = companion({ pinned: true, updated_at: "2026-08-14T09:00:00.000Z" });
    const rows = [
      companion({ id: nova, name: "Nova", pinned: true, updated_at: "2026-08-10T09:00:00.000Z" }),
      luna,
    ];
    companionsApi.startCompanionRuntime.mockResolvedValue({
      ...luna,
      runtime: { ...luna.runtime, state: "provisioning" },
    });
    const container = await render(rows, companionId);

    const names = () => [...container.querySelectorAll(".cmprow__name")]
      .map((row) => row.textContent);
    expect(names()).toEqual(["Nova", "Luna"]);

    const wake = [...container.querySelectorAll("button")]
      .find((button) => button.textContent?.includes("Wake")) as HTMLButtonElement;
    await act(async () => {
      wake.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(names()).toEqual(["Nova", "Luna"]);
  });

  it("re-reads the list on a slow cadence without contacting a Box", async () => {
    vi.useFakeTimers();
    const container = await render([companion()]);
    companionsApi.listCompanions.mockResolvedValue([companion({
      last_message: {
        preview: "Then the pricing page.",
        role: "assistant",
        author_id: null,
        author_name: null,
        created_at: "2026-08-14T09:30:00.000Z",
      },
    })]);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(45_000);
    });

    expect(row(container).textContent).toContain("Then the pricing page.");
    // The list is the control-plane read model, and nothing about polling it observes or resumes a
    // Box for any Companion in it.
    expect(companionsApi.openCompanionDesktop).not.toHaveBeenCalled();
    expect(companionsApi.startCompanionRuntime).not.toHaveBeenCalled();
    expect(companionsApi.getCompanionRuntime).not.toHaveBeenCalled();
  });
});
