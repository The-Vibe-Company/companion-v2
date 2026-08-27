import { describe, expect, it, vi } from "vitest";

import { createCompanionTranscriptionDiagnostics } from "./companionTranscriptionDiagnostics";

const now = new Date("2026-08-27T15:00:00.000Z");
const providerSecret = "AQ.provider-secret-must-not-appear";
const providerUrl = `https://generativelanguage.googleapis.com/v1beta/auth_tokens?key=${providerSecret}`;

function diagnostics(fetchImpl: typeof fetch) {
  const lines: string[] = [];
  return {
    lines,
    observer: createCompanionTranscriptionDiagnostics({
      fetchImpl,
      now: () => now,
      write: (line) => lines.push(line),
    }),
  };
}

describe("Companion transcription diagnostics", () => {
  it.each([
    [400, "4xx"],
    [429, "4xx"],
    [503, "5xx"],
  ] as const)("logs only the safe HTTP category for status %s", async (status, category) => {
    const providerBody = `provider rejected ${providerSecret}`;
    const fetchImpl: typeof fetch = vi.fn(async () => new Response(providerBody, { status }));
    const { lines, observer } = diagnostics(fetchImpl);

    await observer.fetchImpl(providerUrl, {
      headers: { "x-goog-api-key": providerSecret },
    });

    expect(lines).toEqual([JSON.stringify({
      level: "warn",
      ts: now.toISOString(),
      event: "api.companion_transcription.provider_failure",
      providerId: "google",
      category,
      status,
    })]);
    expect(lines[0]).not.toContain(providerSecret);
    expect(lines[0]).not.toContain("googleapis.com");
    expect(lines[0]).not.toContain(providerBody);
  });

  it("classifies transport failures without logging the thrown provider diagnostic", async () => {
    const providerDiagnostic = `socket failed with ${providerSecret}`;
    const fetchImpl: typeof fetch = vi.fn(async () => {
      throw new Error(providerDiagnostic);
    });
    const { lines, observer } = diagnostics(fetchImpl);

    await expect(observer.fetchImpl(providerUrl)).rejects.toThrow(providerDiagnostic);

    expect(lines).toEqual([JSON.stringify({
      level: "warn",
      ts: now.toISOString(),
      event: "api.companion_transcription.provider_failure",
      providerId: "google",
      category: "transport",
    })]);
    expect(lines[0]).not.toContain(providerSecret);
    expect(lines[0]).not.toContain("googleapis.com");
  });

  it("reports an invalid successful response once without retaining its body", async () => {
    const providerBody = JSON.stringify({ error: providerSecret });
    const fetchImpl: typeof fetch = vi.fn(async () => new Response(providerBody, { status: 200 }));
    const { lines, observer } = diagnostics(fetchImpl);

    await observer.fetchImpl(providerUrl);
    observer.reportInvalidResponse();
    observer.reportInvalidResponse();

    expect(lines).toEqual([JSON.stringify({
      level: "warn",
      ts: now.toISOString(),
      event: "api.companion_transcription.provider_failure",
      providerId: "google",
      category: "invalid_response",
    })]);
    expect(lines[0]).not.toContain(providerSecret);
    expect(lines[0]).not.toContain(providerBody);
  });

  it("does not invent an invalid-response event before a successful provider response", () => {
    const fetchImpl: typeof fetch = vi.fn(async () => Response.json({ name: "unused" }));
    const { lines, observer } = diagnostics(fetchImpl);

    observer.reportInvalidResponse();

    expect(lines).toEqual([]);
  });
});
