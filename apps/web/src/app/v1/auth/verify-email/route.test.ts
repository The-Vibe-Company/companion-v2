import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { POST } from "./route";

function jsonRequest(body: unknown) {
  const url = "http://127.0.0.1:55030/v1/auth/verify-email";
  const request = new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return Object.assign(request, { nextUrl: new URL(url) }) as never;
}

describe("verify-email route", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("re-emits the session cookie and preserves a safe public-skill return path", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 200, headers: { "set-cookie": "session=value; Path=/; HttpOnly" } })),
    );

    const response = await POST(jsonRequest({
      email: "new@acme.com",
      otp: "284917",
      next: "/s/public-token?download=1",
    }));

    expect(await response.json()).toEqual({ ok: true, redirect: "/s/public-token?download=1" });
    expect(response.headers.get("set-cookie")).toBe("session=value; Path=/; HttpOnly");
  });

  it("falls back to the protected skills page for an unsafe return path", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 200 })),
    );

    const response = await POST(jsonRequest({
      email: "new@acme.com",
      otp: "284917",
      next: "https://attacker.example/steal-session",
    }));

    expect(await response.json()).toEqual({ ok: true, redirect: "/skills" });
  });

  it("maps expired codes to a distinct message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ message: "otp expired", code: "OTP_EXPIRED" }, { status: 400 })),
    );

    const response = await POST(jsonRequest({ email: "new@acme.com", otp: "111111" }));

    expect(await response.json()).toEqual({
      ok: false,
      code: "OTP_EXPIRED",
      message: "That code has expired. Request a new one.",
    });
  });

  it("rejects a non-6-digit code without calling the API", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(jsonRequest({ email: "new@acme.com", otp: "12" }));

    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
