// @vitest-environment happy-dom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { CompanionTriggerRunDetail, CompanionTriggerRunSummary } from "@companion/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CompanionTriggerHistory } from "./CompanionTriggerHistory";
import type { CompanionTriggerHistoryApi } from "./CompanionTriggerHistoryTypes";

Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });

const run: CompanionTriggerRunSummary = {
  run_id: "22222222-2222-4222-8222-222222222222",
  companion_id: "11111111-1111-4111-8111-111111111111",
  trigger: { id: "33333333-3333-4333-8333-333333333333", name: "CI failed" },
  status: "succeeded",
  mode: "notify",
  outcome: "surfaced",
  surface_mode: "notify",
  main_entry_event_id: "event-1",
  relay_turn_id: null,
  created_at: "2026-08-30T09:00:00.000Z",
  started_at: "2026-08-30T09:00:01.000Z",
  settled_at: "2026-08-30T09:00:02.000Z",
  error: null,
};

const detail: CompanionTriggerRunDetail = {
  ...run,
  internal_entries: [{
    event_id: "payload-1",
    ordinal: 0,
    role: "user",
    content: "{\"ref\":\"refs/heads/main\",\"conclusion\":\"failure\"}",
    reasoning: null,
    tool: null,
    decision: null,
    created_at: "2026-08-30T09:00:00.000Z",
  }],
  next_entry_cursor: null,
};

const roots: Root[] = [];

afterEach(() => {
  act(() => roots.splice(0).forEach((root) => root.unmount()));
  document.body.innerHTML = "";
});

describe("Companion trigger history", () => {
  it("lists fires and opens the bounded received payload", async () => {
    const api = {
      listCompanionTriggerRuns: vi.fn(async () => ({ runs: [run], next_cursor: null })),
      readCompanionTriggerRun: vi.fn(async () => detail),
    } satisfies CompanionTriggerHistoryApi;
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    roots.push(root);

    await act(async () => {
      root.render(React.createElement(CompanionTriggerHistory, {
        orgId: "org-1",
        companionId: run.companion_id,
        target: { triggerId: run.trigger.id, runId: null, name: run.trigger.name },
        memberTimezone: "UTC",
        api,
        onClose: () => undefined,
      }));
    });

    expect(container.textContent).toContain("Notified in main chat");
    const row = [...container.querySelectorAll("button")]
      .find((button) => button.textContent?.includes("Notified in main chat"));
    if (!row) throw new Error("Missing trigger run row");
    await act(async () => {
      row.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    expect(api.readCompanionTriggerRun).toHaveBeenCalledWith(
      "org-1",
      run.companion_id,
      run.run_id,
      { entryLimit: 50, entryCursor: undefined },
    );
    expect(container.textContent).toContain("Event payload");
    expect(container.textContent).toContain("refs/heads/main");
  });
});
