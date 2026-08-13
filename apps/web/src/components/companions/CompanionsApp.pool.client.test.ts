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
  listCompanions: vi.fn(),
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

const smokeSixId = "11111111-1111-4111-8111-111111111111";
const smokeFiveId = "22222222-2222-4222-8222-222222222222";

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
  catalog: [{ id: "anthropic", name: "Claude", auth_methods: ["api_key"], description: "" }],
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

/** A Companion whose workspace has never woken its shared Box. */
function asleep(id: string, name: string, overrides: Partial<Companion> = {}): Companion {
  return {
    id,
    name,
    persona: null,
    owner_id: "user-1",
    access: "owner",
    runtime: {
      state: "not_created",
      daemon_state: "unknown",
      box_id: null,
      provider_ids: ["anthropic"],
      provider_credential_generation: null,
      disk_layout_version: 1,
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

function running(companion: Companion): Companion {
  return {
    ...companion,
    runtime: {
      ...companion.runtime,
      state: "running",
      daemon_state: "running",
      box_id: "bx_23456789",
      desktop_available: true,
      disk_layout_version: 3,
      last_started_at: "2026-08-13T12:00:00.000Z",
    },
  };
}

function thread(companionId: string, overrides: Partial<Thread> = {}): Thread {
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

async function render(initialCompanions: Companion[], openedId: string | null) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(React.createElement(CompanionsApp, {
      orgs: [org],
      currentOrg: org,
      navigation,
      initialCompanions,
      initialProviders: providers,
      initialPlugins: [],
      initialCompanionId: openedId,
    }));
  });
  return container;
}

function button(container: HTMLElement, label: string): HTMLElement {
  const match = [...container.querySelectorAll("button")]
    .find((node) => node.textContent?.trim() === label);
  if (!match) throw new Error(`no button labelled ${label}`);
  return match as HTMLElement;
}

async function click(node: HTMLElement) {
  await act(async () => {
    node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

/** Open a Companion from the list the way a member navigating the workspace does. */
async function openRow(container: HTMLElement, name: string) {
  const row = [...container.querySelectorAll(".companions-row__main")]
    .find((node) => node.textContent?.includes(name));
  if (!row) throw new Error(`no row for ${name}`);
  await click(row as HTMLElement);
}

/**
 * Product promise (THE-330): one Box per workspace. A member who wakes one Companion has woken the
 * machine every Companion in the workspace runs on, so the next Companion they open shows the same
 * chip — the same Box, already online — without being woken itself.
 */
describe("CompanionsApp shared Box chip", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    companionsApi.getCompanionThread.mockImplementation(
      async (_orgId: string, companionId: string) => thread(companionId),
    );
    companionsApi.syncCompanionThread.mockImplementation(
      async (_orgId: string, companionId: string) => thread(companionId),
    );
  });

  afterEach(() => {
    act(() => roots.splice(0).forEach((root) => root.unmount()));
    document.body.innerHTML = "";
    vi.useRealTimers();
  });

  it("shows the woken Box on a sibling Companion that was never woken", async () => {
    const smokeSix = asleep(smokeSixId, "Smoke 6");
    const smokeFive = asleep(smokeFiveId, "Smoke 5");
    companionsApi.startCompanionRuntime.mockResolvedValue(running(smokeSix));
    // Every read that could reconcile the wake fails, so the sibling can only be showing the answer
    // the wake itself returned — and a failed read must not undo it either.
    companionsApi.listCompanions.mockRejectedValue(new Error("network"));
    companionsApi.getCompanionRuntime.mockRejectedValue(new Error("network"));
    const container = await render([smokeSix, smokeFive], smokeSixId);

    await click(button(container, "Wake"));

    expect(container.textContent).toContain("Box · online");

    // Back to the list: the sibling's row already reads the shared Box as online.
    await click(container.querySelector(".chat-back") as HTMLElement);
    expect(container.textContent).toContain("Smoke 5");
    expect([...container.querySelectorAll(".companions-row")]
      .filter((row) => row.textContent?.includes("Online"))).toHaveLength(2);

    await openRow(container, "Smoke 5");

    expect(container.textContent).toContain("Box · online");
    expect(container.textContent).not.toContain("Box · asleep");
    // One Wake for the whole workspace: opening the sibling must not offer or make another.
    expect([...container.querySelectorAll("button")]
      .some((node) => node.textContent?.trim() === "Wake")).toBe(false);
    expect(companionsApi.startCompanionRuntime).toHaveBeenCalledTimes(1);
    expect(companionsApi.startCompanionRuntime).toHaveBeenCalledWith("org-1", smokeSixId);
  });

  it("re-reads the workspace list after a wake so a later navigation cannot go stale", async () => {
    const smokeSix = asleep(smokeSixId, "Smoke 6");
    const smokeFive = asleep(smokeFiveId, "Smoke 5");
    companionsApi.startCompanionRuntime.mockResolvedValue(running(smokeSix));
    companionsApi.listCompanions.mockResolvedValue([running(smokeSix), running(smokeFive)]);
    companionsApi.getCompanionRuntime.mockImplementation(
      async (_orgId: string, companionId: string) =>
        running(asleep(companionId, companionId === smokeSixId ? "Smoke 6" : "Smoke 5")),
    );
    const container = await render([smokeSix, smokeFive], smokeSixId);

    await click(button(container, "Wake"));

    expect(companionsApi.listCompanions).toHaveBeenCalledWith("org-1");
    expect(container.textContent).toContain("Box · online");
  });

  it("re-reads a Companion opened from a list that predates a wake elsewhere", async () => {
    const smokeFive = asleep(smokeFiveId, "Smoke 5");
    // Another surface woke the shared Box after this page rendered, so the control plane already
    // reports it running while the loaded row still says asleep.
    companionsApi.getCompanionRuntime.mockResolvedValue(running(smokeFive));
    const container = await render([asleep(smokeSixId, "Smoke 6"), smokeFive], null);

    await openRow(container, "Smoke 5");

    // The read is the control-plane projection: opening a Companion never observes or wakes a Box.
    expect(companionsApi.getCompanionRuntime).toHaveBeenCalledWith("org-1", smokeFiveId, {
      live: false,
    });
    expect(companionsApi.startCompanionRuntime).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Box · online");
  });

  it("keeps a Viewer's chip free of the Box a teammate's wake started", async () => {
    const smokeSix = asleep(smokeSixId, "Smoke 6");
    const watched = asleep(smokeFiveId, "Smoke 5", { owner_id: "user-9", access: "viewer" });
    companionsApi.startCompanionRuntime.mockResolvedValue(running(smokeSix));
    companionsApi.listCompanions.mockRejectedValue(new Error("network"));
    companionsApi.getCompanionRuntime.mockRejectedValue(new Error("network"));
    companionsApi.getCompanionThread.mockImplementation(async (_orgId: string, id: string) =>
      id === smokeFiveId
        ? thread(id, { access: "viewer", read_only: true, can_send: false })
        : thread(id));
    const container = await render([smokeSix, watched], smokeSixId);

    await click(button(container, "Wake"));
    await click(container.querySelector(".chat-back") as HTMLElement);
    await openRow(container, "Smoke 5");

    // The Viewer reads the shared state, and the chip stays inert: no Box id, so no desktop handoff.
    expect(container.textContent).toContain("Box · online");
    expect(container.querySelector("button.chat-box")).toBeNull();
    expect(companionsApi.openCompanionDesktop).not.toHaveBeenCalled();
  });
});
