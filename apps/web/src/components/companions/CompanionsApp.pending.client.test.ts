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

/**
 * A Companion the control plane is still starting has to stop saying Starting on its own.
 *
 * Production reached the state this guards against: the wake finished, the Box came up, Pi answered
 * the queued message and the reply was on screen — and for about a minute the chip still read
 * Starting beside it, with the Wake control still offered, until an unrelated action happened to
 * re-read the row. The row itself was right within a second of the Box coming up; nothing was reading
 * it. The Box-status poll only runs once the state is already `running`, and the request that starts a
 * wake answers once — before the lifecycle finishes, when it answers at all, since a wake can outlive
 * the proxy in front of the API.
 *
 * So the case here is a wake whose own response never arrives, which is the one that used to leave the
 * chip stranded: nothing but the pending poll can move it.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {}, refresh: () => {} }) }));

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
  catalog: [{ id: "anthropic", name: "Claude", auth_methods: ["api_key"], description: "", models: [{ id: "claude-opus-4-8", name: "Claude Opus 4.8", default: true }] }],
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

function companionIn(state: "provisioning" | "running" | "error"): Companion {
  return {
    id: companionId,
    name: "Luna",
    persona: "Incident research assistant",
    model_id: "claude-opus-4-8",
    owner_id: "user-1",
    access: "owner",
    runtime: {
      state,
      daemon_state: state === "running" ? "running" : state === "error" ? "error" : "starting",
      box_id: "bx_23456789",
      provider_ids: ["anthropic"],
      provider_credential_generation: null,
      disk_layout_version: 6,
      desktop_available: state === "running",
      last_error: state === "error" ? "Pi resources failed to prepare (exit 1)" : null,
      last_observed_at: null,
      last_started_at: null,
      last_stopped_at: null,
    },
    created_at: "2026-08-12T12:00:00.000Z",
    updated_at: "2026-08-12T12:00:00.000Z",
  };
}

const emptyThread: Thread = {
  companion_id: companionId,
  viewer_id: "user-1",
  access: "owner",
  read_only: false,
  can_send: true,
  entries: [],
  pending_count: 1,
  last_message_at: null,
};

/**
 * A control plane mid-wake. Its `/runtime` projection reports whatever the lifecycle has reached, so
 * the test can land the wake the way the control plane does — by writing the row — rather than by
 * answering a request the browser may never hear back from.
 */
function controlPlane(options: { wakeAnswers?: boolean; holdFirstRead?: boolean } = {}) {
  let settled = companionIn("provisioning");
  const runtimeReads: string[] = [];
  let held = 0;
  let release = () => {};
  const holding = new Promise<void>((resolve) => { release = resolve; });

  const json = (body: unknown) => new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (method === "POST" && url.includes("/runtime/start")) {
      // A wake that outlives the proxy in front of the API: the lifecycle runs on, and this request
      // is never answered.
      if (!options.wakeAnswers) return await new Promise<Response>(() => {});
      return json({ companion: settled });
    }
    if (url.includes("/runtime")) {
      runtimeReads.push(url);
      // The first read answers last, carrying the state the Companion has since left.
      if (options.holdFirstRead && held++ === 0) {
        const stale = settled;
        await holding;
        return json({ companion: stale, source: "control_plane" });
      }
      return json({ companion: settled, source: "control_plane" });
    }
    if (url.includes("/thread")) return json({ thread: emptyThread });
    return json({});
  });

  return {
    fetchMock,
    runtimeReads,
    /** What the wake writes when the Box and Pi are up: the state the chip is waiting for. */
    boxCameUp: () => { settled = companionIn("running"); },
    /** What a wake that fails writes instead. */
    wakeFailed: () => { settled = companionIn("error"); },
    /** Let the overtaken read finally answer. */
    releaseFirstRead: () => release(),
  };
}

const roots: Root[] = [];

async function openThread(initial: Companion) {
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

/** Time the browser spends waiting on a lifecycle, in seconds. */
async function wait(seconds: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(seconds * 1_000);
  });
}

const chip = (container: HTMLElement) => container.querySelector(".chat-box")?.textContent;
const wakeControl = (container: HTMLElement) =>
  [...container.querySelectorAll("button")].find((button) => button.textContent === "Wake") ?? null;

describe("CompanionsApp while a Companion is starting", () => {
  let api: ReturnType<typeof controlPlane>;

  beforeEach(() => {
    vi.useFakeTimers();
    api = controlPlane();
    vi.stubGlobal("fetch", api.fetchMock);
  });

  afterEach(() => {
    act(() => roots.splice(0).forEach((root) => root.unmount()));
    document.body.innerHTML = "";
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("reports the Box online once the wake records it, without being asked again", async () => {
    const container = await openThread(companionIn("provisioning"));

    await act(async () => {
      wakeControl(container)?.click();
    });
    await wait(20);
    expect(chip(container)).toContain("Box · starting");

    api.boxCameUp();
    await wait(5);

    expect(chip(container)).toContain("Box · online");
    expect(wakeControl(container)).toBeNull();
  });

  it("reports a wake that failed, so a stalled start is offered as a retry", async () => {
    const container = await openThread(companionIn("provisioning"));

    api.wakeFailed();
    await wait(5);

    expect(chip(container)).toContain("Box · error");
    expect(container.textContent).toContain("Pi resources failed to prepare");
    expect(wakeControl(container)).not.toBeNull();
  });

  it("watches the lifecycle with reads that never resume a Box", async () => {
    await openThread(companionIn("provisioning"));

    await wait(20);

    expect(api.runtimeReads.length).toBeGreaterThan(1);
    expect(api.runtimeReads.filter((url) => url.includes("live=true"))).toHaveLength(0);
  });

  it("keeps the Box online when an overtaken read finally answers", async () => {
    // Watching a lifecycle closely means these reads overlap, so one that answers late is carrying a
    // state the Companion has already left. It must not put Starting back on a chip that has arrived.
    api = controlPlane({ holdFirstRead: true });
    vi.stubGlobal("fetch", api.fetchMock);
    const container = await openThread(companionIn("provisioning"));

    await wait(4);
    api.boxCameUp();
    await wait(8);
    expect(chip(container)).toContain("Box · online");

    await act(async () => {
      api.releaseFirstRead();
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(chip(container)).toContain("Box · online");
  });

  it("stops watching once the lifecycle settles", async () => {
    await openThread(companionIn("provisioning"));
    api.boxCameUp();
    await wait(10);
    const watched = api.runtimeReads.length;
    expect(watched).toBeGreaterThan(1);

    await wait(30);

    // An online Companion is observed on its own, far slower cadence, so half a minute of it cannot
    // amount to what watching a pending lifecycle for ten seconds did.
    expect(api.runtimeReads.length - watched).toBeLessThan(watched);
  });
});
