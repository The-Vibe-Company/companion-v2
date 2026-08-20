import { describe, expect, it } from "vitest";
import { sanitizeSentryEvent } from "./sentrySanitize";

describe("API Sentry sanitization", () => {
  it("strips OAuth codes from request URLs, breadcrumbs, and spans", () => {
    const event = sanitizeSentryEvent({
      request: {
        url: "https://api.example/v1/integrations/github/callback?code=oauth-code",
        query_string: "code=oauth-code",
        cookies: "session=abc",
        headers: { authorization: "Bearer secret" },
        data: { code: "oauth-code" },
      },
      breadcrumbs: [{ data: { url: "https://api.example/auth/callback/google?code=oauth-code" } }],
      spans: [{ data: { "http.url": "https://box.ascii.dev/desktop?token=secret", "http.query": "token=secret" } }],
    });

    expect(event.request.url).toBe("https://api.example/v1/integrations/github/callback");
    expect(event.request.query_string).toBeUndefined();
    expect(event.request.cookies).toBeUndefined();
    expect(event.request.headers).toBeUndefined();
    expect(event.request.data).toBeUndefined();
    expect(event.breadcrumbs?.[0]?.data?.url).toBe("https://api.example/auth/callback/google");
    expect(event.spans?.[0]?.data?.["http.url"]).toBe("https://box.ascii.dev/desktop");
    expect(event.spans?.[0]?.data?.["http.query"]).toBe("[query removed]");
  });
});
