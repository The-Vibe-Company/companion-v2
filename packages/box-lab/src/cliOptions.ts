import type { BoxLabSmokeProfile, BoxLabSmokeScenario } from "./smoke";

export const BOX_LAB_CLI_COMMANDS = ["dev", "doctor", "smoke", "shell", "reset"] as const;
export const BOX_LAB_CLI_USAGE = "companion-box-lab dev|doctor|smoke|shell <box-id>|reset";

export interface LocalSmokeSelection {
  profile: BoxLabSmokeProfile;
  scenario: BoxLabSmokeScenario;
  failureMatrix: boolean;
  forcePinnedInstall: boolean;
}

function option(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

export function resolveLocalSmokeSelection(args: readonly string[]): LocalSmokeSelection {
  const profile = option(args, "--profile") ?? "deterministic";
  if (profile !== "deterministic" && profile !== "real-provider") {
    throw new Error("--profile must be deterministic or real-provider");
  }
  const scenario = option(args, "--scenario") ?? "lifecycle";
  if (scenario !== "lifecycle" && scenario !== "bundle") {
    throw new Error("--scenario must be lifecycle or bundle");
  }
  return {
    profile,
    scenario,
    failureMatrix: profile === "deterministic" && scenario === "lifecycle",
    forcePinnedInstall: profile === "deterministic" && scenario === "lifecycle",
  };
}
