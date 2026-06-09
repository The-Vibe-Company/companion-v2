import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { POST } from "./route";

function jsonRequest(body: unknown, headers: Record<string, string> = {}) {
  const url = "http://127.0.0.1:55030/v1/auth/signin";
  const request = new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return Object.assign(request, { nextUrl: new URL(url) }) as never;
}

describe("signin route", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("re-emits the session cookie on the web origin and returns the safe redirect", async () => {
    vi.stubEnv("COMPANION_API_URL", "http://127.0.0.1:55031");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 200, headers: { "set-cookie": "session=value; Path=/; HttpOnly" } })),
    );

    const response = await POST(jsonRequest({ email: "admin@tvc.dev", password: "adminadmin", next: "/settings" }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, redirect: "/settings" });
    expect(response.headers.get("set-cookie")).toBe("session=value; Path=/; HttpOnly");
    expect(fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:55031/auth/sign-in/email",
      expect.objectContaining({ method: "POST", redirect: "manual" }),
    );
  });

  it("falls back to /skills for unsafe next values", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 200 })));

    const response = await POST(jsonRequest({ email: "a@b.co", password: "secret123", next: "https://evil.test/x" }));

    expect(await response.json()).toEqual({ ok: true, redirect: "/skills" });
  });

  it("routes unverified accounts to the verify screen instead of an error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ message: "Email not verified", code: "EMAIL_NOT_VERIFIED" }, { status: 403 })),
    );

    const response = await POST(jsonRequest({ email: "new@acme.com", password: "secret123" }));

    expect(await response.json()).toEqual({ ok: false, needsVerification: true, email: "new@acme.com" });
  });

  it("returns the auth error message for bad credentials", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ message: "Invalid email or password", code: "INVALID_EMAIL_OR_PASSWORD" }, { status: 401 })),
    );

    const response = await POST(jsonRequest({ email: "admin@tvc.dev", password: "wrong" }));

    expect(await response.json()).toEqual({ ok: false, message: "Invalid email or password" });
  });

  it("rejects missing fields without calling the API", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(jsonRequest({ email: "", password: "" }));

    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
