import { describe, expect, it } from "vitest";

import { resolveBoxLabConfig, workspaceScope } from "../src/config";
import { normalizeGuestFilePath } from "../src/driver";

describe("Box Lab configuration", () => {
  it("derives a stable bounded workspace scope and the +8 port", () => {
    const config = resolveBoxLabConfig({
      CONDUCTOR_PORT: "4100",
      CONDUCTOR_WORKSPACE_ID: "Feature/Pi real Linux!",
      BOX_LAB_DRIVER: "lima",
    }, "/work/repo");

    expect(config.port).toBe(4108);
    expect(config.workspaceScope).toBe(workspaceScope("Feature/Pi real Linux!"));
    expect(config.resourcePrefix).toMatch(/^cbl-[a-f0-9]{20}$/);
    expect(config.resourcePrefix.length).toBeLessThanOrEqual(24);
    expect(config.ociImage).toBe(`companion-box-lab-systemd:${config.workspaceScope}`);
    expect(config.apiKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("generates a fresh bearer key for each config without an explicit key", () => {
    const first = resolveBoxLabConfig({ BOX_LAB_DRIVER: "lima" }, "/work/repo");
    const second = resolveBoxLabConfig({ BOX_LAB_DRIVER: "lima" }, "/work/repo");

    expect(first.apiKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(second.apiKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(second.apiKey).not.toBe(first.apiKey);
  });

  it("preserves an explicit bearer key deterministically", () => {
    const config = resolveBoxLabConfig({
      BOX_LAB_API_KEY: "  explicit-lab-key  ",
      BOX_LAB_DRIVER: "lima",
    }, "/work/repo");

    expect(config.apiKey).toBe("explicit-lab-key");
  });

  it("does not validate an unused Conductor port when the Lab port is explicit", () => {
    const config = resolveBoxLabConfig({
      BOX_LAB_DRIVER: "lima",
      BOX_LAB_PORT: "6123",
      CONDUCTOR_PORT: "65535",
    }, "/work/repo");

    expect(config.port).toBe(6123);
    expect(() => resolveBoxLabConfig({
      BOX_LAB_DRIVER: "lima",
      CONDUCTOR_PORT: "65535",
    }, "/work/repo")).toThrow(/leave room/);
  });

  it("refuses externally reachable listeners", () => {
    expect(() => resolveBoxLabConfig({ BOX_LAB_HOST: "0.0.0.0" }, "/work/repo"))
      .toThrow(/loopback/);
  });

  it("keeps provider file writes under the contained home", () => {
    expect(normalizeGuestFilePath("~/.companion/state.json")).toBe(".companion/state.json");
    expect(normalizeGuestFilePath("/home/user/outbox/result.png")).toBe("outbox/result.png");
    expect(() => normalizeGuestFilePath("../../etc/shadow")).toThrow(/escapes/);
    expect(() => normalizeGuestFilePath("/etc/shadow")).toThrow(/under \/home\/user/);
  });
});
