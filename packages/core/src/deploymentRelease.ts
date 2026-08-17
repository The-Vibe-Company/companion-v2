const RELEASE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/**
 * Public, non-secret identifier shared by processes from one immutable deployment. Health and
 * canary output may expose it; malformed or absent configuration is deliberately non-authoritative.
 */
export function deploymentReleaseId(env: NodeJS.ProcessEnv = process.env): string {
  const value = env.COMPANION_RELEASE_ID?.trim();
  return value && RELEASE_ID_PATTERN.test(value) ? value : "unknown";
}
