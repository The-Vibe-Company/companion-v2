const RELEASE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/**
 * Platform-injected commit identity, preferred in order. Operators must not pin a release id
 * between merge and live traffic: Railway injects `RAILWAY_GIT_COMMIT_SHA` on each GitHub-triggered
 * deploy; `SOURCE_COMMIT` is a secondary platform alias; CI may expose `GITHUB_SHA`.
 *
 * Leftover `COMPANION_RELEASE_ID` is intentionally ignored so a stale Railway variable cannot advertise
 * a previous cutover SHA after a new commit lands on main.
 */
const COMMIT_IDENTITY_KEYS = [
  "RAILWAY_GIT_COMMIT_SHA",
  "SOURCE_COMMIT",
  "GITHUB_SHA",
] as const;

/**
 * Public, non-secret identifier for the currently running deployment. Health and canary output may
 * expose it; malformed or absent platform identity is deliberately non-authoritative.
 */
export function deploymentReleaseId(env: NodeJS.ProcessEnv = process.env): string {
  for (const key of COMMIT_IDENTITY_KEYS) {
    const value = env[key]?.trim();
    if (value && RELEASE_ID_PATTERN.test(value)) {
      return value;
    }
  }
  return "local";
}
