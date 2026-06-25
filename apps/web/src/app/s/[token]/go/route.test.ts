import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { GET } from "./route";

function getRequest(headers: Record<string, string> = {}, url = "http://127.0.0.1:55000/s/share-token-1/go") {
  const request = new Request(url, { method: "GET", headers });
  return Object.assign(request, { nextUrl: new URL(url) }) as never;
}

const params = { params: Promise.resolve({ token: "share-token-1" }) };

describe("skill share go route", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("sets the target org cookie and redirects to the slug detail", async () => {
    vi.stubEnv("COMPANION_API_URL", "http://127.0.0.1:55001");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ org_id: "org-target", slug: "mega-code-review" })),
    );

    const response = await GET(getRequest({ cookie: "better-auth.session=abc" }), params);

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("http://127.0.0.1:55000/skills?lib=org&skill=mega-code-review");
    expect(response.headers.get("set-cookie") ?? "").toContain("companion_org=org-target");
    expect(fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:55001/v1/skills/share-target/share-token-1",
      expect.objectContaining({
        cache: "no-store",
        headers: { cookie: "better-auth.session=abc" },
      }),
    );
  });

  it("preserves the incoming host when Next normalizes request.url to localhost", async () => {
    vi.stubEnv("COMPANION_API_URL", "http://127.0.0.1:55001");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ org_id: "org-target", slug: "mega-code-review" })),
    );

    const response = await GET(
      getRequest({ host: "127.0.0.1:55000", cookie: "better-auth.session=abc" }, "http://localhost:55000/s/share-token-1/go"),
      params,
    );

    expect(response.headers.get("location")).toBe("http://127.0.0.1:55000/skills?lib=org&skill=mega-code-review");
  });

  it("redirects unauthenticated users to login with the original share URL as next", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: false, error: "not authenticated" }, { status: 401 })));

    const response = await GET(getRequest(), params);

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("http://127.0.0.1:55000/login?next=%2Fs%2Fshare-token-1");
  });

  it("falls back to the public preview when the token is inaccessible to the signed-in user", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: false, error: "skill not found" }, { status: 404 })));

    const response = await GET(getRequest({ cookie: "better-auth.session=abc" }), params);

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("http://127.0.0.1:55000/s/share-token-1?view=public");
  });
});
