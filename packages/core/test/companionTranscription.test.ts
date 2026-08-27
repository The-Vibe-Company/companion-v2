import { describe, expect, it, vi } from "vitest";
import {
  COMPANION_TRANSCRIPTION_NEW_SESSION_TTL_MS,
  COMPANION_TRANSCRIPTION_TOKEN_TTL_MS,
  CompanionRuntimeForbiddenError,
  createCompanionTranscriptionSession,
} from "../src/companions";

const orgId = "11111111-1111-4111-8111-111111111111";
const companionId = "22222222-2222-4222-8222-222222222222";
const actor = { id: "actor-1", email: "actor@example.test", name: "Actor" };
const apiKey = "google-global-transcription-key";
const now = Date.parse("2026-08-27T10:00:00.000Z");

describe("Companion Gemini Live transcription sessions", () => {
  it("exchanges only the global Google key for one single-use timing-bounded session", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      });
      const request = JSON.parse(String(init?.body));
      expect(request).toEqual({
        uses: 1,
        expireTime: new Date(now + COMPANION_TRANSCRIPTION_TOKEN_TTL_MS).toISOString(),
        newSessionExpireTime: new Date(now + COMPANION_TRANSCRIPTION_NEW_SESSION_TTL_MS).toISOString(),
      });
      expect(request).not.toHaveProperty("liveConnectConstraints");
      expect(JSON.stringify(request)).not.toContain("realtimeInput");
      expect(JSON.stringify(request)).not.toContain("workspace-audio");
      return Response.json({ name: "ephemeral-session-token" });
    });

    await expect(createCompanionTranscriptionSession({
      actor,
      orgId,
      companionId,
      companion: { access: "owner" },
      apiKey,
      // SAFETY: this mock implements the fetch call shape exercised by the core exchange.
      fetchImpl: fetchImpl as typeof fetch,
      now: () => now,
    })).resolves.toEqual({
      token: "ephemeral-session-token",
      expires_at: new Date(now + COMPANION_TRANSCRIPTION_TOKEN_TTL_MS).toISOString(),
      model: "gemini-3.5-transcribe-live",
    });
    const [requestUrl, requestInit] = fetchImpl.mock.calls[0]!;
    expect(String(requestUrl)).not.toContain(apiKey);
    expect(String(requestInit?.body)).not.toContain(apiKey);
  });

  it("denies Viewer access before reading credentials or contacting Google", async () => {
    // SAFETY: the mock is only used to prove that the authorization guard prevents a call.
    const fetchImpl = vi.fn() as typeof fetch;
    await expect(createCompanionTranscriptionSession({
      actor,
      orgId,
      companionId,
      companion: { access: "viewer" },
      apiKey,
      fetchImpl,
      now: () => now,
    })).rejects.toBeInstanceOf(CompanionRuntimeForbiddenError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fails closed when the global Google key is missing", async () => {
    // SAFETY: the mock is only used to prove missing deployment configuration does not contact Google.
    const fetchImpl = vi.fn() as typeof fetch;
    await expect(createCompanionTranscriptionSession({
      actor,
      orgId,
      companionId,
      companion: { access: "editor" },
      apiKey: "   ",
      fetchImpl,
      now: () => now,
    })).rejects.toMatchObject({
      code: "provider_not_configured",
      providerId: "google",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("sanitizes provider failures and malformed token responses", async () => {
    const failures = [
      async () => Response.json({ error: { message: `leaked ${apiKey}` } }, { status: 503 }),
      async () => Response.json({ name: apiKey }),
      async () => Response.json({ error: `leaked ${apiKey}` }),
    ];
    for (const failure of failures) {
      // SAFETY: the provider failure fixtures implement the fetch response contract.
      const fetchImpl = vi.fn(failure) as typeof fetch;
      await expect(createCompanionTranscriptionSession({
        actor,
        orgId,
        companionId,
        companion: { access: "owner" },
        apiKey,
        fetchImpl,
        now: () => now,
      })).rejects.toMatchObject({
        code: "provider_unavailable",
        providerId: "google",
      });
      const error = await createError(createCompanionTranscriptionSession({
        actor,
        orgId,
        companionId,
        companion: { access: "owner" },
        apiKey,
        // SAFETY: the provider failure fixture implements the fetch response contract.
        fetchImpl: vi.fn(failure) as typeof fetch,
        now: () => now,
      }));
      expect(error?.message).not.toContain(apiKey);
    }
  });
});

async function createError(promise: Promise<unknown>): Promise<Error | null> {
  try {
    await promise;
    return null;
  } catch (error) {
    return error instanceof Error ? error : null;
  }
}
