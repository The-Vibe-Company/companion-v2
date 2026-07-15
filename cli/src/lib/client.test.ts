import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./config", () => ({
  getProfileConfig: vi.fn(async () => ({ url: "http://companion.test", orgId: "stale-org" })),
}));

vi.mock("./session", () => ({
  loadSession: vi.fn(async () => ({
    cookie: "session=test",
    orgId: "stale-org",
    user: { id: "user-1", email: "member@example.test" },
  })),
}));

import { getClient } from "./client";

describe("getClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("adopts the accessible organization returned when a remembered organization is stale", async () => {
    const requests: RequestInit[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      requests.push(init ?? {});
      return new Response(JSON.stringify({
        userId: "user-1",
        email: "member@example.test",
        org: { org_id: "accessible-org" },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }));

    const client = await getClient("browser-smoke");
    expect(client.orgId).toBe("accessible-org");

    await client.request("/v1/skills");
    expect(new Headers(requests[0]?.headers).get("x-companion-org")).toBe("stale-org");
    expect(new Headers(requests[1]?.headers).get("x-companion-org")).toBe("accessible-org");
  });
});
