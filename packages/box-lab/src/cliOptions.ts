import type { BoxLabSmokeProfile, BoxLabSmokeScenario } from "./smoke";

export const BOX_LAB_CLI_COMMANDS = ["dev", "doctor", "smoke", "shell", "reset"] as const;
export const BOX_LAB_CLI_USAGE = "companion-box-lab dev|doctor|smoke|shell <box-id>|reset";

export interface LocalSmokeSelection {
  profile: BoxLabSmokeProfile;
  scenario: BoxLabSmokeScenario;
  failureMatrix: boolean;
  forcePinnedInstall: boolean;
}

function smokeOptions(args: readonly string[]): Map<"--profile" | "--scenario", string> {
  const options = new Map<"--profile" | "--scenario", string>();
  const optionArgs = args[0] === "--" ? args.slice(1) : args;
  for (let index = 0; index < optionArgs.length; index += 2) {
    const name = optionArgs[index];
    if (name !== "--profile" && name !== "--scenario") {
      throw new Error(`Unknown smoke argument: ${name}`);
    }
    if (options.has(name)) throw new Error(`${name} may only be provided once`);
    const value = optionArgs[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
    options.set(name, value);
  }
  return options;
}

export function resolveLocalSmokeSelection(args: readonly string[]): LocalSmokeSelection {
  const options = smokeOptions(args);
  const profile = options.get("--profile") ?? "deterministic";
  if (profile !== "deterministic" && profile !== "real-provider") {
    throw new Error("--profile must be deterministic or real-provider");
  }
  const scenario = options.get("--scenario") ?? "lifecycle";
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
