import { describe, expect, it, vi } from "vitest";
import {
  COMPANIONS_FEATURE_FLAG,
  companionsEnabled,
  companionsRuntimeConfig,
  warnIfCompanionsMisconfigured,
} from "../src/featureFlags";

describe("companionsEnabled", () => {
  it("fails closed when the flag is absent or disabled", () => {
    expect(companionsEnabled({})).toBe(false);
    expect(companionsEnabled({ [COMPANIONS_FEATURE_FLAG]: "false" })).toBe(false);
    expect(companionsEnabled({ [COMPANIONS_FEATURE_FLAG]: "1" })).toBe(false);
  });

  it("accepts an explicit true value", () => {
    expect(companionsEnabled({ [COMPANIONS_FEATURE_FLAG]: "true" })).toBe(true);
    expect(companionsEnabled({ [COMPANIONS_FEATURE_FLAG]: " TRUE " })).toBe(true);
  });
});

describe("companionsRuntimeConfig", () => {
  it("applies safe defaults and reports no missing secrets when the flag is off", () => {
    const config = companionsRuntimeConfig({});
    expect(config.enabled).toBe(false);
    expect(config.missingRequired).toEqual([]);
    expect(config.boxApiBase).toBe("https://ascii.dev/api/box/v1");
    expect(config.boxTtlSeconds).toBe(3600);
    expect(config.piMcpAdapterPackage).toBe("npm:pi-mcp-adapter@2.12.1");
    expect(config.boxEnvironment).toBeUndefined();
    expect(config.piInstallCommand).toBeUndefined();
  });

  it("never treats optional Box/Pi secrets as missing while the flag is off", () => {
    expect(
      companionsRuntimeConfig({ [COMPANIONS_FEATURE_FLAG]: "false" }).missingRequired,
    ).toEqual([]);
  });

  it("lists the required secrets that are unset while the flag is on", () => {
    expect(
      companionsRuntimeConfig({ [COMPANIONS_FEATURE_FLAG]: "true" }).missingRequired,
    ).toEqual(["COMPANION_BOX_API_KEY", "COMPANION_SECRETS_MASTER_KEY"]);
  });

  it("clears the required list once every secret is present", () => {
    const config = companionsRuntimeConfig({
      [COMPANIONS_FEATURE_FLAG]: "true",
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
      COMPANION_PI_INSTALL_COMMAND: "pi install",
      COMPANION_PI_MCP_ADAPTER_PACKAGE: "npm:pi-mcp-adapter@9.9.9",
    });
    expect(config.boxApiBase).toBe("https://box.example.com/api/v1");
    expect(config.boxEnvironment).toBe("staging");
    expect(config.boxTtlSeconds).toBe(600);
    expect(config.piInstallCommand).toBe("pi install");
    expect(config.piMcpAdapterPackage).toBe("npm:pi-mcp-adapter@9.9.9");
  });

  it("falls back to the default TTL when the override is not a positive integer", () => {
    expect(companionsRuntimeConfig({ COMPANION_BOX_TTL_SECONDS: "nope" }).boxTtlSeconds).toBe(3600);
    expect(companionsRuntimeConfig({ COMPANION_BOX_TTL_SECONDS: "-5" }).boxTtlSeconds).toBe(3600);
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
        [COMPANIONS_FEATURE_FLAG]: "true",
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
    const missing = warnIfCompanionsMisconfigured({ [COMPANIONS_FEATURE_FLAG]: "true" }, log);
    expect(missing).toEqual(["COMPANION_BOX_API_KEY", "COMPANION_SECRETS_MASTER_KEY"]);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[0]).toContain("COMPANION_BOX_API_KEY");
    expect(log.mock.calls[0]?.[0]).toContain("COMPANION_SECRETS_MASTER_KEY");
  });
});
