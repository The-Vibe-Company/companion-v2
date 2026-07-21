"use client";

import { useEffect, useState } from "react";
import type { BillingPreview } from "@companion/contracts";
import { fetchBillingPreview } from "@/lib/org";
import { Icon } from "../Icon";
import { PaneHead } from "./paneKit";
import type { OrgCtx } from "./model";

type PreviewState =
  | { status: "idle"; orgId: null; data: null }
  | { status: "loading"; orgId: string; data: null }
  | { status: "ready"; orgId: string; data: BillingPreview }
  | { status: "error"; orgId: string; data: null };

function money(cents: number, currency = "usd"): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
    maximumFractionDigits: 2,
  }).format(cents / 100);
}

function date(value: string | null, timeZone?: string): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone }).format(new Date(value));
}

function statusLabel(value: string | null): string {
  if (!value) return "No subscription";
  return value.replaceAll("_", " ").replace(/^./, (letter) => letter.toUpperCase());
}

function statusClass(value: string | null): string {
  if (["active", "paid", "synced"].includes(value ?? "")) return "badge--ok";
  if (["past_due", "unpaid", "uncollectible", "error"].includes(value ?? "")) return "badge--warn";
  return "";
}

function paymentMethodLabel(preview: BillingPreview["paymentMethod"]): string {
  if (!preview) return "No payment method on file";
  const type = preview.brand ?? preview.type.replaceAll("_", " ");
  return `${type.replace(/^./, (letter) => letter.toUpperCase())}${preview.last4 ? ` •••• ${preview.last4}` : ""}`;
}

function paymentMethodExpiry(preview: BillingPreview["paymentMethod"]): string | null {
  if (!preview?.expMonth || !preview.expYear) return null;
  return `Expires ${String(preview.expMonth).padStart(2, "0")}/${preview.expYear}`;
}

function LedgerRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="sx-billing-ledger__row">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function BillingPreviewRows({
  state,
  onRetry,
}: {
  state: PreviewState;
  onRetry: () => void;
}) {
  if (state.status === "loading" || state.status === "idle") {
    return (
      <div className="sx-billing-preview-skeleton" role="status" aria-label="Loading payment details">
        <span />
        <span />
      </div>
    );
  }
  if (state.status === "error") {
    return (
      <div className="sx-billing-preview-error" role="status">
        <Icon name="alert-triangle" size={14} />
        <span>Payment details are temporarily unavailable. Your subscription is unaffected.</span>
        <button type="button" className="btn-sec" onClick={onRetry}>Try again</button>
      </div>
    );
  }
  const { paymentMethod, latestInvoice } = state.data;
  const invoiceContent = latestInvoice ? (
    <span className="sx-billing-invoice">
      <span>
        <b>{money(latestInvoice.amountDue, latestInvoice.currency)}</b>
        <span>{latestInvoice.number ?? "Stripe invoice"} · {date(latestInvoice.createdAt)}</span>
      </span>
      <span className={`badge ${statusClass(latestInvoice.status)}`}>{statusLabel(latestInvoice.status)}</span>
      {latestInvoice.hostedInvoiceUrl && <Icon name="external-link" size={13} />}
    </span>
  ) : (
    <span className="sx-billing-empty-value">No finalized invoice yet</span>
  );
  return (
    <dl className="sx-billing-ledger">
      <LedgerRow label="Payment method">
        <span className="sx-billing-payment-method">
          <Icon name="credit-card" size={14} />
          <span>
            <b>{paymentMethodLabel(paymentMethod)}</b>
            {paymentMethodExpiry(paymentMethod) && <span>{paymentMethodExpiry(paymentMethod)}</span>}
          </span>
        </span>
      </LedgerRow>
      <LedgerRow label="Latest invoice">
        {latestInvoice?.hostedInvoiceUrl ? (
          <a
            className="sx-billing-invoice-link"
            href={latestInvoice.hostedInvoiceUrl}
            target="_blank"
            rel="noreferrer"
            aria-label={`Open invoice ${latestInvoice.number ?? "in Stripe"}`}
          >
            {invoiceContent}
          </a>
        ) : invoiceContent}
      </LedgerRow>
    </dl>
  );
}

export function BillingPane({ ctx }: { ctx: OrgCtx }) {
  const billing = ctx.billing;
  const shouldLoadPreview = !!billing?.billingEnabled && !!billing.canManage && !!billing.portalEnabled;
  const [previewState, setPreviewState] = useState<PreviewState>({ status: "idle", orgId: null, data: null });
  const [previewRequest, setPreviewRequest] = useState(0);
  const visiblePreviewState: PreviewState = previewState.orgId === ctx.currentOrg.id
    ? previewState
    : { status: "loading", orgId: ctx.currentOrg.id, data: null };

  useEffect(() => {
    if (!shouldLoadPreview) return;
    let active = true;
    setPreviewState({ status: "loading", orgId: ctx.currentOrg.id, data: null });
    void fetchBillingPreview(ctx.currentOrg.id)
      .then((data) => {
        if (active) setPreviewState({ status: "ready", orgId: ctx.currentOrg.id, data });
      })
      .catch(() => {
        if (active) setPreviewState({ status: "error", orgId: ctx.currentOrg.id, data: null });
      });
    return () => {
      active = false;
    };
  }, [ctx.currentOrg.id, previewRequest, shouldLoadPreview]);

  if (!billing) {
    return (
      <div className="sx-pane">
        <PaneHead title="Billing" desc="Billing status is temporarily unavailable for this workspace." />
        <div className="sx-readline" role="status">
          <Icon name="alert-triangle" size={14} />
          Refresh the page to try again.
        </div>
      </div>
    );
  }

  const plan = billing.entitlements.computedPlan;
  const delinquent = billing.stripeStatus === "past_due" || billing.stripeStatus === "unpaid";
  const usage = billing.sandboxUsage;
  const committedMinutes = usage.used_minutes + usage.reserved_minutes;
  const usagePercent = usage.limit_minutes === null || usage.limit_minutes === 0
    ? null
    : Math.min(100, Math.round((committedMinutes / usage.limit_minutes) * 100));
  const renewal = !billing.billingEnabled
    ? "Not required"
    : billing.cancelAtPeriodEnd
      ? "Will not renew"
      : date(billing.currentPeriodEnd);
  const summaryAmount = !billing.billingEnabled
    ? "Included"
    : plan === "pro"
      ? `${money(billing.estimatedMonthlySubtotal)} / month`
      : "$0 / month";

  return (
    <div className="sx-pane sx-pane--billing">
      <PaneHead
        title="Billing"
        desc={billing.billingEnabled
          ? "Review your plan, workspace seats, usage, and Stripe billing details."
          : "This self-hosted workspace includes every Pro entitlement without managed billing."}
        action={<span className={`badge ${plan === "pro" ? "badge--accent" : ""}`}>{billing.billingEnabled ? (plan === "pro" ? "Pro" : "Free") : "Pro included"}</span>}
      />

      {delinquent && billing.graceEndsAt && (
        <div className="og-lockbar sx-billing-alert" role="status">
          <Icon name="alert-triangle" size={14} />
          Payment needs attention. Pro remains available through {date(billing.graceEndsAt)}; this grace period does not renew.
        </div>
      )}
      {billing.cancelAtPeriodEnd && (
        <div className="sx-readline sx-billing-alert" role="status">
          <Icon name="calendar-x" size={14} />
          Pro is scheduled to end on {date(billing.currentPeriodEnd)}.
        </div>
      )}

      <section className="sx-billing-summary" aria-label="Billing summary">
        <div className="sx-billing-summary__item">
          <span>Current plan</span>
          <b>{billing.billingEnabled ? (plan === "pro" ? "Pro" : "Free") : "Pro"}</b>
          <small>{billing.billingEnabled ? statusLabel(billing.stripeStatus) : "Self-hosted"}</small>
        </div>
        <div className="sx-billing-summary__item">
          <span>Estimated subtotal</span>
          <b>{summaryAmount}</b>
          <small>{billing.billingEnabled && plan === "pro" ? "Before tax" : "No managed charge"}</small>
        </div>
        <div className="sx-billing-summary__item">
          <span>Active seats</span>
          <b>{billing.activeSeats}</b>
          <small>{billing.billingEnabled ? `${money(billing.unitAmount)} each` : "All members included"}</small>
        </div>
        <div className="sx-billing-summary__item">
          <span>Next renewal</span>
          <b>{renewal}</b>
          <small>{billing.cancelAtPeriodEnd ? "Cancellation scheduled" : billing.billingEnabled ? "Monthly" : "No subscription"}</small>
        </div>
        {billing.canManage && (billing.portalEnabled || (billing.checkoutEnabled && plan === "free")) && (
          <div className="sx-billing-summary__action">
            {billing.portalEnabled && (
              <button className="btn-primary" disabled={ctx.busy} onClick={() => void ctx.openBillingPortal()}>
                Manage billing<Icon name="external-link" size={13} />
              </button>
            )}
            {billing.checkoutEnabled && plan === "free" && (
              <button className="btn-sec" disabled={ctx.busy} onClick={() => void ctx.startCheckout()}>
                <Icon name="credit-card" size={14} />Upgrade to Pro
              </button>
            )}
          </div>
        )}
      </section>

      <section className="sx-billing-usage" aria-labelledby="billing-usage-title">
        <div className="sx-billing-usage__head">
          <span>
            <b id="billing-usage-title">Sandbox usage</b>
            <small>
              {usage.limit_minutes === null
                ? "Unlimited in this workspace"
                : `${usage.used_minutes} min used${usage.reserved_minutes ? ` · ${usage.reserved_minutes} min reserved` : ""}`}
            </small>
          </span>
          <span className="sx-billing-usage__value">
            <b>{usage.remaining_minutes === null ? "Unlimited" : `${usage.remaining_minutes} min remaining`}</b>
            <small>Resets {date(usage.period_end, "UTC")}</small>
          </span>
        </div>
        {usagePercent !== null && (
          <div
            className="sx-billing-meter"
            role="progressbar"
            aria-label="Sandbox minutes used or reserved"
            aria-valuemin={0}
            aria-valuemax={usage.limit_minutes ?? undefined}
            aria-valuenow={Math.min(committedMinutes, usage.limit_minutes ?? committedMinutes)}
            aria-valuetext={`${committedMinutes} of ${usage.limit_minutes} minutes used or reserved`}
          >
            <span style={{ width: `${usagePercent}%` }} />
          </div>
        )}
        {usage.enforced && usage.limit_minutes !== null && (
          <p className="sx-billing-usage__note">New sandbox work is blocked when the monthly pool is exhausted.</p>
        )}
      </section>

      <section className="sx-billing-section" aria-labelledby="billing-subscription-title">
        <div className="sx-billing-section__head">
          <h2 id="billing-subscription-title">Subscription</h2>
          <p>{billing.billingEnabled ? "Monthly billing follows active workspace membership." : "Managed billing is disabled for this installation."}</p>
        </div>
        <dl className="sx-billing-ledger">
          <LedgerRow label="Unit price">{billing.billingEnabled ? `${money(billing.unitAmount)} / seat / month` : "Included"}</LedgerRow>
          <LedgerRow label="Payment status">
            <span className={`badge ${statusClass(billing.stripeStatus)}`}>{billing.billingEnabled ? statusLabel(billing.stripeStatus) : "Not required"}</span>
          </LedgerRow>
          <LedgerRow label="Renewal">{renewal}</LedgerRow>
        </dl>
      </section>

      <section className="sx-billing-section" aria-labelledby="billing-seats-title">
        <div className="sx-billing-section__head">
          <h2 id="billing-seats-title">Seat synchronization</h2>
          <p>{billing.billingEnabled ? "Membership changes are sent to Stripe automatically with prorations." : "Seat synchronization does not apply to self-hosted workspaces."}</p>
        </div>
        <dl className="sx-billing-ledger">
          <LedgerRow label="Status">
            <span className={`badge ${statusClass(billing.seatSyncStatus)}`}>{statusLabel(billing.seatSyncStatus)}</span>
          </LedgerRow>
          <LedgerRow label="Active in Companion">{billing.activeSeats} seats</LedgerRow>
          <LedgerRow label="Confirmed by Stripe">{billing.billingEnabled ? `${billing.syncedSeats ?? "—"} seats` : "Not applicable"}</LedgerRow>
        </dl>
        {billing.lastError && <p className="sx-field__hint sx-field__hint--error" role="status">Seat sync is retrying automatically.</p>}
      </section>

      {plan === "free" && (
        <section className="sx-billing-section" aria-labelledby="billing-free-title">
          <div className="sx-billing-section__head">
            <h2 id="billing-free-title">Free plan limits</h2>
            <p>Existing data is preserved when a Pro entitlement is unavailable.</p>
          </div>
          <dl className="sx-billing-ledger">
            <LedgerRow label="Organization skills">{billing.orgSkillCount} / {billing.entitlements.orgSkillLimit ?? 20}</LedgerRow>
            <LedgerRow label="Personal skills">{billing.hiddenPersonalSkillCount} hidden until Pro</LedgerRow>
          </dl>
        </section>
      )}

      {billing.billingEnabled && (
        <section className="sx-billing-section" aria-labelledby="billing-details-title">
          <div className="sx-billing-section__head">
            <h2 id="billing-details-title">Invoices and payment</h2>
            <p>Companion shows a sanitized preview. Stripe remains the source of truth.</p>
          </div>
          {billing.canManage ? (
            billing.portalEnabled ? (
              <BillingPreviewRows state={visiblePreviewState} onRetry={() => setPreviewRequest((request) => request + 1)} />
            ) : (
              <div className="sx-readline"><Icon name="info" size={14} />Payment details will appear after a subscription starts.</div>
            )
          ) : (
            <div className="sx-readline"><Icon name="lock" size={14} />Only workspace owners and admins can view payment details and invoices.</div>
          )}
        </section>
      )}
    </div>
  );
}
