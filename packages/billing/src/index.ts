import Stripe from "stripe";

export interface BillingSubscriptionSnapshot {
  customerId: string;
  subscriptionId: string;
  itemId: string;
  priceId: string;
  status: string;
  quantity: number;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  canceledAt: Date | null;
}

export interface CheckoutSessionSnapshot {
  id: string;
  url: string | null;
  expiresAt: Date;
  status: "open" | "complete" | "expired";
}

export interface BillingPaymentMethodSnapshot {
  type: string;
  brand: string | null;
  last4: string | null;
  expMonth: number | null;
  expYear: number | null;
}

export interface BillingInvoiceSnapshot {
  number: string | null;
  createdAt: Date;
  amountDue: number;
  currency: string;
  status: "open" | "paid" | "uncollectible" | "void";
  hostedInvoiceUrl: string | null;
}

export interface BillingPreviewSnapshot {
  paymentMethod: BillingPaymentMethodSnapshot | null;
  latestInvoice: BillingInvoiceSnapshot | null;
}

export interface BillingGateway {
  validateConfiguration(): Promise<void>;
  createCustomer(orgId: string, name: string, idempotencyKey: string): Promise<string>;
  findCurrentSubscription(customerId: string): Promise<BillingSubscriptionSnapshot | null>;
  retrieveSubscription(subscriptionId: string): Promise<BillingSubscriptionSnapshot>;
  retrieveCheckoutSession(sessionId: string): Promise<CheckoutSessionSnapshot>;
  createCheckoutSession(input: {
    orgId: string;
    customerId: string;
    quantity: number;
    successUrl: string;
    cancelUrl: string;
    idempotencyKey: string;
  }): Promise<CheckoutSessionSnapshot>;
  createPortalSession(input: { customerId: string; returnUrl: string }): Promise<string>;
  retrieveBillingPreview(input: { customerId: string; subscriptionId: string }): Promise<BillingPreviewSnapshot>;
  updateSeatQuantity(input: {
    subscriptionId: string;
    itemId: string;
    quantity: number;
    idempotencyKey: string;
  }): Promise<BillingSubscriptionSnapshot>;
  constructWebhookEvent(rawBody: string | Buffer, signature: string): Stripe.Event;
}

function dateFromUnix(value: number | null | undefined): Date | null {
  return value ? new Date(value * 1_000) : null;
}

function subscriptionSnapshot(subscription: Stripe.Subscription): BillingSubscriptionSnapshot {
  const item = subscription.items.data[0];
  if (!item) throw new Error("Stripe subscription has no item");
  // Stripe's Basil API moved billing-period bounds from the subscription to each subscription item.
  // Keep the root fallback so stored snapshots also work with older pinned Stripe API versions.
  const legacy = subscription as Stripe.Subscription & { current_period_start?: number; current_period_end?: number };
  return {
    customerId: typeof subscription.customer === "string" ? subscription.customer : subscription.customer.id,
    subscriptionId: subscription.id,
    itemId: item.id,
    priceId: item.price.id,
    status: subscription.status,
    quantity: item.quantity ?? 1,
    currentPeriodStart: dateFromUnix(item.current_period_start ?? legacy.current_period_start),
    currentPeriodEnd: dateFromUnix(item.current_period_end ?? legacy.current_period_end),
    cancelAtPeriodEnd: subscription.cancel_at_period_end,
    canceledAt: dateFromUnix(subscription.canceled_at),
  };
}

function paymentMethodSnapshot(paymentMethod: Stripe.PaymentMethod | null): BillingPaymentMethodSnapshot | null {
  if (!paymentMethod) return null;
  return {
    type: paymentMethod.type,
    brand: paymentMethod.card?.brand ?? null,
    last4: paymentMethod.card?.last4 ?? null,
    expMonth: paymentMethod.card?.exp_month ?? null,
    expYear: paymentMethod.card?.exp_year ?? null,
  };
}

function customerSourceSnapshot(source: Stripe.CustomerSource | null): BillingPaymentMethodSnapshot | null {
  if (!source) return null;
  if (source.object === "card") {
    return {
      type: "card",
      brand: source.brand,
      last4: source.last4,
      expMonth: source.exp_month,
      expYear: source.exp_year,
    };
  }
  if (source.object === "bank_account") {
    return { type: "bank_account", brand: null, last4: source.last4, expMonth: null, expYear: null };
  }
  if (source.object === "source") {
    return {
      type: source.type,
      brand: source.card?.brand ?? null,
      last4: source.card?.last4 ?? source.sepa_debit?.last4 ?? null,
      expMonth: source.card?.exp_month ?? null,
      expYear: source.card?.exp_year ?? null,
    };
  }
  return { type: source.object, brand: null, last4: null, expMonth: null, expYear: null };
}

export class StripeBillingGateway implements BillingGateway {
  readonly stripe: Stripe;

  constructor(
    secretKey: string,
    private readonly priceId: string,
    private readonly portalConfigurationId: string,
    private readonly webhookSecret: string,
    client?: Stripe,
  ) {
    this.stripe = client ?? new Stripe(secretKey, { maxNetworkRetries: 2 });
  }

  async validateConfiguration(): Promise<void> {
    const [price, portal] = await Promise.all([
      this.stripe.prices.retrieve(this.priceId),
      this.stripe.billingPortal.configurations.retrieve(this.portalConfigurationId),
    ]);
    const recurring = price.recurring;
    if (
      !price.active ||
      price.type !== "recurring" ||
      price.currency !== "usd" ||
      price.unit_amount !== 1_000 ||
      recurring?.interval !== "month" ||
      recurring.usage_type !== "licensed"
    ) {
      throw new Error("Stripe Pro price must be active, licensed, monthly USD at exactly 1000 cents");
    }
    if (
      !portal.features.payment_method_update.enabled ||
      !portal.features.invoice_history.enabled ||
      !portal.features.subscription_cancel.enabled ||
      portal.features.subscription_cancel.mode !== "at_period_end"
    ) {
      throw new Error(
        "Stripe portal configuration must allow payment methods, invoice history, and cancellation at period end",
      );
    }
    if (portal.features.subscription_update.enabled) {
      throw new Error("Stripe portal configuration must disable plan, promotion, and quantity updates");
    }
  }

  async createCustomer(orgId: string, name: string, idempotencyKey: string): Promise<string> {
    const customer = await this.stripe.customers.create({ name, metadata: { companion_org_id: orgId } }, { idempotencyKey });
    return customer.id;
  }

  async findCurrentSubscription(customerId: string): Promise<BillingSubscriptionSnapshot | null> {
    const subscriptions = await this.stripe.subscriptions.list({ customer: customerId, status: "all", limit: 100 });
    const current = subscriptions.data.find(
      (subscription) =>
        !["canceled", "incomplete_expired"].includes(subscription.status) &&
        subscription.items.data.some((item) => item.price.id === this.priceId),
    );
    return current ? subscriptionSnapshot(current) : null;
  }

  async retrieveSubscription(subscriptionId: string): Promise<BillingSubscriptionSnapshot> {
    return subscriptionSnapshot(await this.stripe.subscriptions.retrieve(subscriptionId));
  }

  async retrieveCheckoutSession(sessionId: string): Promise<CheckoutSessionSnapshot> {
    const session = await this.stripe.checkout.sessions.retrieve(sessionId);
    return {
      id: session.id,
      url: session.url,
      expiresAt: new Date(session.expires_at * 1_000),
      status: session.status ?? "expired",
    };
  }

  async createCheckoutSession(input: {
    orgId: string;
    customerId: string;
    quantity: number;
    successUrl: string;
    cancelUrl: string;
    idempotencyKey: string;
  }): Promise<CheckoutSessionSnapshot> {
    const session = await this.stripe.checkout.sessions.create(
      {
        mode: "subscription",
        customer: input.customerId,
        client_reference_id: input.orgId,
        line_items: [{ price: this.priceId, quantity: Math.max(1, input.quantity) }],
        automatic_tax: { enabled: true },
        billing_address_collection: "required",
        customer_update: { address: "auto", name: "auto" },
        tax_id_collection: { enabled: true },
        allow_promotion_codes: true,
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
        metadata: { companion_org_id: input.orgId },
        subscription_data: { metadata: { companion_org_id: input.orgId } },
      },
      { idempotencyKey: input.idempotencyKey },
    );
    if (!session.url) throw new Error("Stripe Checkout did not return a URL");
    return { id: session.id, url: session.url, expiresAt: new Date(session.expires_at * 1_000), status: session.status ?? "open" };
  }

  async createPortalSession(input: { customerId: string; returnUrl: string }): Promise<string> {
    const session = await this.stripe.billingPortal.sessions.create({
      customer: input.customerId,
      configuration: this.portalConfigurationId,
      return_url: input.returnUrl,
    });
    return session.url;
  }

  async retrieveBillingPreview(input: {
    customerId: string;
    subscriptionId: string;
  }): Promise<BillingPreviewSnapshot> {
    const [subscription, customer, invoices] = await Promise.all([
      this.stripe.subscriptions.retrieve(input.subscriptionId, {
        expand: ["default_payment_method", "default_source"],
      }),
      this.stripe.customers.retrieve(input.customerId, {
        expand: ["invoice_settings.default_payment_method", "default_source"],
      }),
      this.stripe.invoices.list({
        customer: input.customerId,
        subscription: input.subscriptionId,
        limit: 100,
      }),
    ]);
    const activeCustomer = "deleted" in customer && customer.deleted ? null : (customer as Stripe.Customer);
    const paymentInstrument = subscription.default_payment_method
      ? { kind: "payment_method" as const, value: subscription.default_payment_method }
      : subscription.default_source
        ? { kind: "source" as const, value: subscription.default_source }
        : activeCustomer?.invoice_settings.default_payment_method
          ? { kind: "payment_method" as const, value: activeCustomer.invoice_settings.default_payment_method }
          : activeCustomer?.default_source
            ? { kind: "source" as const, value: activeCustomer.default_source }
            : null;
    const paymentMethod = paymentInstrument?.kind === "payment_method"
      ? typeof paymentInstrument.value === "string"
        ? await this.stripe.paymentMethods.retrieve(paymentInstrument.value)
        : paymentInstrument.value
      : null;
    const source = paymentInstrument?.kind === "source"
      ? typeof paymentInstrument.value === "string"
        ? await this.stripe.customers.retrieveSource(input.customerId, paymentInstrument.value)
        : paymentInstrument.value
      : null;
    let invoicePage = invoices;
    let invoice = invoicePage.data.find(
      (candidate): candidate is Stripe.Invoice & { status: BillingInvoiceSnapshot["status"] } =>
        candidate.status !== null && candidate.status !== "draft",
    );
    while (!invoice && invoicePage.has_more) {
      const lastInvoice = invoicePage.data.at(-1);
      if (!lastInvoice) break;
      invoicePage = await this.stripe.invoices.list({
        customer: input.customerId,
        subscription: input.subscriptionId,
        limit: 100,
        starting_after: lastInvoice.id,
      });
      invoice = invoicePage.data.find(
        (candidate): candidate is Stripe.Invoice & { status: BillingInvoiceSnapshot["status"] } =>
          candidate.status !== null && candidate.status !== "draft",
      );
    }
    return {
      paymentMethod: paymentMethodSnapshot(paymentMethod) ?? customerSourceSnapshot(source),
      latestInvoice: invoice
        ? {
            number: invoice.number,
            createdAt: new Date(invoice.created * 1_000),
            amountDue: invoice.amount_due,
            currency: invoice.currency,
            status: invoice.status,
            hostedInvoiceUrl: invoice.hosted_invoice_url ?? null,
          }
        : null,
    };
  }

  async updateSeatQuantity(input: {
    subscriptionId: string;
    itemId: string;
    quantity: number;
    idempotencyKey: string;
  }): Promise<BillingSubscriptionSnapshot> {
    const subscription = await this.stripe.subscriptions.update(
      input.subscriptionId,
      {
        items: [{ id: input.itemId, quantity: Math.max(1, input.quantity) }],
        proration_behavior: "create_prorations",
      },
      { idempotencyKey: input.idempotencyKey },
    );
    return subscriptionSnapshot(subscription);
  }

  constructWebhookEvent(rawBody: string | Buffer, signature: string): Stripe.Event {
    return this.stripe.webhooks.constructEvent(rawBody, signature, this.webhookSecret);
  }
}
