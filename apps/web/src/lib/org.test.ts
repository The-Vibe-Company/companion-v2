import { beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock("./apiClient", () => ({ apiFetch: apiMocks.apiFetch }));

import { fetchBillingPreview } from "./org";

describe("fetchBillingPreview", () => {
  beforeEach(() => {
    apiMocks.apiFetch.mockReset();
  });

  it("pins the sensitive preview request to the displayed organization", async () => {
    apiMocks.apiFetch.mockResolvedValue({ paymentMethod: null, latestInvoice: null });

    await fetchBillingPreview("org_1");

    expect(apiMocks.apiFetch).toHaveBeenCalledWith("/v1/billing/preview", {
      headers: { "x-companion-org": "org_1" },
    });
  });
});
