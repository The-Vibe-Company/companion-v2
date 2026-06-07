import { afterEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

function formRequest(body: Record<string, string>) {
  const url = "http://127.0.0.1:55030/v1/auth/login-redirect";
  const request = new Request(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });
  return Object.assign(request, { nextUrl: new URL(url) }) as never;
}

describe("login redirect route", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("sets auth cookies on the web origin and redirects to the requested path", async () => {
    vi.stubEnv("COMPANION_API_URL", "http://127.0.0.1:55031");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 200, headers: { "set-cookie": "session=value; Path=/; HttpOnly" } })),
    );

    const response = await POST(
      formRequest({
        mode: "signin",
        next: "/skills",
        email: "admin@tvc.dev",
        password: "adminadmin",
      }),
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/skills");
    expect(response.headers.get("set-cookie")).toBe("session=value; Path=/; HttpOnly");
    expect(fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:55031/auth/sign-in/email",
      expect.objectContaining({
        method: "POST",
        redirect: "manual",
        headers: {
          "content-type": "application/json",
          origin: "http://127.0.0.1:55030",
        },
      }),
    );
  });

  it("falls back to /skills for unsafe next values", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 200 })));

    const response = await POST(
      formRequest({
        mode: "signin",
        next: "https://evil.test/steal",
        email: "admin@tvc.dev",
        password: "adminadmin",
      }),
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/skills");
  });

  it("redirects failed sign-ins back to login with the auth error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ error: { message: "Invalid credentials" } }, { status: 401 })),
    );

    const response = await POST(
      formRequest({
        mode: "signin",
        next: "/settings",
        email: "admin@tvc.dev",
        password: "wrong-password",
      }),
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "/login?next=%2Fsettings&mode=signin&error=Invalid+credentials",
    );
  });
});
