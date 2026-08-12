import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_CUTOVER_OPTIONS,
  SKILLS_HUB_RETIRED_TABLES,
  isPreflightSatisfied,
  parseCutoverArgs,
} from "./cutover";

describe("parseCutoverArgs", () => {
  it("defaults to a run that cannot discard provider-backed rows", () => {
    expect(parseCutoverArgs(["purge"])).toEqual({ command: "purge", options: DEFAULT_CUTOVER_OPTIONS });
    expect(DEFAULT_CUTOVER_OPTIONS.confirmProviderCleanup).toBe(false);
    expect(DEFAULT_CUTOVER_OPTIONS.skipObjectDelete).toBe(false);
    expect(DEFAULT_CUTOVER_OPTIONS.dryRun).toBe(false);
  });

  it("accepts the documented flags", () => {
    expect(
      parseCutoverArgs(["purge", "--confirm-provider-cleanup", "--skip-object-delete", "--dry-run"]).options,
    ).toEqual({ ...DEFAULT_CUTOVER_OPTIONS, confirmProviderCleanup: true, skipObjectDelete: true, dryRun: true });
  });

  it.each([[[]], [["drain"]], [["purge", "--force"]]])("rejects %s instead of guessing", (argv) => {
    expect(() => parseCutoverArgs(argv)).toThrow();
  });
});

describe("isPreflightSatisfied", () => {
  it("requires all four obligations to be zero", () => {
    const zero = { pendingStorage: 0, pendingProjects: 0, pendingSandboxes: 0, activeUsage: 0 };
    expect(isPreflightSatisfied(zero)).toBe(true);
    expect(isPreflightSatisfied({ ...zero, pendingStorage: 1 })).toBe(false);
    expect(isPreflightSatisfied({ ...zero, pendingProjects: 1 })).toBe(false);
    expect(isPreflightSatisfied({ ...zero, pendingSandboxes: 1 })).toBe(false);
    expect(isPreflightSatisfied({ ...zero, activeUsage: 1 })).toBe(false);
  });
});

describe("retired runtime tables", () => {
  it("covers exactly the tables migration 0063 drops", async () => {
    const migration = await readFile(
      fileURLToPath(new URL("../../../packages/db/drizzle/0063_skills_hub_only.sql", import.meta.url)),
      "utf8",
    );
    const dropped = [...migration.matchAll(/^DROP TABLE IF EXISTS public\.([a-z_]+) CASCADE/gm)].map(
      (match) => match[1],
    );

    expect(dropped.length).toBeGreaterThan(0);
    expect([...SKILLS_HUB_RETIRED_TABLES].sort()).toEqual([...dropped].sort());
  });
});
