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

  it("returns only sanitized card details and the latest finalized invoice", async () => {
    const retrieveSubscription = vi.fn().mockResolvedValue({
      default_payment_method: {
        id: "pm_secret",
        type: "card",
        card: { brand: "visa", last4: "4242", exp_month: 8, exp_year: 2030 },
      },
    });
    const retrieveCustomer = vi.fn().mockResolvedValue({
      deleted: false,
      invoice_settings: { default_payment_method: null },
    });
    const listInvoices = vi.fn().mockResolvedValue({
      data: [
        { id: "in_draft", status: "draft", created: 2_000_000_100, amount_due: 5_000, currency: "usd" },
        {
          id: "in_secret",
          number: "INV-0042",
          status: "paid",
          created: 2_000_000_000,
          amount_due: 4_000,
          currency: "usd",
          hosted_invoice_url: "https://invoice.stripe.test/in_secret",
        },
      ],
    });
    const gateway = gatewayWith({
      subscriptions: { retrieve: retrieveSubscription },
      customers: { retrieve: retrieveCustomer },
      invoices: { list: listInvoices },
    });

    await expect(gateway.retrieveBillingPreview({ customerId: "cus_1", subscriptionId: "sub_1" })).resolves.toEqual({
      paymentMethod: { type: "card", brand: "visa", last4: "4242", expMonth: 8, expYear: 2030 },
      latestInvoice: {
        number: "INV-0042",
        createdAt: new Date(2_000_000_000_000),
        amountDue: 4_000,
        currency: "usd",
        status: "paid",
        hostedInvoiceUrl: "https://invoice.stripe.test/in_secret",
      },
    });
    expect(retrieveSubscription).toHaveBeenCalledWith("sub_1", {
      expand: ["default_payment_method", "default_source"],
    });
    expect(retrieveCustomer).toHaveBeenCalledWith("cus_1", {
      expand: ["invoice_settings.default_payment_method", "default_source"],
    });
    expect(listInvoices).toHaveBeenCalledWith({ customer: "cus_1", subscription: "sub_1", limit: 100 });
  });

  it("falls back to a sanitized legacy subscription card source", async () => {
    const retrieveSource = vi.fn().mockResolvedValue({
      id: "card_secret",
      object: "card",
      brand: "Visa",
      last4: "4242",
      exp_month: 8,
      exp_year: 2030,
    });
    const gateway = gatewayWith({
      subscriptions: {
        retrieve: vi.fn().mockResolvedValue({ default_payment_method: null, default_source: "card_secret" }),
      },
      customers: {
        retrieve: vi.fn().mockResolvedValue({
          deleted: false,
          default_source: null,
          invoice_settings: { default_payment_method: null },
        }),
        retrieveSource,
      },
      invoices: { list: vi.fn().mockResolvedValue({ data: [], has_more: false }) },
    });

    await expect(gateway.retrieveBillingPreview({ customerId: "cus_1", subscriptionId: "sub_1" })).resolves.toEqual({
      paymentMethod: { type: "card", brand: "Visa", last4: "4242", expMonth: 8, expYear: 2030 },
      latestInvoice: null,
    });
    expect(retrieveSource).toHaveBeenCalledWith("cus_1", "card_secret");
  });

  it("paginates past draft invoices to find the latest finalized invoice", async () => {
    const listInvoices = vi
      .fn()
      .mockResolvedValueOnce({ data: [{ id: "in_draft", status: "draft" }], has_more: true })
      .mockResolvedValueOnce({
        data: [{
          id: "in_paid",
          number: "INV-0001",
          status: "paid",
          created: 2_000_000_000,
          amount_due: 1_000,
          currency: "usd",
          hosted_invoice_url: null,
        }],
        has_more: false,
      });
    const gateway = gatewayWith({
      subscriptions: { retrieve: vi.fn().mockResolvedValue({ default_payment_method: null, default_source: null }) },
      customers: {
        retrieve: vi.fn().mockResolvedValue({
          deleted: false,
          default_source: null,
          invoice_settings: { default_payment_method: null },
        }),
      },
      invoices: { list: listInvoices },
    });

    await expect(gateway.retrieveBillingPreview({ customerId: "cus_1", subscriptionId: "sub_1" })).resolves.toMatchObject({
      latestInvoice: { number: "INV-0001", status: "paid" },
    });
    expect(listInvoices).toHaveBeenNthCalledWith(2, {
      customer: "cus_1",
      subscription: "sub_1",
      limit: 100,
      starting_after: "in_draft",
    });
  });

  it("resolves a customer-level non-card payment method without inventing card metadata", async () => {
    const retrievePaymentMethod = vi.fn().mockResolvedValue({ id: "pm_sepa", type: "sepa_debit" });
    const gateway = gatewayWith({
      subscriptions: { retrieve: vi.fn().mockResolvedValue({ default_payment_method: null }) },
      customers: {
        retrieve: vi.fn().mockResolvedValue({
          deleted: false,
          invoice_settings: { default_payment_method: "pm_sepa" },
        }),
      },
      paymentMethods: { retrieve: retrievePaymentMethod },
      invoices: { list: vi.fn().mockResolvedValue({ data: [] }) },
    });

    await expect(gateway.retrieveBillingPreview({ customerId: "cus_1", subscriptionId: "sub_1" })).resolves.toEqual({
      paymentMethod: { type: "sepa_debit", brand: null, last4: null, expMonth: null, expYear: null },
      latestInvoice: null,
    });
    expect(retrievePaymentMethod).toHaveBeenCalledWith("pm_sepa");
  });

  it("returns an empty preview when Stripe has no payment method or finalized invoice", async () => {
    const gateway = gatewayWith({
      subscriptions: { retrieve: vi.fn().mockResolvedValue({ default_payment_method: null }) },
      customers: {
        retrieve: vi.fn().mockResolvedValue({ deleted: false, invoice_settings: { default_payment_method: null } }),
      },
      invoices: { list: vi.fn().mockResolvedValue({ data: [{ status: "draft" }] }) },
    });

    await expect(gateway.retrieveBillingPreview({ customerId: "cus_1", subscriptionId: "sub_1" })).resolves.toEqual({
      paymentMethod: null,
      latestInvoice: null,
    });
  });
});
