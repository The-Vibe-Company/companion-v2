const ENABLED_VALUE = "true";

export const COMPANIONS_FEATURE_FLAG = "COMPANION_COMPANIONS_ENABLED";
export const COMPANIONS_ALLOWED_EMAIL_DOMAINS_ENV =
  "COMPANION_COMPANIONS_ALLOWED_EMAIL_DOMAINS";

export function companionsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    env[COMPANIONS_FEATURE_FLAG]?.trim().toLowerCase() === ENABLED_VALUE
    && companionsAllowedEmailDomains(env).size > 0
  );
}

/**
 * Resolve the required, case-insensitive email-domain allowlist. Empty entries are ignored. An
 * unset, blank, or comma-only value keeps Companions disabled even when the master flag is true.
 */
export function companionsAllowedEmailDomains(
  env: NodeJS.ProcessEnv = process.env,
): ReadonlySet<string> {
  return new Set(
    (env[COMPANIONS_ALLOWED_EMAIL_DOMAINS_ENV] ?? "")
      .split(",")
      .map((domain) => domain.trim().toLowerCase())
      .filter(Boolean),
  );
}

/**
 * Decide whether an authenticated user may access Companions. The master switch and a non-empty
 * allowlist are both required. Missing or malformed emails fail closed.
 */
export function companionsAvailableToUser(
  email: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!companionsEnabled(env) || !email) return false;

  const normalizedEmail = email.trim().toLowerCase();
  const at = normalizedEmail.indexOf("@");
  if (at <= 0 || at !== normalizedEmail.lastIndexOf("@") || at === normalizedEmail.length - 1) {
    return false;
  }

  const allowedDomains = companionsAllowedEmailDomains(env);
  return allowedDomains.has(normalizedEmail.slice(at + 1));
}

/**
 * API-owned secrets that become required when Companions is enabled. Box/Pi configuration is
 * deliberately absent: only `apps/runtime` may receive the Box key or resolve runtime tuning.
 */
export const COMPANIONS_API_REQUIRED_ENV = [
  "COMPANION_SECRETS_MASTER_KEY",
] as const;

export interface CompanionsApiConfig {
  enabled: boolean;
  /** Required secrets that are unset while the flag is on. Always empty when the flag is off. */
  missingRequired: string[];
}

/**
 * Resolve only the API-side Companion requirements without throwing. Runtime configuration is
 * validated independently by `apps/runtime` before it can claim work.
 */
export function companionsApiConfig(
  env: NodeJS.ProcessEnv = process.env,
): CompanionsApiConfig {
  const enabled = companionsEnabled(env);
  return {
    enabled,
    missingRequired: enabled
      ? COMPANIONS_API_REQUIRED_ENV.filter((key) => !env[key]?.trim())
      : [],
  };
}

/**
 * Emit a single boot-time warning when Companions is enabled but an API-owned secret is missing.
 * This never throws: production must still boot so the flag can be flipped off without a redeploy,
 * and the Companions control-plane routes stay unregistered while the flag is off. Returns the list
 * of missing secrets to keep the check testable. When the flag is off this is a no-op.
 */
export function warnIfCompanionsMisconfigured(
  env: NodeJS.ProcessEnv = process.env,
  log: (message: string) => void = console.warn,
): string[] {
  const { enabled, missingRequired } = companionsApiConfig(env);
  if (!enabled || missingRequired.length === 0) return [];
  log(
    `${COMPANIONS_FEATURE_FLAG}=true but the following Companions API secrets are unset: ` +
      `${missingRequired.join(", ")}. Companion control-plane actions will fail until they are ` +
      `configured. Unset ${COMPANIONS_FEATURE_FLAG} (it defaults to false) to run with Companions disabled.`,
  );
  return missingRequired;
}
