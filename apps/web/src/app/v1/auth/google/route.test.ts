import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { GET } from "./route";

function getRequest(search = "") {
  const url = `https://thecompanion.sh/v1/auth/google${search}`;
  const request = new Request(url, { method: "GET" });
  return Object.assign(request, { nextUrl: new URL(url) }) as never;
}

describe("google auth route", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("re-emits the Better Auth state cookie while redirecting to Google", async () => {
    vi.stubEnv("COMPANION_API_URL", "https://api.thecompanion.sh");
    vi.stubEnv("COMPANION_WEB_URL", "https://thecompanion.sh");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          { url: "https://accounts.google.com/o/oauth2/v2/auth?state=abc" },
          { headers: { "set-cookie": "__Secure-better-auth.state=abc.signed; Path=/; HttpOnly; Secure; SameSite=Lax" } },
        ),
      ),
    );

    const response = await GET(getRequest("?next=%2Fskills"));

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("https://accounts.google.com/o/oauth2/v2/auth?state=abc");
    expect(response.headers.get("set-cookie")).toBe(
      "__Secure-better-auth.state=abc.signed; Path=/; HttpOnly; Secure; SameSite=Lax",
    );
    expect(fetch).toHaveBeenCalledWith(
      "https://api.thecompanion.sh/auth/sign-in/social",
      expect.objectContaining({
        method: "POST",
        redirect: "manual",
        headers: { "content-type": "application/json", origin: "https://thecompanion.sh" },
      }),
    );
  });
});
