import { describe, expect, it } from "vitest";
import {
  RUN_HTML_PREVIEW_CLOCK_SKEW_MS,
  RUN_HTML_PREVIEW_TTL_MS,
  createRunHtmlPreviewLimiter,
  isRunHtmlPreviewRequest,
  isOpaqueOriginMutation,
  issueRunHtmlPreviewTicket,
  runHtmlPreviewArtifactPath,
  runHtmlPreviewOrigin,
  runHtmlPreviewUrl,
  verifyRunHtmlPreviewTicket,
} from "./runHtmlPreview";

const secret = "preview-secret-that-is-long-enough-for-tests";

describe("run HTML preview capabilities", () => {
  it("issues a bounded signed ticket and rejects tampering or expiry", () => {
    const issued = issueRunHtmlPreviewTicket({ orgId: "org-1", runId: "run-1", userId: "user-1", secret, now: 1_000 });
    expect(verifyRunHtmlPreviewTicket({ ticket: issued.ticket, secret, now: 1_001 })).toMatchObject({
      version: 1, orgId: "org-1", runId: "run-1", userId: "user-1", expiresAt: 1_000 + RUN_HTML_PREVIEW_TTL_MS,
    });
    expect(() => verifyRunHtmlPreviewTicket({ ticket: `${issued.ticket}x`, secret, now: 1_001 })).toThrow(/invalid/);
    expect(() => verifyRunHtmlPreviewTicket({ ticket: issued.ticket, secret, now: issued.expiresAt })).toThrow(/expired/);
    expect(verifyRunHtmlPreviewTicket({
      ticket: issued.ticket,
      secret,
      now: 1_000 - RUN_HTML_PREVIEW_CLOCK_SKEW_MS,
    })).toMatchObject({ runId: "run-1" });
    expect(() => verifyRunHtmlPreviewTicket({
      ticket: issued.ticket,
      secret,
      now: 999 - RUN_HTML_PREVIEW_CLOCK_SKEW_MS,
    })).toThrow(/expired/);
  });

  it("bounds requests, bytes and concurrent streams for each ticket", () => {
    const requestLimited = createRunHtmlPreviewLimiter({
      maxRequests: 2,
      maxBytes: 100,
      maxConcurrent: 2,
    });
    requestLimited.begin({ ticket: "request-ticket", expiresAt: 2_000, now: 1_000 }).release();
    requestLimited.begin({ ticket: "request-ticket", expiresAt: 2_000, now: 1_000 }).release();
    expect(() => requestLimited.begin({
      ticket: "request-ticket",
      expiresAt: 2_000,
      now: 1_000,
    })).toThrow(/budget/);

    const byteLimited = createRunHtmlPreviewLimiter({ maxRequests: 10, maxBytes: 100 });
    const first = byteLimited.begin({ ticket: "byte-ticket", expiresAt: 2_000, now: 1_000 });
    first.chargeBytes(60);
    first.release();
    const second = byteLimited.begin({ ticket: "byte-ticket", expiresAt: 2_000, now: 1_000 });
    expect(() => second.chargeBytes(41)).toThrow(/budget/);
    second.release();

    const concurrencyLimited = createRunHtmlPreviewLimiter({ maxRequests: 10, maxConcurrent: 1 });
    const active = concurrencyLimited.begin({ ticket: "concurrent-ticket", expiresAt: 2_000, now: 1_000 });
    expect(() => concurrencyLimited.begin({
      ticket: "concurrent-ticket",
      expiresAt: 2_000,
      now: 1_000,
    })).toThrow(/budget/);
    active.release();
    expect(() => concurrencyLimited.begin({
      ticket: "concurrent-ticket",
      expiresAt: 2_000,
      now: 1_000,
    })).not.toThrow();
  });

  it("requires a separate, origin-only preview URL", () => {
    expect(runHtmlPreviewOrigin({
      COMPANION_PREVIEW_URL: "https://preview.example.test",
      COMPANION_WEB_URL: "https://app.example.test",
      COMPANION_API_URL: "https://app.example.test",
    })).toBe("https://preview.example.test");
    expect(runHtmlPreviewOrigin({
      COMPANION_PREVIEW_URL: "https://app.example.test",
      COMPANION_WEB_URL: "https://app.example.test",
    })).toBeNull();
    expect(runHtmlPreviewOrigin({
      COMPANION_PREVIEW_URL: "http://app.example.test",
      COMPANION_WEB_URL: "https://app.example.test",
    })).toBeNull();
    expect(runHtmlPreviewOrigin({ COMPANION_PREVIEW_URL: "https://preview.example.test/prefix" })).toBeNull();
    expect(isRunHtmlPreviewRequest("http://preview.example.test/v1/run-previews/ticket/artifacts/index.html", {
      COMPANION_PREVIEW_URL: "https://preview.example.test",
      COMPANION_WEB_URL: "https://app.example.test",
      COMPANION_API_URL: "https://api.example.test",
    })).toBe(true);
    expect(isRunHtmlPreviewRequest("http://api.example.test/v1/runs", {
      COMPANION_PREVIEW_URL: "https://preview.example.test",
      COMPANION_WEB_URL: "https://app.example.test",
      COMPANION_API_URL: "https://api.example.test",
    })).toBe(false);
    expect(isOpaqueOriginMutation("POST", "null")).toBe(true);
    expect(isOpaqueOriginMutation("DELETE", " NULL ")).toBe(true);
    expect(isOpaqueOriginMutation("GET", "null")).toBe(false);
    expect(isOpaqueOriginMutation("POST", "https://app.example.test")).toBe(false);
  });

  it("keeps paths inside artifacts and encodes a relative preview URL", () => {
    expect(runHtmlPreviewArtifactPath("site/assets/app.js")).toBe("artifacts/site/assets/app.js");
    expect(runHtmlPreviewArtifactPath("site/index%20page.html")).toBe("artifacts/site/index page.html");
    expect(() => runHtmlPreviewArtifactPath("site/../secret.txt")).toThrow(/invalid/);
    expect(() => runHtmlPreviewArtifactPath("site/%2e%2e/secret.txt")).toThrow(/invalid/);
    expect(() => runHtmlPreviewArtifactPath("site/%2Fsecret.txt")).toThrow(/invalid/);
    expect(() => runHtmlPreviewArtifactPath("%2ehidden/index.html")).toThrow(/invalid/);
    expect(() => runHtmlPreviewArtifactPath(".hidden/index.html")).toThrow(/invalid/);
    expect(runHtmlPreviewUrl({
      origin: "https://preview.example.test",
      ticket: "ticket.value",
      artifactPath: "artifacts/site/index page.html",
    })).toBe("https://preview.example.test/v1/run-previews/ticket.value/artifacts/site/index%20page.html");
  });
});
