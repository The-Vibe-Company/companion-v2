import { describe, expect, it } from "vitest";
import { sanitizeSentryEvent, stripSensitiveUrl } from "../sentry.shared";

describe("Sentry event sanitization", () => {
  it("drops query strings that can carry OAuth codes and signed tokens", () => {
    expect(stripSensitiveUrl("https://app.example/auth/callback/google?code=oauth-code&state=1")).toBe(
      "https://app.example/auth/callback/google",
    );
    expect(stripSensitiveUrl("https://box.ascii.dev/desktop?token=secret")).toBe("https://box.ascii.dev/desktop");
  });

  it("strips request query, cookies, headers, body, breadcrumbs, and spans", () => {
    const event = sanitizeSentryEvent({
      request: {
        url: "https://app.example/v1/integrations/github/callback?code=oauth-code",
        query_string: "code=oauth-code",
        cookies: "session=abc",
        headers: { authorization: "Bearer secret" },
        data: { code: "oauth-code" },
      },
      breadcrumbs: [
        { data: { url: "https://box.ascii.dev/stream?token=secret" } },
        { data: { from: "/login?code=oauth-code", to: "/v1/companion-plugins/oauth/callback?code=oauth-code" } },
      ],
      spans: [{ data: { "http.url": "https://app.example/auth/callback/google?code=oauth-code", "http.query": "code=oauth-code&state=1" } }],
    });

    expect(event.request?.url).toBe("https://app.example/v1/integrations/github/callback");
    expect(event.request?.query_string).toBeUndefined();
    expect(event.request?.cookies).toBeUndefined();
    expect(event.request?.headers).toBeUndefined();
    expect(event.request?.data).toBeUndefined();
    expect(event.breadcrumbs?.[0]?.data?.url).toBe("https://box.ascii.dev/stream");
    expect(event.breadcrumbs?.[1]?.data?.from).toBe("/login");
    expect(event.breadcrumbs?.[1]?.data?.to).toBe("/v1/companion-plugins/oauth/callback");
    expect(event.spans?.[0]?.data?.["http.url"]).toBe("https://app.example/auth/callback/google");
    expect(event.spans?.[0]?.data?.["http.query"]).toBe("[query removed]");
  });
});
