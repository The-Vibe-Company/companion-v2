import { describe, expect, it, vi } from "vitest";
import type { Db } from "@companion/db";

import {
  COMPANION_TRANSCRIPTION_NEW_SESSION_TTL_MS,
  COMPANION_TRANSCRIPTION_TOKEN_TTL_MS,
  CompanionRuntimeForbiddenError,
  createCompanionTranscriptionSession,
} from "../src/companions";
import { encryptOpaqueValue } from "../src/secretsCrypto";

const orgId = "11111111-1111-4111-8111-111111111111";
const companionId = "22222222-2222-4222-8222-222222222222";
const actor = { id: "actor-1", email: "actor@example.test", name: "Actor" };
const masterKey = Buffer.alloc(32, 29);
const apiKey = "google-workspace-key";
const generation = "33333333-3333-4333-8333-333333333333";
const now = Date.parse("2026-08-27T10:00:00.000Z");

function providerRow(authMethod: "api_key" | "subscription" = "api_key") {
  const envelope = encryptOpaqueValue({
    orgId,
    purpose: "companion-provider-credential",
    subjectId: `google:${generation}`,
    value: JSON.stringify({ type: "api_key", key: apiKey }),
  }, masterKey);
  return {
    authMethod,
    credentialGeneration: generation,
    ...envelope,
  };
}

function databaseWithProvider(row: ReturnType<typeof providerRow> | null): Db {
  const database = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => row ? [row] : []),
        })),
      })),
    })),
  };
  // SAFETY: this fake implements the only Drizzle query chain used by the focused core test.
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- the fake intentionally models one query chain only
  return database as unknown as Db;
}

describe("Companion Gemini Live transcription sessions", () => {
  it("exchanges only the workspace Google key for one constrained short-lived session", async () => {
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
        liveConnectConstraints: {
          model: "models/gemini-3.5-transcribe-live",
          config: {
            responseModalities: ["TEXT"],
            inputAudioTranscription: {
              mode: "SMART",
              languageCodes: [],
            },
            sessionResumption: {},
          },
        },
      });
      expect(JSON.stringify(request)).not.toContain("realtimeInput");
      expect(JSON.stringify(request)).not.toContain("workspace-audio");
      return Response.json({ name: "ephemeral-session-token" });
    });

    await expect(createCompanionTranscriptionSession({
      actor,
      orgId,
      companionId,
      companion: { access: "owner" },
      masterKey,
      database: databaseWithProvider(providerRow()),
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
    const database = databaseWithProvider(providerRow());

    await expect(createCompanionTranscriptionSession({
      actor,
      orgId,
      companionId,
      companion: { access: "viewer" },
      masterKey,
      database,
      fetchImpl,
      now: () => now,
    })).rejects.toBeInstanceOf(CompanionRuntimeForbiddenError);
    expect(database.select).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fails closed when Google is missing or not configured with an API key", async () => {
    // SAFETY: the mock is only used to prove provider setup failures do not contact Google.
    const fetchImpl = vi.fn() as typeof fetch;
    await expect(createCompanionTranscriptionSession({
      actor,
      orgId,
      companionId,
      companion: { access: "editor" },
      masterKey,
      database: databaseWithProvider(null),
      fetchImpl,
      now: () => now,
    })).rejects.toMatchObject({
      code: "provider_not_configured",
      providerId: "google",
    });

    await expect(createCompanionTranscriptionSession({
      actor,
      orgId,
      companionId,
      companion: { access: "owner" },
      masterKey,
      database: databaseWithProvider(providerRow("subscription")),
      fetchImpl,
      now: () => now,
    })).rejects.toMatchObject({
      code: "provider_auth_invalid",
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
        masterKey,
        database: databaseWithProvider(providerRow()),
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
        masterKey,
        database: databaseWithProvider(providerRow()),
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
