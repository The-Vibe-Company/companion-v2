import React from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { BillingOverview } from "@companion/contracts";
import { BillingPane } from "./BillingPane";
import { SettingsSidebar } from "./SettingsSidebar";
import { canonicalizeSettingsRoute } from "./model";
import type { OrgCtx } from "./model";

const selfHostedBilling: BillingOverview = {
  billingEnabled: false,
  canManage: true,
  entitlements: {
    effectivePlan: "pro",
    computedPlan: "pro",
    billingMode: "disabled",
    entitlementMode: "off",
    enforced: false,
    personalSkills: true,
    skillHistory: true,
    orgSkillLimit: null,
    catalogFrozen: false,
  },
  unitAmount: 1_000,
  currency: "usd",
  interval: "month",
  activeSeats: 1,
  syncedSeats: null,
  estimatedMonthlySubtotal: 1_000,
  stripeStatus: null,
  seatSyncStatus: "not_applicable",
  currentPeriodEnd: null,
  cancelAtPeriodEnd: false,
  graceEndsAt: null,
  nextReconcileAt: null,
  lastError: null,
  orgSkillCount: 0,
  hiddenPersonalSkillCount: 0,
  sandboxUsage: {
    enabled: false,
    enforced: false,
    limit_minutes: null,
    used_minutes: 0,
    reserved_minutes: 0,
    remaining_minutes: null,
    minutes_per_seat: 250,
    period_start: "2026-07-01T00:00:00.000Z",
    period_end: "2026-08-01T00:00:00.000Z",
  },
  checkoutEnabled: false,
  portalEnabled: false,
};

function selfHostedContext(): OrgCtx {
  return {
    myId: "user-1",
    user: () => ({ id: "user-1", name: "Admin", email: "admin@example.com", initials: "A", avatarUrl: null }),
    currentOrg: {
      id: "org-1",
      name: "Acme",
      slug: "acme",
      kind: "team",
      myRole: "owner",
      created: "today",
      domain: null,
      domainAutoJoin: false,
      accessDomains: [],
      skillNamingPolicy: null,
      members: [],
    },
    billing: selfHostedBilling,
  } as unknown as OrgCtx;
}

describe("Billing navigation", () => {
  it("keeps Billing visible in self-hosted workspaces", () => {
    const html = renderToString(
      React.createElement(SettingsSidebar, {
        ctx: selfHostedContext(),
        route: { view: "general" },
        go: () => undefined,
        onClose: () => undefined,
        apiKeyCount: 0,
        inviteCount: 0,
      }),
    );
    expect(html).toContain("Billing");
    expect(html).toContain("Included");
  });

  it("keeps General current and hides GitHub for a Developer deep-link", () => {
    const ctx = selfHostedContext();
    ctx.canManage = false;
    ctx.myRole = "developer";
    ctx.currentOrg.myRole = "developer";
    const html = renderToString(
      React.createElement(SettingsSidebar, {
        ctx,
        route: canonicalizeSettingsRoute({ view: "github" }, ctx.canManage),
        go: () => undefined,
        onClose: () => undefined,
        apiKeyCount: 0,
        inviteCount: 0,
      }),
    );

    expect(html).toContain('aria-current="page" title="General"');
    expect(html).not.toContain('title="GitHub"');
  });

  it("explains that Pro is included without rendering payment actions", () => {
    const html = renderToString(React.createElement(BillingPane, { ctx: selfHostedContext() }));
    expect(html).toContain("Pro included");
    expect(html).toContain("Self-hosted");
    expect(html).not.toContain("Upgrade to Pro");
    expect(html).not.toContain("Manage payment");
  });

  it("shows the managed shared sandbox pool without implying active sessions are stopped", () => {
    const ctx = selfHostedContext();
    ctx.billing = {
      ...selfHostedBilling,
      billingEnabled: true,
      entitlements: { ...selfHostedBilling.entitlements, billingMode: "stripe", entitlementMode: "enforce", enforced: true },
      sandboxUsage: {
        ...selfHostedBilling.sandboxUsage,
        enabled: true,
        enforced: true,
        limit_minutes: 500,
        used_minutes: 42,
        reserved_minutes: 10,
        remaining_minutes: 448,
      },
    };
    const html = renderToString(React.createElement(BillingPane, { ctx }));
    expect(html).toContain("Sandbox usage");
    expect(html).toMatch(/42(?:<!-- -->)? min/);
    expect(html).toMatch(/448(?:<!-- -->)? min/);
    expect(html).toContain("New sandbox work is blocked");
    expect(html).toContain("Aug 1, 2026");
  });

  it("renders the Free ledger with an upgrade action and preserved-data limits", () => {
    const ctx = selfHostedContext();
    ctx.billing = {
      ...selfHostedBilling,
      billingEnabled: true,
      entitlements: {
        ...selfHostedBilling.entitlements,
        effectivePlan: "free",
        computedPlan: "free",
        billingMode: "stripe",
        entitlementMode: "enforce",
        enforced: true,
        personalSkills: false,
        skillHistory: false,
        orgSkillLimit: 20,
      },
      hiddenPersonalSkillCount: 3,
      checkoutEnabled: true,
      sandboxUsage: {
        ...selfHostedBilling.sandboxUsage,
        enabled: true,
        enforced: true,
        limit_minutes: 0,
        remaining_minutes: 0,
      },
    };
    const html = renderToString(React.createElement(BillingPane, { ctx }));
    expect(html).toContain("Free plan limits");
    expect(html).toContain("Upgrade to Pro");
    expect(html).toMatch(/3(?:<!-- -->)? hidden until Pro/);
    expect(html).toContain("Payment details will appear after a subscription starts");
  });

  it("keeps both portal and checkout actions for a restartable Free subscription", () => {
    const ctx = selfHostedContext();
    ctx.billing = {
      ...selfHostedBilling,
      billingEnabled: true,
      entitlements: {
        ...selfHostedBilling.entitlements,
        effectivePlan: "free",
        computedPlan: "free",
        billingMode: "stripe",
      },
      stripeStatus: "canceled",
      checkoutEnabled: true,
      portalEnabled: true,
    };
    const html = renderToString(React.createElement(BillingPane, { ctx }));
    expect(html).toContain("Manage billing");
    expect(html).toContain("Upgrade to Pro");
  });

  it("keeps delinquency and scheduled-cancellation warnings above the ledger", () => {
    const ctx = selfHostedContext();
    ctx.billing = {
      ...selfHostedBilling,
      billingEnabled: true,
      entitlements: { ...selfHostedBilling.entitlements, billingMode: "stripe", entitlementMode: "enforce", enforced: true },
      stripeStatus: "past_due",
      graceEndsAt: "2026-07-28T00:00:00.000Z",
      currentPeriodEnd: "2026-08-21T00:00:00.000Z",
      cancelAtPeriodEnd: true,
      portalEnabled: true,
    };
    const html = renderToString(React.createElement(BillingPane, { ctx }));
    expect(html).toContain("Payment needs attention");
    expect(html).toContain("scheduled to end");
    expect(html.indexOf("Payment needs attention")).toBeLessThan(html.indexOf("Billing summary"));
  });
});
