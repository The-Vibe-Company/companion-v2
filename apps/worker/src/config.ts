export function boundedInteger(
  value: string | undefined,
  fallback: number,
  bounds: { min: number; max: number },
): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= bounds.min && parsed <= bounds.max ? parsed : fallback;
}

export interface RunWorkerConfig {
  concurrency: number;
  prewarmConcurrency: number;
  claimIntervalMs: number;
  leaseSeconds: number;
  heartbeatMs: number;
  inactivityMs: number;
  recorderReconnectMinMs: number;
  recorderReconnectMaxMs: number;
  retentionIntervalMs: number;
  cleanupIntervalMs: number;
  sandboxLifecycleV2: boolean;
  sandboxLifecycleV2OrgIds: ReadonlySet<string>;
  sandboxMaxSessionMs: number;
  recorderUnavailableMs: number;
}

export function runWorkerConfig(env: NodeJS.ProcessEnv = process.env): RunWorkerConfig {
  const leaseSeconds = boundedInteger(env.COMPANION_RUN_LEASE_SECONDS, 30, { min: 10, max: 300 });
  return {
    concurrency: boundedInteger(env.COMPANION_RUN_CONCURRENCY, 2, { min: 1, max: 32 }),
    prewarmConcurrency: boundedInteger(env.COMPANION_RUN_PREWARM_CONCURRENCY, 2, { min: 1, max: 32 }),
    claimIntervalMs: boundedInteger(env.COMPANION_RUN_CLAIM_INTERVAL_MS, 1_000, { min: 100, max: 60_000 }),
    leaseSeconds,
    heartbeatMs: boundedInteger(env.COMPANION_RUN_HEARTBEAT_MS, Math.max(1_000, Math.floor(leaseSeconds * 1_000 / 3)), {
      min: 1_000,
      max: Math.max(1_000, leaseSeconds * 1_000 - 1_000),
    }),
    inactivityMs: boundedInteger(env.COMPANION_RUN_INACTIVITY_MS, 120_000, { min: 10_000, max: 3_600_000 }),
    recorderReconnectMinMs: boundedInteger(env.COMPANION_RUN_RECORDER_RECONNECT_MIN_MS, 250, {
      min: 50,
      max: 10_000,
    }),
    recorderReconnectMaxMs: boundedInteger(env.COMPANION_RUN_RECORDER_RECONNECT_MAX_MS, 5_000, {
      min: 500,
      max: 60_000,
    }),
    retentionIntervalMs: boundedInteger(env.COMPANION_RUN_EVENT_RETENTION_INTERVAL_MS, 900_000, {
      min: 60_000,
      max: 86_400_000,
    }),
    cleanupIntervalMs: boundedInteger(env.COMPANION_RUN_SWEEP_INTERVAL_MS, 60_000, {
      min: 5_000,
      max: 3_600_000,
    }),
    sandboxLifecycleV2: ["1", "true"].includes(
      env.COMPANION_SANDBOX_LIFECYCLE_V2?.trim().toLowerCase() ?? "",
    ),
    sandboxLifecycleV2OrgIds: new Set(
      (env.COMPANION_SANDBOX_LIFECYCLE_V2_ORGS ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    ),
    sandboxMaxSessionMs: boundedInteger(env.COMPANION_SANDBOX_MAX_SESSION_MS, 3_600_000, {
      min: 600_000,
      max: 3_600_000,
    }),
    recorderUnavailableMs: boundedInteger(env.COMPANION_RUN_RECORDER_UNAVAILABLE_MS, 300_000, {
      min: 15_000,
      max: 300_000,
    }),
  };
}
