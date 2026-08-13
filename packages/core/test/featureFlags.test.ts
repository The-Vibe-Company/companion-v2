import { describe, expect, it, vi } from "vitest";
import {
  COMPANIONS_ALLOWED_EMAIL_DOMAINS_ENV,
  COMPANIONS_FEATURE_FLAG,
  companionsAllowedEmailDomains,
  companionsAvailableToUser,
  companionsEnabled,
  companionsRuntimeConfig,
  warnIfCompanionsMisconfigured,
} from "../src/featureFlags";

const enabledEnv = {
  [COMPANIONS_FEATURE_FLAG]: "true",
  [COMPANIONS_ALLOWED_EMAIL_DOMAINS_ENV]: "example.com",
};

describe("companionsEnabled", () => {
  it("fails closed when the flag is absent, disabled, or missing an allowlist", () => {
    expect(companionsEnabled({})).toBe(false);
    expect(companionsEnabled({ [COMPANIONS_FEATURE_FLAG]: "false" })).toBe(false);
    expect(companionsEnabled({ [COMPANIONS_FEATURE_FLAG]: "1" })).toBe(false);
    expect(companionsEnabled({ [COMPANIONS_FEATURE_FLAG]: "true" })).toBe(false);
    expect(
      companionsEnabled({
        [COMPANIONS_FEATURE_FLAG]: "true",
        [COMPANIONS_ALLOWED_EMAIL_DOMAINS_ENV]: " , ",
      }),
    ).toBe(false);
  });

  it("accepts an explicit true value with a non-empty allowlist", () => {
    expect(companionsEnabled(enabledEnv)).toBe(true);
    expect(
      companionsEnabled({
        ...enabledEnv,
        [COMPANIONS_FEATURE_FLAG]: " TRUE ",
      }),
    ).toBe(true);
  });
});

describe("companionsAvailableToUser", () => {
  it("keeps the master switch fail closed regardless of the allowlist", () => {
    expect(
      companionsAvailableToUser("member@thevibecompany.co", {
        [COMPANIONS_ALLOWED_EMAIL_DOMAINS_ENV]: "thevibecompany.co",
      }),
    ).toBe(false);
  });

  it("fails closed when the allowlist is unset or empty", () => {
    expect(
      companionsAvailableToUser("member@example.com", {
        [COMPANIONS_FEATURE_FLAG]: "true",
      }),
    ).toBe(false);
    expect(
      companionsAvailableToUser("member@example.com", {
        [COMPANIONS_FEATURE_FLAG]: "true",
        [COMPANIONS_ALLOWED_EMAIL_DOMAINS_ENV]: " , ",
      }),
    ).toBe(false);
  });

  it("matches configured domains case-insensitively and ignores surrounding whitespace", () => {
    const env = {
      ...enabledEnv,
      [COMPANIONS_ALLOWED_EMAIL_DOMAINS_ENV]: " example.com, THEVIBECOMPANY.CO ",
    };

    expect(companionsAllowedEmailDomains(env)).toEqual(
      new Set(["example.com", "thevibecompany.co"]),
    );
    expect(companionsAvailableToUser("Member@TheVibeCompany.Co", env)).toBe(true);
    expect(companionsAvailableToUser("member@other.example", env)).toBe(false);
  });

  it("requires an exact domain match rather than allowing subdomains", () => {
    expect(
      companionsAvailableToUser("member@sub.thevibecompany.co", {
        ...enabledEnv,
        [COMPANIONS_ALLOWED_EMAIL_DOMAINS_ENV]: "thevibecompany.co",
      }),
    ).toBe(false);
  });

  it.each([undefined, null, "", "member", "@example.com", "member@", "a@b@example.com"])(
    "denies a missing or malformed email (%s)",
    (email) => {
      expect(companionsAvailableToUser(email, enabledEnv)).toBe(false);
    },
  );
});

describe("companionsRuntimeConfig", () => {
  it("applies safe defaults and reports no missing secrets when the flag is off", () => {
    const config = companionsRuntimeConfig({});
    expect(config.enabled).toBe(false);
    expect(config.missingRequired).toEqual([]);
    expect(config.boxApiBase).toBe("https://ascii.dev/api/box/v1");
    expect(config.boxTtlSeconds).toBe(21_600);
    expect(config.boxPollIntervalMs).toBe(1_000);
    expect(config.boxReadyTimeoutMs).toBe(120_000);
    expect(config.piMcpAdapterPackage).toBe("npm:pi-mcp-adapter@2.12.1");
    expect(config.boxEnvironment).toBeUndefined();
    expect(config.piInstallCommand).toBeUndefined();
  });

  it("never treats optional Box/Pi secrets as missing while the flag is off", () => {
    expect(
      companionsRuntimeConfig({ [COMPANIONS_FEATURE_FLAG]: "false" }).missingRequired,
    ).toEqual([]);
  });

  it("treats a true master flag without an allowlist as disabled", () => {
    const config = companionsRuntimeConfig({ [COMPANIONS_FEATURE_FLAG]: "true" });
    expect(config.enabled).toBe(false);
    expect(config.missingRequired).toEqual([]);
  });

  it("lists the required secrets once the flag and allowlist enable Companions", () => {
    expect(companionsRuntimeConfig(enabledEnv).missingRequired).toEqual([
      "COMPANION_BOX_API_KEY",
      "COMPANION_SECRETS_MASTER_KEY",
    ]);
  });

  it("clears the required list once every secret is present", () => {
    const config = companionsRuntimeConfig({
      ...enabledEnv,
      COMPANION_BOX_API_KEY: "box-key",
      COMPANION_SECRETS_MASTER_KEY: "master-key",
    });
    expect(config.enabled).toBe(true);
    expect(config.missingRequired).toEqual([]);
  });

  it("normalizes and overrides optional Box/Pi values", () => {
    const config = companionsRuntimeConfig({
      COMPANION_BOX_API_BASE: "https://box.example.com/api/v1///",
      COMPANION_BOX_ENVIRONMENT: "staging",
      COMPANION_BOX_TTL_SECONDS: "600",
      COMPANION_BOX_POLL_INTERVAL_MS: "250",
      COMPANION_BOX_READY_TIMEOUT_MS: "60000",
      COMPANION_PI_INSTALL_COMMAND: "pi install",
      COMPANION_PI_MCP_ADAPTER_PACKAGE: "npm:pi-mcp-adapter@9.9.9",
    });
    expect(config.boxApiBase).toBe("https://box.example.com/api/v1");
    expect(config.boxEnvironment).toBe("staging");
    expect(config.boxTtlSeconds).toBe(600);
    expect(config.boxPollIntervalMs).toBe(250);
    expect(config.boxReadyTimeoutMs).toBe(60_000);
    expect(config.piInstallCommand).toBe("pi install");
    expect(config.piMcpAdapterPackage).toBe("npm:pi-mcp-adapter@9.9.9");
  });

  it("falls back to the default TTL when the override is not a positive integer", () => {
    expect(companionsRuntimeConfig({ COMPANION_BOX_TTL_SECONDS: "nope" }).boxTtlSeconds).toBe(21_600);
    expect(companionsRuntimeConfig({ COMPANION_BOX_TTL_SECONDS: "-5" }).boxTtlSeconds).toBe(21_600);
  });
});

describe("warnIfCompanionsMisconfigured", () => {
  it("stays silent when the flag is off", () => {
    const log = vi.fn();
    expect(warnIfCompanionsMisconfigured({}, log)).toEqual([]);
    expect(log).not.toHaveBeenCalled();
  });

  it("stays silent when the flag is on and every secret is present", () => {
    const log = vi.fn();
    const missing = warnIfCompanionsMisconfigured(
      {
        ...enabledEnv,
        COMPANION_BOX_API_KEY: "box-key",
        COMPANION_SECRETS_MASTER_KEY: "master-key",
      },
      log,
    );
    expect(missing).toEqual([]);
    expect(log).not.toHaveBeenCalled();
  });

  it("warns exactly once with the missing secrets when the flag is on", () => {
    const log = vi.fn();
    const missing = warnIfCompanionsMisconfigured(enabledEnv, log);
    expect(missing).toEqual(["COMPANION_BOX_API_KEY", "COMPANION_SECRETS_MASTER_KEY"]);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[0]).toContain("COMPANION_BOX_API_KEY");
    expect(log.mock.calls[0]?.[0]).toContain("COMPANION_SECRETS_MASTER_KEY");
  });
});
