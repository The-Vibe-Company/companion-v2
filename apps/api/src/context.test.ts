import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

const authMocks = vi.hoisted(() => ({
  getSession: vi.fn(),
}));

const serviceMocks = vi.hoisted(() => ({
  ensureUserBootstrap: vi.fn(async () => undefined),
  listOrgs: vi.fn(),
  resolveApiToken: vi.fn(),
}));

vi.mock("@companion/auth", () => ({
  auth: {
    api: { getSession: authMocks.getSession },
    $Infer: {},
  },
}));

vi.mock("@companion/core/services", () => serviceMocks);

import { attachSession, type ApiVariables } from "./context";

describe("attachSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("forwards every rolling-session cookie returned by Better Auth", async () => {
    const headers = new Headers();
    headers.append(
      "set-cookie",
      "__Secure-companion-production.session_token=refreshed; Max-Age=2592000; Path=/; HttpOnly; Secure; SameSite=Lax",
    );
    headers.append(
      "set-cookie",
      "__Secure-companion-production.session_data=cached; Max-Age=300; Path=/; HttpOnly; Secure; SameSite=Lax",
    );
    authMocks.getSession.mockResolvedValue({
      response: {
        user: { id: "user-1", email: "user@example.test", name: "User" },
        session: { id: "session-1" },
      },
      headers,
    });

    const app = new Hono<{ Variables: ApiVariables }>();
    app.use("*", attachSession);
    app.get("/me", (c) => c.json({ userId: c.get("user")?.id }));

    const response = await app.request("/me", {
      headers: { cookie: "__Secure-companion-production.session_token=old" },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ userId: "user-1" });
    expect(authMocks.getSession).toHaveBeenCalledWith(
      expect.objectContaining({ query: { disableRefresh: false }, returnHeaders: true }),
    );
    const cookies = (response.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() ?? [
      response.headers.get("set-cookie") ?? "",
    ];
    expect(cookies.join("\n")).toContain("Max-Age=2592000");
    expect(cookies.join("\n")).toContain("session_data=cached");
  });

  it("leaves rolling refresh to the browser for server-rendered API calls", async () => {
    authMocks.getSession.mockResolvedValue(null);

    const app = new Hono<{ Variables: ApiVariables }>();
    app.use("*", attachSession);
    app.get("/me", (c) => c.json({ user: c.get("user") }));

    await app.request("/me", {
      headers: { "x-companion-disable-session-refresh": "1" },
    });

    expect(authMocks.getSession).toHaveBeenCalledWith(
      expect.objectContaining({ query: { disableRefresh: true }, returnHeaders: true }),
    );
  });

  it("keeps a route's fresh login cookie after stale-session cleanup", async () => {
    const headers = new Headers();
    headers.append(
      "set-cookie",
      "companion.session_token=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax",
    );
    authMocks.getSession.mockResolvedValue({ response: null, headers });

    const app = new Hono<{ Variables: ApiVariables }>();
    app.use("*", attachSession);
    // Better Auth returns its own Response rather than setting the Hono context header directly.
    app.post(
      "/login",
      () =>
        new Response(JSON.stringify({ ok: true }), {
          headers: {
            "content-type": "application/json",
            "set-cookie": "companion.session_token=fresh; Max-Age=2592000; Path=/; HttpOnly; SameSite=Lax",
          },
        }),
    );

    const response = await app.request("/login", { method: "POST" });
    const cookies = (response.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() ?? [
      response.headers.get("set-cookie") ?? "",
    ];

    expect(cookies).toHaveLength(2);
    expect(cookies[0]).toContain("Max-Age=0");
    expect(cookies[1]).toContain("session_token=fresh");
  });
});
