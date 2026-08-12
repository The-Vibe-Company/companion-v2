const ENABLED_VALUE = "true";

export const COMPANIONS_FEATURE_FLAG = "COMPANION_COMPANIONS_ENABLED";

export function companionsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[COMPANIONS_FEATURE_FLAG]?.trim().toLowerCase() === ENABLED_VALUE;
}
