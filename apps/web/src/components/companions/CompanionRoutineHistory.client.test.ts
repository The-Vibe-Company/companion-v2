// @vitest-environment happy-dom
/* oxlint-disable anti-slop/no-module-mocking -- The rendered drawer test replaces only its bounded HTTP client. */

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type {
  CompanionLatestOperation,
  CompanionOperation,
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
const secondRunId = "44444444-4444-4444-8444-444444444444";
const roots: Root[] = [];

function retryOperation(
  status: CompanionOperation["status"] = "pending",
  error: CompanionOperation["error"] = null,
): CompanionOperation {
  return {
    id: "55555555-5555-4555-8555-555555555555",
    companion_id: companionId,
    request_id: null,
    source_turn_id: runId,
    kind: "restart_pi",
    trigger: "user",
    status,
    queue_sequence: 1,
    checkpoint: status === "succeeded" ? "pi_ready" : "pending",
    attempt_count: status === "pending" ? 0 : 1,
    error,
    created_at: "2026-08-27T09:10:01.000Z",
    started_at: status === "pending" ? null : "2026-08-27T09:10:02.000Z",
    settled_at: ["pending", "running"].includes(status) ? null : "2026-08-27T09:10:03.000Z",
  };
}

function latestRetryOperation(
  status: CompanionLatestOperation["status"],
  error: CompanionLatestOperation["error"] = null,
): CompanionLatestOperation {
  return {
    id: "55555555-5555-4555-8555-555555555555",
    source_turn_id: runId,
    kind: "restart_pi",
    status,
    error,
  };
}

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

function interruptedDetail(): CompanionRoutineRunDetail {
  return {
    ...firstPage,
    status: "interrupted",
    outcome: "error",
    surface_mode: null,
    main_entry_event_id: null,
    settled_at: "2026-08-27T09:10:00.000Z",
    error: {
      code: "turn_stalled",
      message: "The Companion stopped making progress.",
      action: "retry",
    },
    next_entry_cursor: null,
  };
}

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

const alternateSummary: CompanionRoutineRunSummary = {
  ...summary,
  run_id: secondRunId,
  created_at: "2026-08-27T10:00:00.000Z",
  started_at: "2026-08-27T10:00:01.000Z",
  settled_at: "2026-08-27T10:00:05.000Z",
};

const alternateDetail: CompanionRoutineRunDetail = {
  ...alternateSummary,
  internal_entries: [{
    ...firstPage.internal_entries[0]!,
    event_id: "routine:assistant:alternate",
    content: "The later run completed cleanly.",
    created_at: "2026-08-27T10:00:02.000Z",
  }],
  next_entry_cursor: null,
};

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

interface RecoveryOptions {
  canAct?: boolean;
  latestOperation?: CompanionLatestOperation | null;
  onRetry?: (runId: string, retryId: string) => Promise<CompanionOperation>;
  onCancel?: (runId: string) => Promise<void>;
}

async function mount(run: string | null = null, recovery: RecoveryOptions = {}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  let currentRecovery = recovery;
  const render = async () => {
    await act(async () => root.render(React.createElement(CompanionRoutineHistory, {
      orgId: "org-1",
      companionId,
      target: { routineId, runId: run, name: "Morning brief" },
      memberTimezone: "UTC",
      canAct: currentRecovery.canAct ?? true,
      latestOperation: currentRecovery.latestOperation ?? null,
      onRetry: currentRecovery.onRetry ?? (async () => retryOperation()),
      onCancel: currentRecovery.onCancel ?? (async () => undefined),
      onClose: () => undefined,
    })));
  };
  await render();
  await flush();
  return {
    container,
    rerender: async (next: Partial<RecoveryOptions>) => {
      currentRecovery = { ...currentRecovery, ...next };
      await render();
      await flush();
    },
  };
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
    const { container } = await mount();

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
    const { container } = await mount(runId);

    expect(container.textContent).toContain("Routine run");
    expect(container.textContent).toContain("Checked the overnight deployment.");
    expect(container.querySelector("button[aria-label='Back to Morning brief runs']")).not.toBeNull();
  });

  it("ignores stale detail failures after selecting a different run", async () => {
    let rejectFirst!: (cause: Error) => void;
    let resolveSecond!: (detail: CompanionRoutineRunDetail) => void;
    const firstRequest = new Promise<CompanionRoutineRunDetail>((_resolve, reject) => {
      rejectFirst = reject;
    });
    const secondRequest = new Promise<CompanionRoutineRunDetail>((resolve) => {
      resolveSecond = resolve;
    });
    historyApi.listCompanionRoutineRuns.mockResolvedValue({
      runs: [summary, alternateSummary],
      next_cursor: null,
    });
    historyApi.readCompanionRoutineRun.mockReset();
    historyApi.readCompanionRoutineRun.mockImplementation(
      (_orgId: string, _companionId: string, requestedRunId: string) => (
        requestedRunId === runId ? firstRequest : secondRequest
      ),
    );

    const { container } = await mount();
    const runButtons = () => [
      ...container.querySelectorAll<HTMLButtonElement>(".routine-history__run-button"),
    ];
    await act(async () => runButtons()[0]?.click());
    await flush();
    const back = container.querySelector<HTMLButtonElement>(
      "button[aria-label='Back to Morning brief runs']",
    );
    await act(async () => back?.click());
    await flush();
    await act(async () => runButtons()[1]?.click());

    await act(async () => resolveSecond(alternateDetail));
    await flush();
    expect(container.textContent).toContain("The later run completed cleanly.");

    await act(async () => rejectFirst(new Error("stale first-run failure")));
    await flush();
    expect(container.textContent).not.toContain("stale first-run failure");
    expect(container.textContent).toContain("The later run completed cleanly.");
  });

  it("lets a runner resolve an interrupted routine without touching the main Pi", async () => {
    const interrupted = interruptedDetail();
    const onRetry = vi.fn(async (): Promise<CompanionOperation> => retryOperation());
    historyApi.readCompanionRoutineRun.mockReset().mockResolvedValue(interrupted);

    const { container } = await mount(runId, { onRetry });
    expect(container.textContent).toContain("Cancel releases blocked runtime work.");

    await act(async () => buttonNamed(container, "Retry run").click());

    expect(onRetry).toHaveBeenCalledWith(runId, expect.stringMatching(/^[0-9a-f-]{36}$/));
    expect(container.textContent).toContain("Retry accepted. The isolated routine session");
    expect(container.textContent).not.toContain("Retry run");
    expect(buttonNamed(container, "Cancel run").disabled).toBe(false);
  });

  it("restores retry and shows the durable failure when the isolated Pi recycle fails", async () => {
    historyApi.readCompanionRoutineRun.mockReset().mockResolvedValue(interruptedDetail());
    const { container, rerender } = await mount(runId);

    await act(async () => buttonNamed(container, "Retry run").click());
    expect(container.textContent).toContain("Retry accepted.");

    await rerender({
      latestOperation: latestRetryOperation("failed", {
        code: "runtime_execution_failed",
        message: "The isolated routine session could not restart.",
        action: "retry",
      }),
    });

    expect(container.textContent).toContain("The isolated routine session could not restart.");
    expect(buttonNamed(container, "Retry run").disabled).toBe(false);
    expect(buttonNamed(container, "Cancel run").disabled).toBe(false);
  });

  it("refreshes a recovered run and removes stale cancellation controls", async () => {
    const interrupted = interruptedDetail();
    historyApi.readCompanionRoutineRun.mockReset().mockResolvedValue(interrupted);
    const { container, rerender } = await mount(runId);

    await act(async () => buttonNamed(container, "Retry run").click());
    historyApi.readCompanionRoutineRun.mockResolvedValueOnce({
      ...interrupted,
      status: "queued",
      outcome: "pending",
      started_at: null,
      settled_at: null,
      error: null,
    });
    await rerender({ latestOperation: latestRetryOperation("succeeded") });
    await flush();

    expect(container.textContent).toContain("Queued");
    expect(container.textContent).not.toContain("Retry run");
    expect(container.textContent).not.toContain("Cancel run");
  });

  it("explains the recovery boundary without exposing mutations to a Viewer", async () => {
    const interrupted = interruptedDetail();
    historyApi.readCompanionRoutineRun.mockReset().mockResolvedValue(interrupted);

    const { container } = await mount(runId, { canAct: false });

    expect(container.textContent).toContain("An Owner or Editor must retry or cancel this run.");
    expect(container.textContent).not.toContain("Retry run");
    expect(container.textContent).not.toContain("Cancel run");
  });
});
