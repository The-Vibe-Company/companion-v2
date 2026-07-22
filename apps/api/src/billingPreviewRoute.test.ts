import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Product promise:
 * Live Stripe previews are browser-session-only, manager-gated, uncached, and fail independently from billing state.
 *
 * Regression caught:
 * A PAT could reach payment metadata, a preview could be cached, or a Stripe outage could be misreported as an authorization failure.
 *
 * Why this test is HTTP-level:
 * The route owns session-only authentication, tenant composition, cache headers, and provider-error status mapping.
 *
 * Failure proof:
 * Allowing tokens, removing no-store, or mapping BillingPreviewProviderError to 403 makes these scenarios fail.
 */
const coreMocks = vi.hoisted(() => ({
  getBillingPreviewSource: vi.fn(),
  getBillingPreview: vi.fn(),
}));

const serviceMocks = vi.hoisted(() => ({
  ApiTokenRefreshError: class ApiTokenRefreshError extends Error {},
  ensureUserBootstrap: vi.fn(async () => undefined),
  listOrgs: vi.fn(),
  resolveApiToken: vi.fn(),
  refreshApiToken: vi.fn(),
}));

const authMocks = vi.hoisted(() => ({
  getSession: vi.fn(async (): Promise<unknown | null> => null),
  handler: vi.fn(),
}));

vi.mock("@hono/node-server", () => ({ serve: vi.fn() }));
vi.mock("@companion/auth", () => ({
  auth: { api: { getSession: authMocks.getSession }, handler: authMocks.handler, $Infer: {} },
  registerAgentCapabilityExecutor: vi.fn(() => () => undefined),
}));
vi.mock("@companion/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@companion/db")>()),
  withTenantContext: vi.fn(async (_context: unknown, fn: (database: unknown) => unknown) => fn({ marker: "tenant-db" })),
}));
vi.mock("@companion/core/services", () => serviceMocks);
vi.mock("@companion/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@companion/core")>()),
  getBillingPreviewSource: coreMocks.getBillingPreviewSource,
  getBillingPreview: coreMocks.getBillingPreview,
}));

import { BillingPreviewProviderError } from "@companion/core";
import { app } from "./index";

const me = { id: "user-me", email: "me@example.test", name: "Me" };
const source = { customerId: "cus_1", subscriptionId: "sub_1" };
const preview = {
  paymentMethod: { type: "card", brand: "visa", last4: "4242", expMonth: 8, expYear: 2030 },
  latestInvoice: null,
};

function signIn(): void {
  authMocks.getSession.mockResolvedValue({ user: me, session: { id: "session-1" } });
  serviceMocks.listOrgs.mockResolvedValue([{ org_id: "org-1", name: "Acme" }]);
}

beforeEach(() => {
  vi.clearAllMocks();
  authMocks.getSession.mockResolvedValue(null);
  process.env.STRIPE_SECRET_KEY = "sk_test";
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
  process.env.STRIPE_PRO_PRICE_ID = "price_pro";
  process.env.STRIPE_PORTAL_CONFIGURATION_ID = "bpc_pro";
});

describe("GET /v1/billing/preview", () => {
  it("returns an uncached sanitized preview through the tenant-scoped authorization service", async () => {
    signIn();
    coreMocks.getBillingPreviewSource.mockResolvedValue(source);
    coreMocks.getBillingPreview.mockResolvedValue(preview);

    const response = await app.request("/v1/billing/preview");

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual(preview);
    expect(coreMocks.getBillingPreviewSource).toHaveBeenCalledWith(expect.objectContaining({
      actorId: me.id,
      orgId: "org-1",
      database: { marker: "tenant-db" },
    }));
    expect(coreMocks.getBillingPreview).toHaveBeenCalledWith(expect.objectContaining({ source }));
  });

  it("rejects personal access tokens before billing preview services run", async () => {
    serviceMocks.resolveApiToken.mockResolvedValue({ actor: me, orgId: "org-1", scopes: ["skills:read"] });
    const response = await app.request("/v1/billing/preview", {
      headers: { authorization: "Bearer cmp_pat_no-billing" },
    });
    expect(response.status).toBe(403);
    expect(coreMocks.getBillingPreviewSource).not.toHaveBeenCalled();
    expect(coreMocks.getBillingPreview).not.toHaveBeenCalled();
  });

  it("maps a live Stripe failure to 502 without returning provider details", async () => {
    signIn();
    coreMocks.getBillingPreviewSource.mockResolvedValue(source);
    coreMocks.getBillingPreview.mockRejectedValue(new BillingPreviewProviderError());

    const response = await app.request("/v1/billing/preview");

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: "billing payment details are temporarily unavailable",
    });
  });
});
