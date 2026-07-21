// @vitest-environment happy-dom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BillingOverview, BillingPreview } from "@companion/contracts";
import type { OrgCtx } from "./model";

const effectMocks = vi.hoisted(() => ({ suppress: false }));
const billingMocks = vi.hoisted(() => ({ fetchBillingPreview: vi.fn() }));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useEffect: (
      effect: Parameters<typeof actual.useEffect>[0],
      dependencies: Parameters<typeof actual.useEffect>[1],
    ) => actual.useEffect(effectMocks.suppress ? () => undefined : effect, dependencies),
  };
});
vi.mock("@/lib/org", () => ({ fetchBillingPreview: billingMocks.fetchBillingPreview }));

import { BillingPane } from "./BillingPane";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];

const managedBilling: BillingOverview = {
  billingEnabled: true,
  canManage: true,
  entitlements: {
    effectivePlan: "pro",
    computedPlan: "pro",
    billingMode: "stripe",
    entitlementMode: "enforce",
    enforced: true,
    personalSkills: true,
    skillHistory: true,
    orgSkillLimit: null,
    catalogFrozen: false,
  },
  unitAmount: 1_000,
  currency: "usd",
  interval: "month",
  activeSeats: 4,
  syncedSeats: 4,
  estimatedMonthlySubtotal: 4_000,
  stripeStatus: "active",
  seatSyncStatus: "synced",
  currentPeriodEnd: "2026-08-21T00:00:00.000Z",
  cancelAtPeriodEnd: false,
  graceEndsAt: null,
  nextReconcileAt: null,
  lastError: null,
  orgSkillCount: 4,
  hiddenPersonalSkillCount: 0,
  sandboxUsage: {
    enabled: true,
    enforced: true,
    limit_minutes: 1_000,
    used_minutes: 620,
    reserved_minutes: 10,
    remaining_minutes: 370,
    minutes_per_seat: 250,
    period_start: "2026-07-01T00:00:00.000Z",
    period_end: "2026-08-01T00:00:00.000Z",
  },
  checkoutEnabled: false,
  portalEnabled: true,
};

const preview: BillingPreview = {
  paymentMethod: { type: "card", brand: "visa", last4: "4242", expMonth: 8, expYear: 2030 },
  latestInvoice: {
    number: "INV-0042",
    createdAt: "2026-07-21T10:00:00.000Z",
    amountDue: 4_000,
    currency: "usd",
    status: "paid",
    hostedInvoiceUrl: "https://invoice.stripe.test/in_1",
  },
};

function context(billing: BillingOverview = managedBilling): OrgCtx {
  return {
    currentOrg: { id: "org-1" },
    billing,
    busy: false,
    startCheckout: vi.fn(),
    openBillingPortal: vi.fn(),
  } as unknown as OrgCtx;
}

async function mount(ctx: OrgCtx): Promise<{ container: HTMLElement; root: Root }> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(React.createElement(BillingPane, { ctx }));
    await Promise.resolve();
    await Promise.resolve();
  });
  return { container, root };
}

beforeEach(() => {
  effectMocks.suppress = false;
  billingMocks.fetchBillingPreview.mockReset();
});

afterEach(() => {
  effectMocks.suppress = false;
  act(() => roots.splice(0).forEach((root) => root.unmount()));
  document.body.innerHTML = "";
});

describe("managed Billing ledger", () => {
  it("loads and renders a sanitized manager preview without exposing Stripe ids", async () => {
    billingMocks.fetchBillingPreview.mockResolvedValue(preview);
    const { container } = await mount(context());
    expect(billingMocks.fetchBillingPreview).toHaveBeenCalledOnce();
    expect(billingMocks.fetchBillingPreview).toHaveBeenCalledWith("org-1");
    expect(container.textContent).toContain("Visa •••• 4242");
    expect(container.textContent).toContain("INV-0042");
    expect(container.textContent).toContain("$40.00");
    expect(container.innerHTML).not.toContain("pm_");
    expect(container.innerHTML).not.toContain("cus_");
  });

  it("keeps the ledger and billing portal action available when Stripe preview loading fails", async () => {
    billingMocks.fetchBillingPreview.mockRejectedValue(new Error("Stripe offline"));
    const { container } = await mount(context());
    expect(container.textContent).toContain("Payment details are temporarily unavailable");
    expect(container.textContent).toContain("Manage billing");
    expect(container.textContent).toContain("Sandbox usage");
  });

  it("never requests or renders payment details for a Developer", async () => {
    billingMocks.fetchBillingPreview.mockResolvedValue(preview);
    const { container } = await mount(context({ ...managedBilling, canManage: false }));
    expect(billingMocks.fetchBillingPreview).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Only workspace owners and admins");
    expect(container.textContent).not.toContain("4242");
    expect(container.textContent).not.toContain("INV-0042");
  });

  it("never renders a resolved preview under a different workspace", async () => {
    billingMocks.fetchBillingPreview
      .mockResolvedValueOnce(preview)
      .mockReturnValueOnce(new Promise(() => {}));
    const { container, root } = await mount(context());
    expect(container.textContent).toContain("Visa •••• 4242");

    const nextContext = context();
    nextContext.currentOrg = { ...nextContext.currentOrg, id: "org-2" };
    effectMocks.suppress = true;
    await act(async () => {
      root.render(React.createElement(BillingPane, { ctx: nextContext }));
      await Promise.resolve();
    });

    expect(billingMocks.fetchBillingPreview).toHaveBeenCalledTimes(1);
    expect(container.textContent).not.toContain("4242");
    expect(container.textContent).not.toContain("INV-0042");
    expect(container.querySelector('[aria-label="Loading payment details"]')).not.toBeNull();
  });
});
