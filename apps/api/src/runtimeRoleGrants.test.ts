import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { resolveRuntimeRoleGrantsFile } from "./migrate";

describe("Skills Hub runtime-role grants", () => {
  it("grants skill maintenance capabilities without removed execution capabilities", async () => {
    const sql = await readFile(await resolveRuntimeRoleGrantsFile(), "utf8");
    expect(sql).toContain("companion_claim_skill_database_object_deletions");
    expect(sql).toContain("companion_claim_github_sync_destinations");
    expect(sql).toContain("companion_secret_usage_count");
    expect(sql).not.toMatch(/skill_run|project_workspace|project_worker|sandbox_usage|model_provider/i);
  });
});
