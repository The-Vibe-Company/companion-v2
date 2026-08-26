/* oxlint-disable anti-slop/no-module-mocking, anti-slop/no-chained-type-assertions, anti-slop/require-safety-comment-for-type-assertion -- Existing server-render settings harness debt; this change adds the timezone preference assertion. */
import React from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { canonicalSettingsReplacement, SettingsController, settingsHref } from "./SettingsApp";
import { canonicalizeSettingsRoute, type SettingsAppData } from "./model";

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    prefetch: vi.fn(),
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
  }),
}));

describe("SettingsController", () => {
  it("builds stable settings URLs for route and dialog state", () => {
    expect(settingsHref({ view: "general" }, null)).toBe("/settings?view=general");
    expect(settingsHref({ view: "members" }, "invite")).toBe("/settings?view=members&dialog=invite");
    expect(settingsHref({ view: "profile" }, null)).toBe("/settings?view=profile");
    expect(settingsHref({ view: "billing" }, null)).toBe("/settings?view=billing");
    expect(settingsHref(canonicalizeSettingsRoute({ view: "github" }, false), null)).toBe("/settings?view=general");
  });

  it("canonicalizes retired and unknown settings views without changing embedded settings", () => {
    expect(canonicalSettingsReplacement("/settings", "?view=models", { view: "profile" }, null))
      .toBe("/settings?view=profile");
    expect(canonicalSettingsReplacement("/settings", "?view=profile", { view: "profile" }, null))
      .toBeNull();
    expect(canonicalSettingsReplacement("/skills", "?view=models", { view: "profile" }, null))
      .toBeNull();
  });

  it("normalizes malformed member collections before rendering", () => {
    const data = {
      me: { id: "user_1", name: "Admin", email: "admin@tvc.dev", initials: "A" },
      domainJoin: { actorDomain: "tvc.dev", actorDomainIsPersonal: false },
      users: {
        user_1: { id: "user_1", name: "Admin", email: "admin@tvc.dev", initials: "A" },
      },
      invites: [],
      apiKeys: [],
      billing: null,
      gettingStarted: {
        companion_installed_at: null,
        local_reviewed_at: null,
        org_reviewed_at: null,
        completed_at: null,
        dismissed_at: "2026-07-28T12:00:00.000Z",
        completed: false,
        first_incomplete_step: "companion_install",
      },
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

    const html = renderToString(
        React.createElement(SettingsController, {
          data,
          initialRoute: { view: "profile" },
          initialDialog: null,
          onClose: vi.fn(),
        }),
      );
    expect(html).toContain("Resume onboarding");
  });

  it("renders the stored member timezone in personal preferences", () => {
    const data = {
      me: { id: "user_1", name: "Admin", email: "admin@tvc.dev", initials: "A" },
      timezone: "Pacific/Auckland",
      domainJoin: { actorDomain: "tvc.dev", actorDomainIsPersonal: false },
      users: { user_1: { id: "user_1", name: "Admin", email: "admin@tvc.dev", initials: "A" } },
      invites: [],
      apiKeys: [],
      billing: null,
      gettingStarted: null,
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

    const html = renderToString(React.createElement(SettingsController, {
      data,
      initialRoute: { view: "preferences" },
      initialDialog: null,
      onClose: vi.fn(),
    }));

    expect(html).toContain("IANA timezone");
    expect(html).toContain("Pacific/Auckland");
    expect(html).toContain("Used by every Companion");
  });
});
