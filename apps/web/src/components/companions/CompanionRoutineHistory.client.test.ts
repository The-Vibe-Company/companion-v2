// @vitest-environment happy-dom
/* oxlint-disable anti-slop/no-module-mocking -- The rendered drawer test replaces only its bounded HTTP client. */

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type {
  CompanionRoutineRunDetail,
  CompanionRoutineRunSummary,
} from "@companion/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const historyApi = vi.hoisted(() => ({
  listCompanionRoutineRuns: vi.fn(),
  readCompanionRoutineRun: vi.fn(),
}));

vi.mock("@/lib/companions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/companions")>()),
  ...historyApi,
}));

const { CompanionRoutineHistory } = await import("./CompanionRoutineHistory");

// SAFETY: React's test harness reads this documented global flag; the test owns its boolean value.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const companionId = "11111111-1111-4111-8111-111111111111";
const routineId = "22222222-2222-4222-8222-222222222222";
const runId = "33333333-3333-4333-8333-333333333333";
const roots: Root[] = [];

const summary: CompanionRoutineRunSummary = {
  run_id: runId,
  companion_id: companionId,
  routine: { id: routineId, name: "Morning brief" },
  status: "succeeded",
  outcome: "surfaced",
  surface_mode: "notify",
  main_entry_event_id: "routine-return:1",
  relay_turn_id: null,
  created_at: "2026-08-27T09:00:00.000Z",
  started_at: "2026-08-27T09:00:01.000Z",
  settled_at: "2026-08-27T09:00:05.000Z",
  error: null,
};

const firstPage: CompanionRoutineRunDetail = {
  ...summary,
  internal_entries: [{
    event_id: "routine:assistant:1",
    ordinal: 0,
    role: "assistant",
    content: "Checked the overnight deployment.",
    reasoning: "Compared the release with the incident log.",
    tool: null,
    decision: null,
    created_at: "2026-08-27T09:00:02.000Z",
  }],
  next_entry_cursor: 1,
};

const secondPage: CompanionRoutineRunDetail = {
  ...summary,
  internal_entries: [{
    event_id: "routine:tool:2",
    ordinal: 1,
    role: "tool",
    content: "",
    reasoning: null,
    tool: {
      call_id: "tool-1",
      kind: "shell",
      name: "bash",
      title: "pnpm test",
      status: "ok",
      detail: "42 tests passed",
      screenshot: null,
    },
    decision: null,
    created_at: "2026-08-27T09:00:04.000Z",
  }],
  next_entry_cursor: null,
};

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function mount(run: string | null = null) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(React.createElement(CompanionRoutineHistory, {
      orgId: "org-1",
      companionId,
      target: { routineId, runId: run, name: "Morning brief" },
      memberTimezone: "UTC",
      onClose: () => undefined,
    }));
  });
  await flush();
  return container;
}

function buttonNamed(container: HTMLElement, name: string): HTMLButtonElement {
  const match = [...container.querySelectorAll("button")]
    .find((button) => button.textContent?.trim() === name);
  if (!match) throw new Error(`Button not found: ${name}`);
  return match;
}

describe("Companion routine history", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    historyApi.listCompanionRoutineRuns.mockResolvedValue({
      runs: [summary],
      next_cursor: null,
    });
    historyApi.readCompanionRoutineRun
      .mockResolvedValueOnce(firstPage)
      .mockResolvedValueOnce(secondPage);
  });

  afterEach(() => {
    act(() => roots.splice(0).forEach((root) => root.unmount()));
    document.body.innerHTML = "";
  });

  it("moves from newest-first run history into the private paginated transcript", async () => {
    const container = await mount();

    expect(container.textContent).toContain("Notified in main chat");
    expect(container.textContent).toContain("Completed");
    expect(historyApi.listCompanionRoutineRuns).toHaveBeenCalledWith(
      "org-1",
      companionId,
      routineId,
      { limit: 20, cursor: undefined },
    );

    const runButton = container.querySelector<HTMLButtonElement>(".routine-history__run-button");
    await act(async () => runButton?.click());
    await flush();

    expect(container.textContent).toContain("Internal transcript");
    expect(container.textContent).toContain("Checked the overnight deployment.");
    expect(container.textContent).toContain("Reasoning");
    expect(container.textContent).not.toContain("42 tests passed");

    await act(async () => buttonNamed(container, "Load more transcript").click());
    await flush();

    expect(historyApi.readCompanionRoutineRun).toHaveBeenLastCalledWith(
      "org-1",
      companionId,
      runId,
      { entryLimit: 50, entryCursor: 1 },
    );
    expect(container.textContent).toContain("pnpm test");
    expect(container.textContent).toContain("Tool details");
  });

  it("opens a marker-linked run directly and keeps a path back to the routine list", async () => {
    const container = await mount(runId);

    expect(container.textContent).toContain("Routine run");
    expect(container.textContent).toContain("Checked the overnight deployment.");
    expect(container.querySelector("button[aria-label='Back to Morning brief runs']")).not.toBeNull();
  });
});
