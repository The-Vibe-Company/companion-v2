import { beforeEach, describe, expect, it, vi } from "vitest";
import { executeSkillDatabase, querySkillDatabase } from "./skillDatabaseQueries";

const api = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock("./apiClient", () => api);

describe("skill database queries", () => {
  beforeEach(() => {
    api.apiFetch.mockReset().mockResolvedValue({});
  });

  it("preserves every explicitly supplied realm selector for server validation", async () => {
    await querySkillDatabase("stateful-skill", { audience: "personal", realmId: "" }, "SELECT 1");
    await executeSkillDatabase("stateful-skill", { audience: "personal", realmId: "" }, "DELETE FROM rows");

    for (const [, options] of api.apiFetch.mock.calls) {
      expect(JSON.parse((options as RequestInit).body as string)).toMatchObject({ realm_id: "" });
    }
  });
});
