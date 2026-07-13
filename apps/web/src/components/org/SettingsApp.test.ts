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
  it("builds stable settings URLs for route and dialog state", async () => {
    const { settingsHref } = await import("./SettingsApp");

    expect(settingsHref({ view: "general" }, null)).toBe("/settings?view=general");
    expect(settingsHref({ view: "members" }, "invite")).toBe("/settings?view=members&dialog=invite");
    expect(settingsHref({ view: "profile" }, null)).toBe("/settings?view=profile");
    expect(settingsHref({ view: "billing" }, null)).toBe("/settings?view=billing");
  });

  it("normalizes malformed member collections before rendering", async () => {
    const { SettingsController } = await import("./SettingsApp");
    const data = {
      me: { id: "user_1", name: "Admin", email: "admin@tvc.dev", initials: "A" },
      domainJoin: { actorDomain: "tvc.dev", actorDomainIsPersonal: false },
      users: {
        user_1: { id: "user_1", name: "Admin", email: "admin@tvc.dev", initials: "A" },
      },
      invites: [],
      apiKeys: [],
      current: {
        id: "org_1",
        name: "Acme",
        slug: "acme",
        kind: "team",
        myRole: "owner",
        created: "2025-01-12",
        domain: null,
        domainAutoJoin: false,
        accessDomains: [],
        members: {},
      },
    } as unknown as SettingsAppData;

    expect(() =>
      renderToString(
        React.createElement(SettingsController, {
          data,
          initialRoute: { view: "general" },
          initialDialog: null,
          onClose: vi.fn(),
        }),
      ),
    ).not.toThrow();
  });
});
