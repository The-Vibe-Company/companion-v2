import { describe, expect, it, vi } from "vitest";
import {
  COMPANIONS_ALLOWED_EMAIL_DOMAINS_ENV,
  COMPANIONS_FEATURE_FLAG,
  companionsAllowedEmailDomains,
  companionsApiConfig,
  companionsAvailableToUser,
  companionsEnabled,
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

describe("companionsApiConfig", () => {
  it("reports no missing API secrets when the flag is off", () => {
    const config = companionsApiConfig({});
    expect(config.enabled).toBe(false);
    expect(config.missingRequired).toEqual([]);
  });

  it("does not inspect runtime-only Box configuration", () => {
    expect(
      companionsApiConfig({
        ...enabledEnv,
        COMPANION_BOX_API_KEY: "",
        COMPANION_BOX_API_BASE: "",
        COMPANION_SECRETS_MASTER_KEY: "master-key",
      }).missingRequired,
    ).toEqual([]);
  });

  it("treats a true master flag without an allowlist as disabled", () => {
    const config = companionsApiConfig({ [COMPANIONS_FEATURE_FLAG]: "true" });
    expect(config.enabled).toBe(false);
    expect(config.missingRequired).toEqual([]);
  });

  it("lists only API-owned secrets once the flag and allowlist enable Companions", () => {
    expect(companionsApiConfig(enabledEnv).missingRequired).toEqual([
      "COMPANION_SECRETS_MASTER_KEY",
    ]);
  });

  it("clears the required list once the API secret is present", () => {
    const config = companionsApiConfig({
      ...enabledEnv,
      COMPANION_SECRETS_MASTER_KEY: "master-key",
    });
    expect(config.enabled).toBe(true);
    expect(config.missingRequired).toEqual([]);
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
    expect(missing).toEqual(["COMPANION_SECRETS_MASTER_KEY"]);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[0]).not.toContain("COMPANION_BOX_API_KEY");
    expect(log.mock.calls[0]?.[0]).toContain("COMPANION_SECRETS_MASTER_KEY");
  });
});
