import { describe, expect, it } from "vitest";
import { settingsMemberTimezone } from "./settingsClient";

describe("settingsMemberTimezone", () => {
  it("keeps a stored cross-device override in the Skills settings drawer", () => {
    expect(settingsMemberTimezone({ timezone: "Pacific/Honolulu" })).toBe("Pacific/Honolulu");
  });

  it("keeps an unset profile distinct from the browser-detected display default", () => {
    expect(settingsMemberTimezone({ timezone: null })).toBeNull();
    expect(settingsMemberTimezone({})).toBeNull();
  });
});
