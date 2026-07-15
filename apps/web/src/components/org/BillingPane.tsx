"use client";

import { Icon } from "../Icon";
import { PaneHead } from "./paneKit";
import type { OrgCtx } from "./model";

function money(cents: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(cents / 100);
}

function date(value: string | null, timeZone?: string): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeZone }).format(new Date(value));
}

function statusLabel(value: string | null): string {
  if (!value) return "No subscription";
  return value.replaceAll("_", " ").replace(/^./, (letter) => letter.toUpperCase());
}

export function BillingPane({ ctx }: { ctx: OrgCtx }) {
  const billing = ctx.billing;
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
  if (!billing.billingEnabled) {
    return (
      <div className="sx-pane">
        <PaneHead
          title="Billing"
          desc="This self-hosted workspace does not use Companion-managed billing."
          action={<span className="badge badge--ok">Pro included</span>}
        />
        <div className="sx-sec">
          <h2 className="sx-sec__h">Plan</h2>
          <p className="sx-sec__d">All product entitlements are enabled without Stripe or a Companion subscription.</p>
          <div className="sx-defs">
            <div className="sx-def"><span className="sx-def__k">Current plan</span><span className="sx-def__v"><b>Pro</b></span></div>
            <div className="sx-def"><span className="sx-def__k">Billing provider</span><span className="sx-def__v">Self-hosted</span></div>
            <div className="sx-def"><span className="sx-def__k">Subscription</span><span className="sx-def__v">Not required</span></div>
          </div>
        </div>
      </div>
    );
  }
  const plan = billing.entitlements.computedPlan;
  const delinquent = billing.stripeStatus === "past_due" || billing.stripeStatus === "unpaid";

  return (
    <div className="sx-pane">
      <PaneHead
        title="Billing"
        desc="Your Pro subscription is billed monthly for each active workspace member. Stripe applies prorations when seats change."
        action={<span className={"badge " + (plan === "pro" ? "badge--accent" : "")}>{plan === "pro" ? "Pro" : "Free"}</span>}
      />

      {delinquent && billing.graceEndsAt && (
        <div className="og-lockbar sx-billing-alert" role="status">
          <Icon name="alert-triangle" size={14} />
          Payment needs attention. Pro remains available through {date(billing.graceEndsAt)}; this grace period does not renew.
        </div>
      )}
      {billing.cancelAtPeriodEnd && (
        <div className="sx-readline sx-billing-alert">
          <Icon name="calendar-x" size={14} />
          Pro is scheduled to end on {date(billing.currentPeriodEnd)}.
        </div>
      )}

      <div className="sx-sec">
        <h2 className="sx-sec__h">Subscription</h2>
        <p className="sx-sec__d">Pro costs $10 USD per active member each month, before tax.</p>
        <div className="sx-defs">
          <div className="sx-def"><span className="sx-def__k">Current plan</span><span className="sx-def__v"><b>{plan === "pro" ? "Pro" : "Free"}</b></span></div>
          <div className="sx-def"><span className="sx-def__k">Price</span><span className="sx-def__v">{money(billing.unitAmount)} / seat / month</span></div>
          <div className="sx-def"><span className="sx-def__k">Active seats</span><span className="sx-def__v">{billing.activeSeats}</span></div>
          <div className="sx-def"><span className="sx-def__k">Estimated subtotal</span><span className="sx-def__v"><b>{money(billing.estimatedMonthlySubtotal)} / month</b><span className="badge">before tax</span></span></div>
          <div className="sx-def"><span className="sx-def__k">Payment status</span><span className="sx-def__v">{statusLabel(billing.stripeStatus)}</span></div>
          <div className="sx-def"><span className="sx-def__k">Next renewal</span><span className="sx-def__v">{billing.cancelAtPeriodEnd ? "Will not renew" : date(billing.currentPeriodEnd)}</span></div>
        </div>
      </div>

      <div className="sx-sec">
        <h2 className="sx-sec__h">Seat synchronization</h2>
        <p className="sx-sec__d">Membership changes are sent to Stripe automatically with prorations.</p>
        <div className="sx-defs">
          <div className="sx-def"><span className="sx-def__k">Status</span><span className="sx-def__v"><span className={"badge " + (billing.seatSyncStatus === "synced" ? "badge--ok" : billing.seatSyncStatus === "error" ? "badge--warn" : "")}>{statusLabel(billing.seatSyncStatus)}</span></span></div>
          <div className="sx-def"><span className="sx-def__k">Confirmed by Stripe</span><span className="sx-def__v">{billing.syncedSeats ?? "—"} seats</span></div>
        </div>
        {billing.lastError && <p className="sx-field__hint sx-field__hint--error" role="status">Seat sync is retrying automatically.</p>}
      </div>

      <div className="sx-sec">
        <h2 className="sx-sec__h">Sandbox usage</h2>
        <p className="sx-sec__d">
          Pro includes a shared monthly pool of {billing.sandboxUsage.minutes_per_seat} minutes per active seat. New sandbox work is blocked when the pool is exhausted.
        </p>
        <div className="sx-defs">
          <div className="sx-def"><span className="sx-def__k">Used</span><span className="sx-def__v"><b>{billing.sandboxUsage.used_minutes} min</b></span></div>
          <div className="sx-def"><span className="sx-def__k">Reserved by active runs</span><span className="sx-def__v">{billing.sandboxUsage.reserved_minutes} min</span></div>
          <div className="sx-def"><span className="sx-def__k">Remaining</span><span className="sx-def__v"><b>{billing.sandboxUsage.remaining_minutes ?? "Unlimited"}{billing.sandboxUsage.remaining_minutes === null ? "" : " min"}</b></span></div>
          <div className="sx-def"><span className="sx-def__k">Monthly pool</span><span className="sx-def__v">{billing.sandboxUsage.limit_minutes ?? "Unlimited"}{billing.sandboxUsage.limit_minutes === null ? "" : " min"}</span></div>
          <div className="sx-def"><span className="sx-def__k">Resets</span><span className="sx-def__v">{date(billing.sandboxUsage.period_end, "UTC")}</span></div>
        </div>
      </div>

      {plan === "free" && (
        <div className="sx-sec">
          <h2 className="sx-sec__h">Free plan usage</h2>
          <div className="sx-defs">
            <div className="sx-def"><span className="sx-def__k">Organization skills</span><span className="sx-def__v">{billing.orgSkillCount} / {billing.entitlements.orgSkillLimit ?? 20}</span></div>
            <div className="sx-def"><span className="sx-def__k">Preserved personal skills</span><span className="sx-def__v">{billing.hiddenPersonalSkillCount} hidden until Pro</span></div>
          </div>
        </div>
      )}

      <div className="sx-billing-actions">
        {billing.canManage ? (
          <>
            {billing.checkoutEnabled && plan === "free" && <button className="btn-primary" disabled={ctx.busy} onClick={() => void ctx.startCheckout()}><Icon name="credit-card" size={14} />Upgrade to Pro</button>}
            {billing.portalEnabled && <button className="btn-sec" disabled={ctx.busy} onClick={() => void ctx.openBillingPortal()}><Icon name="external-link" size={14} />Manage payment and invoices</button>}
          </>
        ) : (
          <div className="sx-readline"><Icon name="lock" size={14} />Contact a workspace owner or admin to manage billing.</div>
        )}
      </div>
    </div>
  );
}
