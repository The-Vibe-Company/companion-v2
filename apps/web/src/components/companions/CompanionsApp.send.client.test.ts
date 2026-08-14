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
 * One Enter is one turn, measured where it can be counted: the requests the open thread makes. The
 * regression this guards is a send that reached the control plane twice — one Enter that persisted the
 * message and its reply twice over, and survived a reload — so the promise under test is that pressing
 * Enter once posts once, names that message once, and that the live poll that follows never sends
 * again.
 *
 * It runs at this level because no lower one can see it: the composer, the optimistic message, the
 * request queue, and the two-second sync poll all take part in a send, and the count that matters is
 * of `POST /v1/companions/:id/messages` on the wire.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {}, refresh: () => {} }) }));

const companionId = "11111111-1111-4111-8111-111111111111";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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

const companion: Companion = {
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
};

/**
 * A control plane with one durable transcript and a Pi that answers each prompt it accepted. It
 * stores a message under the event id the sender named and refuses a second copy of it, the way the
 * transcript's primary key does, so a duplicated request shows up as a duplicated request rather than
 * as a second turn.
 */
function controlPlane(
  options: { holdSend?: boolean; dropFirstSend?: boolean; companion?: Companion } = {},
) {
  const runtime = options.companion ?? companion;
  const entries: CompanionTranscriptEntry[] = [];
  const sends: { content: string; clientMessageId: string | undefined }[] = [];
  const requests: string[] = [];
  let ordinal = 0;
  let delivered = -1;
  let owed = 0;
  let dropped = 0;
  let release = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });

  const json = (body: unknown) => new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

  const thread = (): Thread => ({
    companion_id: companionId,
    viewer_id: "user-1",
    access: "owner",
    read_only: false,
    can_send: true,
    entries: entries.map((entry) => ({ ...entry })),
    pending_count: entries.filter((entry) => entry.role === "user" && entry.ordinal > delivered).length,
    last_message_at: entries.at(-1)?.created_at ?? null,
  });

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    requests.push(`${method} ${url}`);
    if (method === "POST" && url.endsWith("/messages")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        content: string;
        client_message_id?: string;
      };
      sends.push({ content: body.content, clientMessageId: body.client_message_id });
      const eventId = `msg:${body.client_message_id ?? String(sends.length)}`;
      if (!entries.some((entry) => entry.event_id === eventId)) {
        entries.push({
          event_id: eventId,
          ordinal: ordinal++,
          role: "user",
          content: body.content,
          author_id: "user-1",
          author_name: null,
          tool: null,
    decision: null,
          created_at: new Date().toISOString(),
        });
        delivered = ordinal - 1;
        owed += 1;
      }
      // THE-341: the turn is durable the moment it is stored, before the wake the request then waits
      // on. A proxy that gives up mid-wake returns 500 over an already-persisted turn; model that by
      // answering the first send with 500 after it has stored the message.
      if (options.dropFirstSend && dropped < 1) {
        dropped += 1;
        return new Response(JSON.stringify({ error: "Request failed" }), {
          status: 500,
          headers: { "content-type": "application/json" },
        });
      }
      if (options.holdSend) await held;
      return json({ thread: thread(), delivery: "delivered" });
    }
    if (method === "POST" && url.endsWith("/thread/sync")) {
      while (owed > 0) {
        owed -= 1;
        entries.push({
          event_id: `pi:${entries.length}`,
          ordinal: ordinal++,
          role: "assistant",
          content: "It's 2026.",
          author_id: null,
          author_name: null,
          tool: null,
    decision: null,
          created_at: new Date().toISOString(),
        });
      }
      return json({ thread: thread(), source: "box" });
    }
    if (url.includes("/thread")) return json({ thread: thread() });
    if (url.includes("/runtime")) return json({ companion: runtime, source: "control_plane" });
    return json({});
  });

  return {
    fetchMock,
    entries,
    sends,
    /** Answer the send this control plane is holding open. */
    releaseSend: () => release(),
    posts: () => requests.filter((request) => request.endsWith("/messages")).length,
  };
}

const roots: Root[] = [];

async function openThread(who: Companion = companion) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(React.createElement(CompanionsApp, {
      orgs: [org],
      currentOrg: org,
      navigation,
      initialCompanions: [who],
      initialProviders: providers,
      initialPlugins: [],
      initialCompanionId: companionId,
    }));
  });
  return container;
}

function type(container: HTMLElement, value: string) {
  const composer = container.querySelector("textarea") as HTMLTextAreaElement;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
  act(() => {
    setter?.call(composer, value);
    composer.dispatchEvent(new Event("input", { bubbles: true }));
  });
  return composer;
}

/** Enter in the composer, which is what the primitives turn into one submit. */
async function pressEnter(container: HTMLElement) {
  const composer = container.querySelector("textarea") as HTMLTextAreaElement;
  await act(async () => {
    composer.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
}

/** Let the live thread poll tick, the way an open thread does every couple of seconds. */
async function poll(times: number) {
  for (let index = 0; index < times; index += 1) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_100);
    });
  }
}

describe("CompanionsApp send", () => {
  let api: ReturnType<typeof controlPlane>;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    act(() => roots.splice(0).forEach((root) => root.unmount()));
    document.body.innerHTML = "";
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  describe("with a control plane that answers at once", () => {
    beforeEach(() => {
      api = controlPlane();
      vi.stubGlobal("fetch", api.fetchMock);
    });

    it("persists one turn and one reply for one Enter", async () => {
      const container = await openThread();
      const composer = type(container, "What year is it?");

      await pressEnter(container);
      await poll(3);

      expect(api.posts()).toBe(1);
      expect(api.entries.map((entry) => `${entry.role}: ${entry.content}`)).toEqual([
        "user: What year is it?",
        "assistant: It's 2026.",
      ]);
      expect(composer.value).toBe("");
    });

    it("leaves an online thread's footer and chip exactly where they were", async () => {
      const container = await openThread();
      type(container, "What year is it?");

      await pressEnter(container);
      await poll(1);

      expect(container.querySelector(".chat-hint")?.textContent)
        .toBe("Enter sends. Shift + Enter starts a new line.");
      expect(container.querySelector(".chat-box")?.textContent).toContain("Box · online");
    });

    it("names the message it sends, so a replayed request cannot become a second turn", async () => {
      const container = await openThread();
      type(container, "What year is it?");

      await pressEnter(container);

      expect(api.sends).toHaveLength(1);
      expect(api.sends[0]?.clientMessageId).toMatch(UUID);
    });
  });

  describe("with a control plane that is slow to answer", () => {
    beforeEach(() => {
      api = controlPlane({ holdSend: true });
      vi.stubGlobal("fetch", api.fetchMock);
    });

    it("still sends once when the poll ticks while the send is in flight", async () => {
      const container = await openThread();
      const composer = type(container, "What year is it?");

      await act(async () => {
        composer.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
        // Several poll ticks pass while the send is unanswered; none of them may send again, and the
        // message stays on screen once because it already carries the id it will be stored under.
        await vi.advanceTimersByTimeAsync(6_300);
      });

      expect(api.posts()).toBe(1);
      expect(container.querySelectorAll(".chat-turn--said")).toHaveLength(1);

      await act(async () => {
        api.releaseSend();
        await vi.advanceTimersByTimeAsync(0);
      });
      await poll(1);

      expect(api.posts()).toBe(1);
      expect(api.entries.filter((entry) => entry.role === "user")).toHaveLength(1);
      expect(composer.value).toBe("");
    });
  });

  describe("when a send that woke an asleep Companion loses its request after persisting", () => {
    const asleep: Companion = {
      ...companion,
      runtime: {
        ...companion.runtime,
        state: "stopped",
        daemon_state: "stopped",
        box_id: null,
        desktop_available: false,
      },
    };

    beforeEach(() => {
      api = controlPlane({ dropFirstSend: true, companion: asleep });
      vi.stubGlobal("fetch", api.fetchMock);
    });

    it("resends the same turn, so the composer clears with no toast and one message is stored", async () => {
      const container = await openThread(asleep);
      const composer = type(container, "What year is it?");

      // The wake outlives the proxy and the request comes back 500 over an already-durable turn. The
      // composer keeps the draft so nothing typed is lost.
      await pressEnter(container);
      expect(composer.value).toBe("What year is it?");

      // Pressing Enter on the restored draft must name the turn already stored, not a second one.
      await pressEnter(container);
      await poll(1);

      expect(api.entries.filter((entry) => entry.role === "user")).toHaveLength(1);
      expect(api.sends).toHaveLength(2);
      expect(api.sends[0]?.clientMessageId).toBe(api.sends[1]?.clientMessageId);
      expect(composer.value).toBe("");
      // The transient 500 cleared itself, and the successful resend leaves no error behind.
      expect(container.querySelector(".companions-error")).toBeNull();
    });
  });
});
