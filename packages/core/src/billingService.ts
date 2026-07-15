import { and, count, eq, sql } from "drizzle-orm";
import type { BillingGateway, BillingSubscriptionSnapshot } from "@companion/billing";
import { db, schema, type Db } from "@companion/db";
import { PAYMENT_GRACE_MS, billingRuntimeConfig } from "./billing";
import { listPreTenantBillingSyncCandidates, resolvePreTenantBillingOrganization } from "./preTenant";

const OPEN_STATUSES = new Set(["active", "past_due", "unpaid", "incomplete", "paused", "trialing"]);

function retryAt(attempts: number, now: Date): Date {
  return new Date(now.getTime() + Math.min(3_600, 30 * 2 ** Math.max(0, attempts - 1)) * 1_000);
}

async function withBillingTenantContext<T>(
  database: Db,
  orgId: string,
  fn: (tenantDatabase: Db) => Promise<T>,
): Promise<T> {
  return database.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Db;
    await tx.execute(
      sql`select set_config('app.org_id', ${orgId}, true), set_config('app.user_id', '', true)`,
    );
    return fn(tx);
  });
}

async function assertBillingManager(database: Db, actorId: string, orgId: string): Promise<void> {
  const membership = await database.query.memberships.findFirst({
    where: and(eq(schema.memberships.orgId, orgId), eq(schema.memberships.userId, actorId)),
  });
  if (!membership || !["owner", "admin"].includes(membership.orgRole)) {
    throw new Error("only organization owners and admins can manage billing");
  }
}

export async function persistSubscriptionSnapshot(input: {
  orgId: string;
  snapshot: BillingSubscriptionSnapshot;
  database?: Db;
  now?: Date;
  eventId?: string;
}): Promise<void> {
  const database = input.database ?? db;
  const now = input.now ?? new Date();
  const existing = await database.query.billingSubscriptions.findFirst({
    where: eq(schema.billingSubscriptions.orgId, input.orgId),
  });
  const isDelinquent = ["past_due", "unpaid"].includes(input.snapshot.status);
  const graceEndsAt = isDelinquent
    ? existing?.graceEndsAt ?? new Date(now.getTime() + PAYMENT_GRACE_MS)
    : null;
  const [seats] = await database
    .select({ value: count() })
    .from(schema.memberships)
    .where(eq(schema.memberships.orgId, input.orgId));
  const desiredQuantity = Math.max(1, Number(seats?.value ?? 0));
  const quantityMatches = input.snapshot.quantity === desiredQuantity;
  await database
    .insert(schema.billingSubscriptions)
    .values({
      orgId: input.orgId,
      stripeCustomerId: input.snapshot.customerId,
      stripeSubscriptionId: input.snapshot.subscriptionId,
      stripeSubscriptionItemId: input.snapshot.itemId,
      stripePriceId: input.snapshot.priceId,
      stripeStatus: input.snapshot.status,
      syncedQuantity: input.snapshot.quantity,
      currentPeriodStart: input.snapshot.currentPeriodStart,
      currentPeriodEnd: input.snapshot.currentPeriodEnd,
      cancelAtPeriodEnd: input.snapshot.cancelAtPeriodEnd,
      canceledAt: input.snapshot.canceledAt,
      graceEndsAt,
      lastStripeEventId: input.eventId,
      lastReconciledAt: now,
      seatSyncStatus: quantityMatches ? "synced" : "pending",
      seatSyncRequestedAt: quantityMatches ? null : now,
      nextRetryAt: quantityMatches ? null : now,
      seatSyncAttempts: quantityMatches ? 0 : existing?.seatSyncAttempts ?? 0,
    })
    .onConflictDoUpdate({
      target: schema.billingSubscriptions.orgId,
      set: {
        stripeCustomerId: input.snapshot.customerId,
        stripeSubscriptionId: input.snapshot.subscriptionId,
        stripeSubscriptionItemId: input.snapshot.itemId,
        stripePriceId: input.snapshot.priceId,
        stripeStatus: input.snapshot.status,
        syncedQuantity: input.snapshot.quantity,
        currentPeriodStart: input.snapshot.currentPeriodStart,
        currentPeriodEnd: input.snapshot.currentPeriodEnd,
        cancelAtPeriodEnd: input.snapshot.cancelAtPeriodEnd,
        canceledAt: input.snapshot.canceledAt,
        graceEndsAt,
        ...(input.eventId ? { lastStripeEventId: input.eventId } : {}),
        lastReconciledAt: now,
        seatSyncStatus: quantityMatches ? "synced" : "pending",
        seatSyncRequestedAt: quantityMatches ? null : now,
        nextRetryAt: quantityMatches ? null : now,
        seatSyncAttempts: quantityMatches ? 0 : existing?.seatSyncAttempts ?? 0,
        lastError: null,
        updatedAt: now,
      },
    });
}

export async function createBillingCheckout(input: {
  actorId: string;
  orgId: string;
  gateway: BillingGateway;
  appUrl: string;
  database?: Db;
}): Promise<{ url: string }> {
  const database = input.database ?? db;
  const config = billingRuntimeConfig();
  if (config.billingMode !== "stripe" || !config.checkoutEnabled) throw new Error("billing checkout is disabled");
  await assertBillingManager(database, input.actorId, input.orgId);
  await input.gateway.validateConfiguration();

  return database.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Db;
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`companion:billing-checkout:${input.orgId}`}))`);
    const org = await tx.query.organizations.findFirst({ where: eq(schema.organizations.id, input.orgId) });
    if (!org) throw new Error("organization not found");
    await tx.insert(schema.billingSubscriptions).values({ orgId: input.orgId }).onConflictDoNothing();
    let billing = await tx.query.billingSubscriptions.findFirst({ where: eq(schema.billingSubscriptions.orgId, input.orgId) });
    if (!billing) throw new Error("billing state unavailable");

    if (billing.checkoutSessionId && billing.checkoutExpiresAt && billing.checkoutExpiresAt > new Date()) {
      const checkout = await input.gateway.retrieveCheckoutSession(billing.checkoutSessionId);
      if (checkout.status === "open" && checkout.url) return { url: checkout.url };
    }

    let customerId = billing.stripeCustomerId;
    if (!customerId) {
      customerId = await input.gateway.createCustomer(input.orgId, org.name, `billing:customer:${input.orgId}`);
      await tx
        .update(schema.billingSubscriptions)
        .set({ stripeCustomerId: customerId, updatedAt: new Date() })
        .where(eq(schema.billingSubscriptions.orgId, input.orgId));
    }
    const current = await input.gateway.findCurrentSubscription(customerId);
    if (current && OPEN_STATUSES.has(current.status)) {
      await persistSubscriptionSnapshot({ orgId: input.orgId, snapshot: current, database: tx });
      throw new Error("this organization already has a Stripe subscription");
    }
    const [seatRow] = await tx
      .select({ value: count() })
      .from(schema.memberships)
      .where(eq(schema.memberships.orgId, input.orgId));
    const generation = billing.checkoutGeneration + 1;
    const checkout = await input.gateway.createCheckoutSession({
      orgId: input.orgId,
      customerId,
      quantity: Math.max(1, Number(seatRow?.value ?? 0)),
      successUrl: `${input.appUrl}/settings?view=billing&checkout=success`,
      cancelUrl: `${input.appUrl}/settings?view=billing&checkout=cancelled`,
      idempotencyKey: `billing:checkout:${input.orgId}:${generation}`,
    });
    if (!checkout.url) throw new Error("Stripe Checkout URL unavailable");
    await tx
      .update(schema.billingSubscriptions)
      .set({
        checkoutSessionId: checkout.id,
        checkoutExpiresAt: checkout.expiresAt,
        checkoutGeneration: generation,
        updatedAt: new Date(),
      })
      .where(eq(schema.billingSubscriptions.orgId, input.orgId));
    return { url: checkout.url };
  });
}

export async function createBillingPortal(input: {
  actorId: string;
  orgId: string;
  gateway: BillingGateway;
  appUrl: string;
  database?: Db;
}): Promise<{ url: string }> {
  const database = input.database ?? db;
  await assertBillingManager(database, input.actorId, input.orgId);
  await input.gateway.validateConfiguration();
  const billing = await database.query.billingSubscriptions.findFirst({
    where: eq(schema.billingSubscriptions.orgId, input.orgId),
  });
  if (!billing?.stripeCustomerId) throw new Error("no Stripe customer exists for this organization");
  return { url: await input.gateway.createPortalSession({ customerId: billing.stripeCustomerId, returnUrl: `${input.appUrl}/settings?view=billing` }) };
}

export async function processStripeWebhook(input: {
  eventId: string;
  eventType: string;
  subscriptionId?: string | null;
  customerId?: string | null;
  gateway: BillingGateway;
  database?: Db;
}): Promise<"processed" | "duplicate" | "ignored"> {
  const database = input.database ?? db;
  // A new Checkout subscription is not linked in our row yet: Stripe's first event already carries
  // the subscription id, while our durable correlation key is still the Customer id. Try both so
  // checkout.session.completed and customer.subscription.created can bootstrap the relationship.
  const orgId = await resolvePreTenantBillingOrganization(database, {
    subscriptionId: input.subscriptionId,
    customerId: input.customerId,
  });
  if (!orgId) return "ignored";

  const outcome = await withBillingTenantContext(database, orgId, async (tenantDatabase) => {
    const billing = await tenantDatabase.query.billingSubscriptions.findFirst({
      where: eq(schema.billingSubscriptions.orgId, orgId),
    });
    if (!billing) return { result: "ignored" as const };
    const [inserted] = await tenantDatabase
      .insert(schema.stripeWebhookEvents)
      .values({ eventId: input.eventId, orgId, eventType: input.eventType })
      .onConflictDoNothing()
      .returning({ eventId: schema.stripeWebhookEvents.eventId });
    if (!inserted) {
      const [reclaimed] = await tenantDatabase
        .update(schema.stripeWebhookEvents)
        .set({ status: "processing", error: null })
        .where(and(eq(schema.stripeWebhookEvents.eventId, input.eventId), eq(schema.stripeWebhookEvents.status, "failed")))
        .returning({ eventId: schema.stripeWebhookEvents.eventId });
      if (!reclaimed) return { result: "duplicate" as const };
    }
    try {
      const subscriptionId = input.subscriptionId ?? billing.stripeSubscriptionId;
      const snapshot = subscriptionId
        ? await input.gateway.retrieveSubscription(subscriptionId)
        : billing.stripeCustomerId
          ? await input.gateway.findCurrentSubscription(billing.stripeCustomerId)
          : null;
      if (snapshot) {
        await persistSubscriptionSnapshot({ orgId, snapshot, database: tenantDatabase, eventId: input.eventId });
      }
      await tenantDatabase.insert(schema.auditLog).values({
        orgId,
        actorId: null,
        action: "billing.webhook_reconciled",
        targetType: "organization",
        targetId: orgId,
        metadata: { eventType: input.eventType, status: snapshot?.status ?? null },
      });
      await tenantDatabase
        .update(schema.stripeWebhookEvents)
        .set({ status: "processed", processedAt: new Date(), error: null })
        .where(eq(schema.stripeWebhookEvents.eventId, input.eventId));
      return { result: "processed" as const };
    } catch (error) {
      await tenantDatabase
        .update(schema.stripeWebhookEvents)
        .set({ status: "failed", error: error instanceof Error ? error.message.slice(0, 500) : "Stripe reconciliation failed" })
        .where(eq(schema.stripeWebhookEvents.eventId, input.eventId));
      return { error };
    }
  });
  if ("error" in outcome) throw outcome.error;
  return outcome.result;
}

export async function reconcileSeatQuantity(input: {
  orgId: string;
  gateway: BillingGateway;
  database?: Db;
  now?: Date;
}): Promise<void> {
  const database = input.database ?? db;
  const now = input.now ?? new Date();
  const outcome = await withBillingTenantContext(database, input.orgId, async (tenantDatabase) => {
    const billing = await tenantDatabase.query.billingSubscriptions.findFirst({
      where: eq(schema.billingSubscriptions.orgId, input.orgId),
    });
    if (!billing?.stripeSubscriptionId || !billing.stripeSubscriptionItemId) return {};
    const [seatRow] = await tenantDatabase
      .select({ value: count() })
      .from(schema.memberships)
      .where(eq(schema.memberships.orgId, input.orgId));
    const quantity = Math.max(1, Number(seatRow?.value ?? 0));
    try {
      const quantityChanged = billing.syncedQuantity !== quantity;
      const snapshot = !quantityChanged
        ? await input.gateway.retrieveSubscription(billing.stripeSubscriptionId)
        : await input.gateway.updateSeatQuantity({
            subscriptionId: billing.stripeSubscriptionId,
            itemId: billing.stripeSubscriptionItemId,
            quantity,
            idempotencyKey: `billing:seats:${input.orgId}:${quantity}:${billing.seatSyncRequestedAt?.getTime() ?? 0}`,
          });
      await persistSubscriptionSnapshot({ orgId: input.orgId, snapshot, database: tenantDatabase, now });
      if (quantityChanged) {
        await tenantDatabase.insert(schema.auditLog).values({
          orgId: input.orgId,
          actorId: null,
          action: "billing.seats_synced",
          targetType: "organization",
          targetId: input.orgId,
          metadata: { quantity },
        });
      }
      return {};
    } catch (error) {
      const attempts = billing.seatSyncAttempts + 1;
      await tenantDatabase
        .update(schema.billingSubscriptions)
        .set({
          seatSyncStatus: "error",
          seatSyncAttempts: attempts,
          nextRetryAt: retryAt(attempts, now),
          lastError: error instanceof Error ? error.message.slice(0, 500) : "Stripe seat synchronization failed",
          lastErrorAt: now,
          updatedAt: now,
        })
        .where(eq(schema.billingSubscriptions.orgId, input.orgId));
      await tenantDatabase.insert(schema.auditLog).values({
        orgId: input.orgId,
        actorId: null,
        action: "billing.seat_sync_failed",
        targetType: "organization",
        targetId: input.orgId,
        metadata: { attempts, retryAt: retryAt(attempts, now).toISOString() },
      });
      return { error };
    }
  });
  if ("error" in outcome) throw outcome.error;
}

export async function listSeatSyncCandidates(input: { database?: Db; now?: Date; full?: boolean; limit?: number } = {}): Promise<string[]> {
  const database = input.database ?? db;
  const now = input.now ?? new Date();
  const limit = input.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error("billing candidate limit must be between 1 and 500");
  return listPreTenantBillingSyncCandidates(database, { now, full: input.full ?? false, limit });
}
