import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { POST } from "./route";

function postRequest(headers: Record<string, string> = {}, next?: string) {
  const url = "http://127.0.0.1:55030/v1/auth/logout";
  const body = next === undefined ? undefined : new URLSearchParams({ next });
  const request = new Request(url, { method: "POST", headers, body });
  return Object.assign(request, { nextUrl: new URL(url) }) as never;
}

describe("logout route", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("forwards to the API sign-out, clears cookies, and redirects to /login", async () => {
    vi.stubEnv("COMPANION_API_URL", "http://127.0.0.1:55031");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 200, headers: { "set-cookie": "better-auth.session=; Max-Age=0" } })),
    );

    const response = await POST(postRequest({ cookie: "better-auth.session=abc" }));

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/login");
    const cookies = response.headers.get("set-cookie") ?? "";
    expect(cookies).toContain("better-auth.session=");
    expect(cookies).toContain("companion_org=; Path=/; Max-Age=0");
    expect(fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:55031/v1/auth/logout",
      expect.objectContaining({ method: "POST", redirect: "manual" }),
    );
  });

  it("still clears the org cookie and redirects to /login when the API is unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );

    const response = await POST(postRequest());

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/login");
    expect(response.headers.get("set-cookie") ?? "").toContain("companion_org=; Path=/; Max-Age=0");
  });

  it("preserves a safe reauthentication return path and rejects an external one", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 200 })));

    const safe = await POST(postRequest({}, "/device/capabilities?agent_id=agent-1&code=ABCD-1234"));
    const unsafe = await POST(postRequest({}, "https://evil.example/device/capabilities"));

    expect(safe.headers.get("location")).toBe(
      "/login?next=%2Fdevice%2Fcapabilities%3Fagent_id%3Dagent-1%26code%3DABCD-1234",
    );
    expect(unsafe.headers.get("location")).toBe("/login");
  });
});
