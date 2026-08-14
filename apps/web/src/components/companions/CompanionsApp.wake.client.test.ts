// @vitest-environment happy-dom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type {
  Companion,
  CompanionProvidersResponse,
  CompanionThread as Thread,
  CompanionTranscriptEntry,
} from "@companion/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanionsApp, type CompanionNavigation } from "./CompanionsApp";

/**
 * A send that wakes an asleep Companion leaves the whole thread on the woken state, not just the
 * status chip. The regression this guards is a thread that kept the runtime it was opened with: the
 * chip said the Box was online while the composer footer still offered "Wake Luna to deliver", the
 * live sync that projects Pi's reply never started, and only a reload agreed with itself.
 *
 * It runs at this level because the projection is what is under test: the send request, the runtime
 * read the chip uses, and the poll cadence that follows all live in this component, and no lower
 * level can see that the footer and the chip read one state.
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

const asleep: Companion = {
  id: companionId,
  name: "Luna",
  persona: "Content marketing assistant",
  model_id: "claude-opus-4-8",
  owner_id: "user-1",
  access: "owner",
  runtime: {
    state: "stopped",
    daemon_state: "stopped",
    box_id: null,
    provider_ids: ["anthropic"],
    provider_credential_generation: null,
    disk_layout_version: 2,
    desktop_available: false,
    last_error: null,
    last_observed_at: null,
    last_started_at: null,
    last_stopped_at: null,
  },
  created_at: "2026-08-12T12:00:00.000Z",
  updated_at: "2026-08-12T12:00:00.000Z",
};

/**
 * A control plane that wakes on send, the way THE-335 does: the message is persisted first, the Box
 * and Pi are started, and the runtime projection this Companion reads is running from then on.
 * `piAcceptsOnWake: false` reproduces the Box that came up while Pi refused the first prompt, so the
 * message stays durable and pending until the next sync hands it over.
 */
function controlPlane(options: { piAcceptsOnWake: boolean }) {
  const entries: CompanionTranscriptEntry[] = [];
  const requests: string[] = [];
  const runtime = { ...asleep.runtime };
  let ordinal = 0;
  let delivered = -1;
  let owed = 0;

  const json = (body: unknown) => new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

  const companion = (): Companion => ({ ...asleep, runtime: { ...runtime } });

  const thread = (): Thread => ({
    companion_id: companionId,
    viewer_id: "user-1",
    access: "owner",
    read_only: false,
    can_send: true,
    entries: entries.map((entry) => ({ ...entry })),
    pending_count: entries
      .filter((entry) => entry.role === "user" && entry.ordinal > delivered).length,
    last_message_at: entries.at(-1)?.created_at ?? null,
  });

  const wake = () => {
    runtime.state = "running";
    runtime.daemon_state = "running";
    runtime.box_id = "bx_23456789";
    runtime.desktop_available = true;
    runtime.last_started_at = new Date().toISOString();
  };

  /** Hand Pi everything it has not received, the way one sync does. */
  const deliverPending = () => {
    const pending = entries.filter((entry) => entry.role === "user" && entry.ordinal > delivered);
    if (!pending.length) return;
    delivered = pending.at(-1)!.ordinal;
    owed += pending.length;
  };

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    requests.push(`${method} ${url}`);
    if (method === "POST" && url.endsWith("/messages")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        content: string;
        client_message_id?: string;
      };
      const eventId = `msg:${body.client_message_id ?? String(entries.length)}`;
      if (!entries.some((entry) => entry.event_id === eventId)) {
        entries.push({
          event_id: eventId,
          ordinal: ordinal++,
          role: "user",
          content: body.content,
          author_id: "user-1",
          author_name: null,
          created_at: new Date().toISOString(),
        });
      }
      wake();
      if (options.piAcceptsOnWake) deliverPending();
      return json({
        thread: thread(),
        delivery: options.piAcceptsOnWake ? "delivered" : "pending",
      });
    }
    if (method === "POST" && url.endsWith("/thread/sync")) {
      deliverPending();
      while (owed > 0) {
        owed -= 1;
        entries.push({
          event_id: `pi:${entries.length}`,
          ordinal: ordinal++,
          role: "assistant",
          content: "On it.",
          author_id: null,
          author_name: null,
          created_at: new Date().toISOString(),
        });
      }
      return json({ thread: thread(), source: "box" });
    }
    if (url.includes("/runtime")) {
      return json({ companion: companion(), source: url.includes("live=true") ? "box" : "control_plane" });
    }
    if (url.includes("/thread")) return json({ thread: thread() });
    return json({});
  });

  return {
    fetchMock,
    entries,
    runtimeReads: () => requests.filter((request) => request.includes("/runtime")).length,
    posts: () => requests.filter((request) => request.endsWith("/messages")).length,
  };
}

const roots: Root[] = [];

async function openThread() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(React.createElement(CompanionsApp, {
      orgs: [org],
      currentOrg: org,
      navigation,
      initialCompanions: [asleep],
      initialProviders: providers,
      initialPlugins: [],
      initialCompanionId: companionId,
    }));
  });
  return container;
}

async function send(container: HTMLElement, value: string) {
  const composer = container.querySelector("textarea") as HTMLTextAreaElement;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
  await act(async () => {
    setter?.call(composer, value);
    composer.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {
    composer.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
}

/** Let the open thread poll, whichever cadence it is on. */
async function poll(times: number) {
  for (let index = 0; index < times; index += 1) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8_100);
    });
  }
}

const footer = (container: HTMLElement) =>
  container.querySelector(".chat-hint")?.textContent ?? "";
const chip = (container: HTMLElement) => container.querySelector(".chat-box")?.textContent ?? "";
const wakeControls = (container: HTMLElement) =>
  [...container.querySelectorAll("button")].filter((button) => button.textContent === "Wake");

describe("CompanionsApp wake on send", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    act(() => roots.splice(0).forEach((root) => root.unmount()));
    document.body.innerHTML = "";
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("moves the footer off a wake the send already performed", async () => {
    // The Box comes up but Pi refuses the first prompt, so the message stays pending: the footer has
    // something to say about it, and what it must not say is that this Companion needs waking.
    const api = controlPlane({ piAcceptsOnWake: false });
    vi.stubGlobal("fetch", api.fetchMock);
    const container = await openThread();

    expect(footer(container)).toContain("Enter sends");
    expect(chip(container)).toContain("Box · asleep");

    await send(container, "Draft the launch note");

    expect(footer(container)).not.toContain("Wake Luna to deliver.");
    expect(footer(container)).toContain("1 message waiting for a reply.");
    expect(chip(container)).toContain("Box · online");
    expect(api.runtimeReads()).toBeGreaterThan(0);

    // The woken thread now syncs, so the message Pi refused is delivered and answered without anyone
    // reloading the page.
    await poll(1);

    expect(api.posts()).toBe(1);
    expect(api.entries.map((entry) => entry.role)).toEqual(["user", "assistant"]);
    expect(container.textContent).toContain("On it.");
    expect(footer(container)).toContain("Enter sends");
  });

  it("retires the wake control the send made unnecessary without offering a second one", async () => {
    const api = controlPlane({ piAcceptsOnWake: true });
    vi.stubGlobal("fetch", api.fetchMock);
    const container = await openThread();

    expect(wakeControls(container)).toHaveLength(1);

    await send(container, "Draft the launch note");

    expect(wakeControls(container)).toHaveLength(0);
    expect(chip(container)).toContain("Box · online");
    expect(footer(container)).toContain("Enter sends");

    // A woken thread pulls Pi, so the reply arrives on the live cadence instead of on a reload.
    await poll(1);

    expect(container.textContent).toContain("On it.");
  });
});
