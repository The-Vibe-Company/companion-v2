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
    const call = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(call[1].body as string)).toMatchObject({
      callbackURL: "https://thecompanion.sh/skills",
      newUserCallbackURL: "https://thecompanion.sh/skills",
      errorCallbackURL: "https://thecompanion.sh/login?error=Google+sign-in+failed.&next=%2Fskills",
    });
  });

  it("preserves a safe public-install return path for new Google users", async () => {
    vi.stubEnv("COMPANION_API_URL", "https://api.thecompanion.sh");
    vi.stubEnv("COMPANION_WEB_URL", "https://thecompanion.sh");
    const fetchMock = vi.fn(async () => Response.json({ url: "https://accounts.google.com/authorize" }));
    vi.stubGlobal("fetch", fetchMock);

    await GET(getRequest("?next=%2Fs%2Fpublic-token%3Fdownload%3D1"));

    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(call[1].body as string)).toMatchObject({
      callbackURL: "https://thecompanion.sh/s/public-token?download=1",
      newUserCallbackURL: "https://thecompanion.sh/s/public-token?download=1",
      errorCallbackURL: "https://thecompanion.sh/login?error=Google+sign-in+failed.&next=%2Fs%2Fpublic-token%3Fdownload%3D1",
    });
  });

  it("keeps next when Google sign-in is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({}, { status: 503 })));

    const response = await GET(getRequest("?next=%2Fs%2Fpublic-token%3Fdownload%3D1"));

    expect(response.headers.get("location")).toBe(
      "https://thecompanion.sh/login?error=Google+sign-in+is+unavailable.&next=%2Fs%2Fpublic-token%3Fdownload%3D1",
    );
  });
});
