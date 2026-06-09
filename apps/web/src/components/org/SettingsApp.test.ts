import React from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { SettingsAppData } from "./model";

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    prefetch: vi.fn(),
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
  }),
}));

describe("SettingsController", () => {
  it("builds stable settings URLs for tab and dialog state", async () => {
    const { settingsHref } = await import("./SettingsApp");

    expect(settingsHref("general", null)).toBe("/settings?tab=general");
    expect(settingsHref("teams", "team")).toBe("/settings?tab=teams&dialog=team");
  });

  it("normalizes malformed member and team collections before rendering", async () => {
    const { SettingsController } = await import("./SettingsApp");
    const data = {
      me: { id: "user_1", name: "Admin", email: "admin@tvc.dev", initials: "A" },
      users: {
        user_1: { id: "user_1", name: "Admin", email: "admin@tvc.dev", initials: "A" },
      },
      current: {
        id: "org_1",
        name: "Acme",
        slug: "acme",
        kind: "team",
        plan: "team",
        myRole: "owner",
        members: {},
        teams: [{ id: "team_1", slug: "platform", name: "Platform", members: {} }],
      },
    } as unknown as SettingsAppData;

    expect(() =>
      renderToString(
        React.createElement(SettingsController, {
          data,
          initialTab: "teams",
          initialDialog: null,
          onClose: vi.fn(),
        }),
      ),
    ).not.toThrow();
  });
});
