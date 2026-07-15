import { describe, expect, it } from "vitest";
import { parseSettingsView } from "./model";

describe("parseSettingsView", () => {
  it("accepts every current pane view", () => {
    for (const view of ["profile", "preferences", "models", "apikeys", "general", "org-models", "members", "invitations", "billing"] as const) {
      expect(parseSettingsView(view)).toBe(view);
    }
  });

  it("normalizes the legacy provider views onto the merged Models panes", () => {
    expect(parseSettingsView("providers")).toBe("models");
    expect(parseSettingsView("org-providers")).toBe("org-models");
  });

  it("falls back to profile for unknown, empty, or missing values", () => {
    expect(parseSettingsView("nope")).toBe("profile");
    expect(parseSettingsView("")).toBe("profile");
    expect(parseSettingsView(null)).toBe("profile");
    expect(parseSettingsView(undefined)).toBe("profile");
  });
});
