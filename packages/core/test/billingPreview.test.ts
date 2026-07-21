import { describe, expect, it, vi } from "vitest";
import type { BillingGateway } from "@companion/billing";
import type { Db } from "@companion/db";
import {
  BillingPermissionError,
  BillingPreviewProviderError,
  getBillingPreview,
  getBillingPreviewSource,
} from "../src/billingService";

/**
 * Product promise:
 * Payment-method and invoice previews are visible only to an Owner or Admin in the selected organization.
 *
 * Regression caught:
 * Reusing the member-readable billing overview gate could expose Stripe payment metadata to Developers or another tenant.
 *
 * Why this test is service-level:
 * The core service owns both the role gate and the neutral Stripe boundary used by every HTTP caller.
 *
 * Failure proof:
 * Removing the Owner/Admin membership check makes the Developer and non-member cases call the gateway and resolve.
 */
function databaseFor(role: "owner" | "admin" | "developer" | null, withSubscription = true): Db {
  return {
    query: {
      memberships: { findFirst: vi.fn().mockResolvedValue(role ? { orgRole: role } : undefined) },
      billingSubscriptions: {
        findFirst: vi.fn().mockResolvedValue(withSubscription
          ? { stripeCustomerId: "cus_1", stripeSubscriptionId: "sub_1" }
          : undefined),
      },
    },
  } as unknown as Db;
}

function gatewayWithPreview() {
  const retrieveBillingPreview = vi.fn().mockResolvedValue({
    paymentMethod: { type: "card", brand: "visa", last4: "4242", expMonth: 8, expYear: 2030 },
    latestInvoice: {
      number: "INV-0042",
      createdAt: new Date("2026-07-21T10:00:00.000Z"),
      amountDue: 4_000,
      currency: "usd",
      status: "paid" as const,
      hostedInvoiceUrl: "https://invoice.stripe.test/in_1",
    },
  });
  return {
    gateway: { retrieveBillingPreview } as unknown as BillingGateway,
    retrieveBillingPreview,
  };
}

describe("billing preview authorization", () => {
  it.each(["owner", "admin"] as const)("allows an organization %s and serializes the neutral preview", async (role) => {
    const { gateway, retrieveBillingPreview } = gatewayWithPreview();
    const source = await getBillingPreviewSource({
      actorId: `user-${role}`,
      orgId: "org-1",
      database: databaseFor(role),
    });
    await expect(getBillingPreview({ source, gateway })).resolves.toEqual({
      paymentMethod: { type: "card", brand: "visa", last4: "4242", expMonth: 8, expYear: 2030 },
      latestInvoice: {
        number: "INV-0042",
        createdAt: "2026-07-21T10:00:00.000Z",
        amountDue: 4_000,
        currency: "usd",
        status: "paid",
        hostedInvoiceUrl: "https://invoice.stripe.test/in_1",
      },
    });
    expect(retrieveBillingPreview).toHaveBeenCalledWith({ customerId: "cus_1", subscriptionId: "sub_1" });
  });

  it.each([
    ["developer", "same-tenant Developer"],
    [null, "non-member or cross-tenant actor"],
  ] as const)("rejects a %s before Stripe is called", async (role, _description) => {
    const { gateway, retrieveBillingPreview } = gatewayWithPreview();
    await expect(getBillingPreviewSource({
      actorId: "user-denied",
      orgId: "org-1",
      database: databaseFor(role),
    })).rejects.toBeInstanceOf(BillingPermissionError);
    expect(retrieveBillingPreview).not.toHaveBeenCalled();
  });

  it("returns a stable empty preview before a Stripe subscription exists", async () => {
    const { gateway, retrieveBillingPreview } = gatewayWithPreview();
    const source = await getBillingPreviewSource({
      actorId: "user-owner",
      orgId: "org-1",
      database: databaseFor("owner", false),
    });
    await expect(getBillingPreview({ source, gateway })).resolves.toEqual({ paymentMethod: null, latestInvoice: null });
    expect(retrieveBillingPreview).not.toHaveBeenCalled();
  });

  it("converts Stripe failures into a provider-safe error without leaking details", async () => {
    const gateway = {
      retrieveBillingPreview: vi.fn().mockRejectedValue(new Error("card pm_secret failed")),
    } as unknown as BillingGateway;
    await expect(getBillingPreview({
      source: { customerId: "cus_1", subscriptionId: "sub_1" },
      gateway,
    })).rejects.toEqual(new BillingPreviewProviderError());
  });
});
