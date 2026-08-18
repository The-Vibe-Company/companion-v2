import { describe, expect, it } from "vitest";

import { loadRuntimeServiceConfig, RuntimeServiceConfigError } from "./config";

const key = Buffer.alloc(32, 7).toString("base64");
const executorId = "11111111-1111-4111-8111-111111111111";

function validEnv(patch: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    DATABASE_COMPANION_RUNTIME_URL:
      "postgres://companion_runtime:secret@127.0.0.1:5432/companion",
    COMPANION_COMPANIONS_ENABLED: "true",
    COMPANION_COMPANIONS_ALLOWED_EMAIL_DOMAINS: "example.test",
    COMPANION_BOX_API_KEY: "box-key",
    COMPANION_BOX_API_BASE: "http://127.0.0.1:13400",
    COMPANION_SECRETS_MASTER_KEY: key,
    COMPANION_RUNTIME_DESKTOP_HMAC_SECRET: Buffer.alloc(32, 11).toString("base64"),
    COMPANION_API_URL: "http://127.0.0.1:3001",
    RAILWAY_GIT_COMMIT_SHA: "production-2026-08-17.3",
    ...patch,
  };
}

describe("runtime-only configuration", () => {
  it("uses the locked scheduler defaults and a generated executor UUID", () => {
    const config = loadRuntimeServiceConfig(validEnv(), { randomUuid: () => executorId });

    expect(config).toMatchObject({
      databaseRole: "companion_runtime",
      boxApiBase: "http://127.0.0.1:13400",
      boxTtlSeconds: 21_600,
      executorId,
      concurrency: 8,
      sweepIntervalMs: 2_000,
      leaseSeconds: 30,
      renewIntervalMs: 10_000,
      listenHost: "127.0.0.1",
      listenPort: 3_007,
      desktopMaxSkewSeconds: 30,
      shutdownDrainMs: 25_000,
      companionsEnabled: true,
      apiUrl: "http://127.0.0.1:3001",
      releaseId: "production-2026-08-17.3",
    });
    expect(config.masterKey).toHaveLength(32);
    expect(config.desktopHmacSecret).toHaveLength(32);
  });

  it.each([
    ["DATABASE_COMPANION_RUNTIME_URL", undefined],
    ["COMPANION_BOX_API_KEY", ""],
    ["COMPANION_SECRETS_MASTER_KEY", "not-a-key"],
    ["COMPANION_RUNTIME_DESKTOP_HMAC_SECRET", Buffer.alloc(8).toString("base64")],
  ])("fails closed when %s is missing or malformed", (name, value) => {
    expect(() => loadRuntimeServiceConfig(validEnv({ [name]: value }), {
      randomUuid: () => executorId,
    })).toThrow(RuntimeServiceConfigError);
  });

  it("validates the database URL, executor id, and fixed lifecycle timing", () => {
    expect(() => loadRuntimeServiceConfig(validEnv({
      DATABASE_COMPANION_RUNTIME_URL: "postgres://127.0.0.1/companion",
    }), { randomUuid: () => executorId })).toThrow(/dedicated runtime role/);
    expect(() => loadRuntimeServiceConfig(validEnv({
      COMPANION_RUNTIME_EXECUTOR_ID: "not-an-id",
    }))).toThrow(/must be a UUID/);
    expect(() => loadRuntimeServiceConfig(validEnv({
      COMPANION_RUNTIME_SHUTDOWN_DRAIN_MS: "30000",
    }), { randomUuid: () => executorId })).toThrow(/shorter than the runtime lease/);
    expect(() => loadRuntimeServiceConfig(validEnv({
      COMPANION_BOX_TTL_SECONDS: "3600",
    }), { randomUuid: () => executorId })).toThrow(/21600 to 21600/);

    const fixed = loadRuntimeServiceConfig(validEnv({
      // Old tuning knobs are intentionally ignored: the reusable kernel owns these constants.
      COMPANION_RUNTIME_LEASE_SECONDS: "20",
      COMPANION_RUNTIME_RENEW_INTERVAL_MS: "11000",
    }), { randomUuid: () => executorId });
    expect(fixed).toMatchObject({ leaseSeconds: 30, renewIntervalMs: 10_000 });
  });

  it("enables local claims only for an explicit true flag", () => {
    expect(loadRuntimeServiceConfig(validEnv({
      COMPANION_COMPANIONS_ENABLED: " TrUe ",
    }), { randomUuid: () => executorId }).companionsEnabled).toBe(true);
    expect(loadRuntimeServiceConfig(validEnv({
      COMPANION_COMPANIONS_ENABLED: "1",
    }), { randomUuid: () => executorId }).companionsEnabled).toBe(false);
    expect(loadRuntimeServiceConfig(validEnv({
      COMPANION_COMPANIONS_ALLOWED_EMAIL_DOMAINS: "",
    }), { randomUuid: () => executorId }).companionsEnabled).toBe(false);
  });

  it("boots the disabled kill-switch path with only the dedicated database URL", () => {
    const config = loadRuntimeServiceConfig({
      DATABASE_COMPANION_RUNTIME_URL:
        "postgres://companion_runtime:secret@127.0.0.1:5432/companion",
      COMPANION_COMPANIONS_ENABLED: "false",
    }, { randomUuid: () => executorId });

    expect(config).toMatchObject({
      companionsEnabled: false,
      boxApiKey: null,
      masterKey: null,
      desktopHmacSecret: null,
      apiUrl: null,
      releaseId: "local",
    });
  });

  it("accepts private listeners, explicit container wildcards, and HTTP Box simulators", () => {
    expect(() => loadRuntimeServiceConfig(validEnv({
      COMPANION_RUNTIME_HOST: "203.0.113.10",
    }), { randomUuid: () => executorId })).toThrow(/private-network/);
    expect(() => loadRuntimeServiceConfig(validEnv({
      COMPANION_BOX_API_BASE: "http://ascii.dev/api/box/v1",
    }), { randomUuid: () => executorId })).toThrow(/must use HTTPS/);

    expect(loadRuntimeServiceConfig(validEnv({
      COMPANION_RUNTIME_HOST: "10.20.30.40",
      COMPANION_BOX_API_BASE: "https://ascii.dev/api/box/v1/",
    }), { randomUuid: () => executorId })).toMatchObject({
      listenHost: "10.20.30.40",
      boxApiBase: "https://ascii.dev/api/box/v1",
    });
    expect(loadRuntimeServiceConfig(validEnv({
      COMPANION_RUNTIME_HOST: "0.0.0.0",
    }), { randomUuid: () => executorId }).listenHost).toBe("0.0.0.0");
    expect(loadRuntimeServiceConfig(validEnv({
      COMPANION_RUNTIME_HOST: "::",
    }), { randomUuid: () => executorId }).listenHost).toBe("::");
  });

  it("does not echo secret-bearing values in validation errors", () => {
    const secretValue = "leak-me-runtime-secret";
    let message = "";
    try {
      loadRuntimeServiceConfig(validEnv({
        COMPANION_SECRETS_MASTER_KEY: secretValue,
      }), { randomUuid: () => executorId });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).not.toContain(secretValue);
  });
});
