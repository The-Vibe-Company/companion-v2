/* oxlint-disable anti-slop/no-module-mocking -- This contract test observes the request passed to the shared HTTP boundary. */

import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock("./apiClient", () => api);

const {
  listCompanionRoutineRuns,
  readCompanionRoutineRun,
} = await import("./companions");

describe("routine history web client", () => {
  beforeEach(() => vi.clearAllMocks());

  it("keeps run-list pagination bounded and organization-scoped", async () => {
    api.apiFetch.mockResolvedValue({ runs: [], next_cursor: null });

    await listCompanionRoutineRuns(
      "org-1",
      "companion id",
      "routine id",
      { limit: 20, cursor: "cursor-id" },
    );

    expect(api.apiFetch).toHaveBeenCalledWith(
      "/v1/companions/companion%20id/routines/routine%20id/runs?limit=20&cursor=cursor-id",
      { headers: { "x-companion-org": "org-1" } },
    );
  });

  it("returns one transcript page and preserves an ordinal-zero cursor", async () => {
    const run = { run_id: "run-1", internal_entries: [], next_entry_cursor: null };
    api.apiFetch.mockResolvedValue({ run });

    await expect(readCompanionRoutineRun(
      "org-1",
      "companion id",
      "run id",
      { entryLimit: 50, entryCursor: 0 },
    )).resolves.toBe(run);

    expect(api.apiFetch).toHaveBeenCalledWith(
      "/v1/companions/companion%20id/routine-runs/run%20id?entry_limit=50&entry_cursor=0",
      { headers: { "x-companion-org": "org-1" } },
    );
  });
});
