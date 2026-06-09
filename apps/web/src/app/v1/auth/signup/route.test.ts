import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { POST } from "./route";

function jsonRequest(body: unknown, headers: Record<string, string> = {}) {
  const url = "http://127.0.0.1:55030/v1/auth/signup";
  const request = new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return Object.assign(request, { nextUrl: new URL(url) }) as never;
}

describe("signup route", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("derives the name from the email and routes to verification", async () => {
    vi.stubEnv("COMPANION_API_URL", "http://127.0.0.1:55031");
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(jsonRequest({ email: "alex@acme.com", password: "supersecret" }));

    expect(await response.json()).toEqual({ ok: true, needsVerification: true, email: "alex@acme.com" });
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(call[1].body as string)).toEqual({
      email: "alex@acme.com",
      password: "supersecret",
      name: "alex",
    });
  });

  it("rejects short passwords without calling the API", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(jsonRequest({ email: "alex@acme.com", password: "short" }));

    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects invalid emails without calling the API", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(jsonRequest({ email: "not-an-email", password: "supersecret" }));

    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns a generic, non-disclosing error on upstream failure (no enumeration oracle)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ message: "User already exists", code: "USER_ALREADY_EXISTS" }, { status: 422 }),
      ),
    );

    const response = await POST(jsonRequest({ email: "alex@acme.com", password: "supersecret" }));
    const data = (await response.json()) as { ok: boolean; message: string };

    expect(response.status).toBe(400);
    expect(data.ok).toBe(false);
    expect(data.message).toBe("Could not create your account. Check your details and try again.");
    // The upstream "already exists" signal must not leak to the client.
    expect(JSON.stringify(data)).not.toMatch(/exist/i);
  });
});
