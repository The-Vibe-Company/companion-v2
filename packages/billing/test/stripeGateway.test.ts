import { describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";
import { StripeBillingGateway } from "../src/index";

function gatewayWith(client: object): StripeBillingGateway {
  return new StripeBillingGateway("sk_test", "price_pro", "bpc_pro", "whsec_test", client as Stripe);
}

const lockedPortalFeatures = {
  payment_method_update: { enabled: true },
  invoice_history: { enabled: true },
  subscription_cancel: { enabled: true, mode: "at_period_end" },
  subscription_update: { enabled: false },
};

describe("StripeBillingGateway", () => {
  it("validates the exact licensed monthly USD price and locked portal", async () => {
    const gateway = gatewayWith({
      prices: { retrieve: vi.fn().mockResolvedValue({ active: true, type: "recurring", currency: "usd", unit_amount: 1000, recurring: { interval: "month", usage_type: "licensed" } }) },
      billingPortal: { configurations: { retrieve: vi.fn().mockResolvedValue({ features: lockedPortalFeatures }) } },
    });
    await expect(gateway.validateConfiguration()).resolves.toBeUndefined();
  });

  it("rejects a portal that permits subscription or quantity changes", async () => {
    const gateway = gatewayWith({
      prices: { retrieve: vi.fn().mockResolvedValue({ active: true, type: "recurring", currency: "usd", unit_amount: 1000, recurring: { interval: "month", usage_type: "licensed" } }) },
      billingPortal: {
        configurations: {
          retrieve: vi.fn().mockResolvedValue({
            features: { ...lockedPortalFeatures, subscription_update: { enabled: true } },
          }),
        },
      },
    });
    await expect(gateway.validateConfiguration()).rejects.toThrow("must disable plan, promotion, and quantity updates");
  });

  it("rejects immediate cancellation in the customer portal", async () => {
    const gateway = gatewayWith({
      prices: { retrieve: vi.fn().mockResolvedValue({ active: true, type: "recurring", currency: "usd", unit_amount: 1000, recurring: { interval: "month", usage_type: "licensed" } }) },
      billingPortal: {
        configurations: {
          retrieve: vi.fn().mockResolvedValue({
            features: {
              ...lockedPortalFeatures,
              subscription_cancel: { enabled: true, mode: "immediately" },
            },
          }),
        },
      },
    });
    await expect(gateway.validateConfiguration()).rejects.toThrow("cancellation at period end");
  });

  it("creates fixed-quantity Tax-enabled Checkout with promotion codes and durable metadata", async () => {
    const create = vi.fn().mockResolvedValue({ id: "cs_1", url: "https://checkout.test", expires_at: 2_000_000_000, status: "open" });
    const gateway = gatewayWith({ checkout: { sessions: { create } } });
    await gateway.createCheckoutSession({
      orgId: "org_1",
      customerId: "cus_1",
      quantity: 3,
      successUrl: "https://app.test/settings?view=billing&checkout=success",
      cancelUrl: "https://app.test/settings?view=billing&checkout=cancelled",
      idempotencyKey: "billing:checkout:org_1:1",
    });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        line_items: [{ price: "price_pro", quantity: 3 }],
        automatic_tax: { enabled: true },
        billing_address_collection: "required",
        customer_update: { address: "auto", name: "auto" },
        tax_id_collection: { enabled: true },
        allow_promotion_codes: true,
        metadata: { companion_org_id: "org_1" },
      }),
      { idempotencyKey: "billing:checkout:org_1:1" },
    );
  });

  it("delegates seat prorations to Stripe", async () => {
    const update = vi.fn().mockResolvedValue({
      id: "sub_1", customer: "cus_1", status: "active", cancel_at_period_end: false, canceled_at: null,
      items: {
        data: [{
          id: "si_1",
          quantity: 4,
          price: { id: "price_pro" },
          current_period_start: 2_000_000_000,
          current_period_end: 2_002_592_000,
        }],
      },
    });
    const gateway = gatewayWith({ subscriptions: { update } });
    const snapshot = await gateway.updateSeatQuantity({ subscriptionId: "sub_1", itemId: "si_1", quantity: 4, idempotencyKey: "billing:seats:org_1:4:1" });
    expect(update).toHaveBeenCalledWith(
      "sub_1",
      { items: [{ id: "si_1", quantity: 4 }], proration_behavior: "create_prorations" },
      { idempotencyKey: "billing:seats:org_1:4:1" },
    );
    expect(snapshot.currentPeriodStart).toEqual(new Date(2_000_000_000_000));
    expect(snapshot.currentPeriodEnd).toEqual(new Date(2_002_592_000_000));
  });
});
