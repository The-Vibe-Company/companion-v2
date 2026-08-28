import { describe, expect, it } from "vitest";

import {
  BOX_LAB_CLI_COMMANDS,
  BOX_LAB_CLI_USAGE,
  resolveLocalSmokeSelection,
} from "../src/cliOptions";

describe("Box Lab local CLI policy", () => {
  it("exposes only developer commands", () => {
    expect(BOX_LAB_CLI_COMMANDS).toEqual(["dev", "doctor", "smoke", "shell", "reset"]);
    expect(BOX_LAB_CLI_USAGE).not.toContain("ci");
  });

  it("makes the deterministic lifecycle smoke the comprehensive pinned test", () => {
    expect(resolveLocalSmokeSelection([])).toEqual({
      profile: "deterministic",
      scenario: "lifecycle",
      failureMatrix: true,
      forcePinnedInstall: true,
    });
  });

  it("keeps bundle explicit and real-provider outside the failure matrix", () => {
    expect(resolveLocalSmokeSelection(["--scenario", "bundle"])).toMatchObject({
      profile: "deterministic",
      scenario: "bundle",
      failureMatrix: false,
      forcePinnedInstall: false,
    });
    expect(resolveLocalSmokeSelection(["--profile", "real-provider"])).toMatchObject({
      profile: "real-provider",
      scenario: "lifecycle",
      failureMatrix: false,
      forcePinnedInstall: false,
    });
  });

  it("rejects unsupported local profiles and scenarios", () => {
    expect(() => resolveLocalSmokeSelection(["--profile", "ci"]))
      .toThrow("--profile must be deterministic or real-provider");
    expect(() => resolveLocalSmokeSelection(["--scenario", "ci"]))
      .toThrow("--scenario must be lifecycle or bundle");
  });
});
