import { describe, expect, it } from "vitest";
import { computeSubscriptionPlan, getEntitlements, PAYMENT_GRACE_MS, type RawBillingState } from "../src/billing";

const NOW = new Date("2026-07-13T12:00:00.000Z");

function state(patch: Partial<RawBillingState>): RawBillingState {
  return { stripeStatus: null, currentPeriodEnd: null, cancelAtPeriodEnd: false, graceEndsAt: null, ...patch };
}

describe("billing entitlements", () => {
  it("keeps self-hosted workspaces fully unlocked without querying Stripe state", async () => {
    const entitlements = await getEntitlements({
      orgId: "self-hosted",
      database: new Proxy({}, { get: () => { throw new Error("database must not be read"); } }) as never,
      config: {
        billingMode: "disabled",
        entitlementMode: "enforce",
        pilotOrgIds: new Set(),
        proOrgAllowlist: new Set(),
        checkoutEnabled: false,
        webhooksEnabled: false,
      },
    });
    expect(entitlements).toMatchObject({ effectivePlan: "pro", personalSkills: true, skillHistory: true, enforced: false });
  });

  it("grants Pro to an active subscription", () => {
    expect(computeSubscriptionPlan(state({ stripeStatus: "active" }), NOW)).toBe("pro");
  });

  it("keeps Pro during a scheduled cancellation before period end", () => {
    expect(computeSubscriptionPlan(state({ stripeStatus: "active", cancelAtPeriodEnd: true, currentPeriodEnd: new Date(NOW.getTime() + 60_000) }), NOW)).toBe("pro");
  });

  it("returns Free once a scheduled cancellation period has ended", () => {
    expect(computeSubscriptionPlan(state({ stripeStatus: "active", cancelAtPeriodEnd: true, currentPeriodEnd: NOW }), NOW)).toBe("free");
  });

  it.each(["past_due", "unpaid"])("grants a non-renewable grace window for %s", (stripeStatus) => {
    expect(computeSubscriptionPlan(state({ stripeStatus, graceEndsAt: new Date(NOW.getTime() + PAYMENT_GRACE_MS) }), NOW)).toBe("pro");
    expect(computeSubscriptionPlan(state({ stripeStatus, graceEndsAt: NOW }), NOW)).toBe("free");
  });

  it.each([null, "incomplete", "incomplete_expired", "paused", "canceled", "trialing"])("maps %s to Free", (stripeStatus) => {
    expect(computeSubscriptionPlan(state({ stripeStatus }), NOW)).toBe("free");
  });

  it("returns to Pro when payment is regularized or an organization resubscribes", () => {
    const expired = state({ stripeStatus: "past_due", graceEndsAt: new Date(NOW.getTime() - 1) });
    expect(computeSubscriptionPlan(expired, NOW)).toBe("free");
    expect(computeSubscriptionPlan({ ...expired, stripeStatus: "active", graceEndsAt: null }, NOW)).toBe("pro");
    expect(computeSubscriptionPlan(state({ stripeStatus: "canceled" }), NOW)).toBe("free");
    expect(computeSubscriptionPlan(state({ stripeStatus: "active" }), NOW)).toBe("pro");
  });
});
