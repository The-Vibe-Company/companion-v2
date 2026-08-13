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

// Defaults intentionally mirror AsciiBoxCompanionRuntime and .env.example so that a deployment can
// boot with Companions enabled once the required secrets are present without setting every optional
// tuning variable. Keep these in sync if the runtime defaults change.
const DEFAULT_BOX_API_BASE = "https://ascii.dev/api/box/v1";
const DEFAULT_PI_MCP_ADAPTER_PACKAGE = "npm:pi-mcp-adapter@2.12.1";
const DEFAULT_BOX_TTL_SECONDS = 3600;
const DEFAULT_BOX_POLL_INTERVAL_MS = 1_000;
const DEFAULT_BOX_READY_TIMEOUT_MS = 120_000;

/**
 * Secrets that only become required when Companions is turned on. The Box lifecycle needs an API key
 * and the Skills master key envelope-encrypts companion provider subscription credentials (THE-324).
 * They are intentionally absent from this list when the flag is off so production boots cleanly with
 * Companions disabled and none of them set.
 */
export const COMPANIONS_REQUIRED_ENV = [
  "COMPANION_BOX_API_KEY",
  "COMPANION_SECRETS_MASTER_KEY",
] as const;

export interface CompanionsRuntimeConfig {
  enabled: boolean;
  boxApiBase: string;
  boxEnvironment?: string;
  boxTtlSeconds: number;
  boxPollIntervalMs: number;
  boxReadyTimeoutMs: number;
  piInstallCommand?: string;
  piMcpAdapterPackage: string;
  /** Required secrets that are unset while the flag is on. Always empty when the flag is off. */
  missingRequired: string[];
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Resolve the Companions runtime configuration from the environment without throwing. Optional Box,
 * Pi, and provider values fall back to safe defaults, so unset variables never crash validation. The
 * returned `missingRequired` list is only populated when the flag is on, which lets callers surface a
 * clear, actionable signal instead of failing deep inside a request handler.
 */
export function companionsRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env,
): CompanionsRuntimeConfig {
  const enabled = companionsEnabled(env);
  return {
    enabled,
    boxApiBase: (env.COMPANION_BOX_API_BASE?.trim() || DEFAULT_BOX_API_BASE).replace(/\/+$/, ""),
    boxEnvironment: env.COMPANION_BOX_ENVIRONMENT?.trim() || undefined,
    boxTtlSeconds: positiveInteger(env.COMPANION_BOX_TTL_SECONDS, DEFAULT_BOX_TTL_SECONDS),
    boxPollIntervalMs: positiveInteger(
      env.COMPANION_BOX_POLL_INTERVAL_MS,
      DEFAULT_BOX_POLL_INTERVAL_MS,
    ),
    boxReadyTimeoutMs: positiveInteger(
      env.COMPANION_BOX_READY_TIMEOUT_MS,
      DEFAULT_BOX_READY_TIMEOUT_MS,
    ),
    piInstallCommand: env.COMPANION_PI_INSTALL_COMMAND?.trim() || undefined,
    piMcpAdapterPackage:
      env.COMPANION_PI_MCP_ADAPTER_PACKAGE?.trim() || DEFAULT_PI_MCP_ADAPTER_PACKAGE,
    missingRequired: enabled
      ? COMPANIONS_REQUIRED_ENV.filter((key) => !env[key]?.trim())
      : [],
  };
}

/**
 * Emit a single boot-time warning when Companions is enabled but its runtime secrets are missing.
 * This never throws: production must still boot so the flag can be flipped off without a redeploy,
 * and the Companions control-plane routes stay unregistered while the flag is off. Returns the list
 * of missing secrets to keep the check testable. When the flag is off this is a no-op.
 */
export function warnIfCompanionsMisconfigured(
  env: NodeJS.ProcessEnv = process.env,
  log: (message: string) => void = console.warn,
): string[] {
  const { enabled, missingRequired } = companionsRuntimeConfig(env);
  if (!enabled || missingRequired.length === 0) return [];
  log(
    `${COMPANIONS_FEATURE_FLAG}=true but the following Companions runtime secrets are unset: ` +
      `${missingRequired.join(", ")}. Companion Box and provider actions will fail until they are ` +
      `configured. Unset ${COMPANIONS_FEATURE_FLAG} (it defaults to false) to run with Companions disabled.`,
  );
  return missingRequired;
}
