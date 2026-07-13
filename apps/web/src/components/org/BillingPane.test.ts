import React from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { BillingOverview } from "@companion/contracts";
import { BillingPane } from "./BillingPane";
import { SettingsSidebar } from "./SettingsSidebar";
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

  it("explains that Pro is included without rendering payment actions", () => {
    const html = renderToString(React.createElement(BillingPane, { ctx: selfHostedContext() }));
    expect(html).toContain("Pro included");
    expect(html).toContain("Self-hosted");
    expect(html).not.toContain("Upgrade to Pro");
    expect(html).not.toContain("Manage payment");
  });
});
