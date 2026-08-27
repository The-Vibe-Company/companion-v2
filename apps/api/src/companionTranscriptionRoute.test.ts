import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ApiVariables } from "./context";
import { actorFromContext, jsonError, orgIdFromContext } from "./context";
import { registerCompanionRoutes } from "./companionRoutes";
import type { Companion } from "@companion/contracts";
import {
  CompanionNotFoundError,
  CompanionProviderError,
  createCompanionTranscriptionSession,
  getCompanion,
  transcribeCompanionAudio,
} from "@companion/core";
import { db } from "@companion/db";

const COMPANION_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "22222222-2222-4222-8222-222222222222";
const API_KEY = "deployment-transcription-key";
const actor = { id: "user-1", email: "owner@example.test", name: "Owner" };
const companion = (access: Companion["access"]): Pick<Companion, "access"> => ({ access });

const database = db;
const actorMock = vi.fn<typeof actorFromContext>();
const orgMock = vi.fn<typeof orgIdFromContext>();
const jsonErrorMock = vi.fn<typeof jsonError>();
const getCompanionMock = vi.fn<typeof getCompanion>();
const createSessionMock = vi.fn<typeof createCompanionTranscriptionSession>();
const transcribeMock = vi.fn<typeof transcribeCompanionAudio>();
let tenantContextActive = false;

async function withTenantContext<T>(
  _input: { orgId: string; userId: string },
  fn: (database: typeof db) => Promise<T>,
): Promise<T> {
  tenantContextActive = true;
  try {
    return await fn(database);
  } finally {
    tenantContextActive = false;
  }
}

function appWithRoutes() {
  const app = new Hono<{ Variables: ApiVariables }>();
  registerCompanionRoutes(app, {
    COMPANION_COMPANIONS_ENABLED: "true",
    COMPANION_COMPANIONS_ALLOWED_EMAIL_DOMAINS: "example.test",
    COMPANION_GEMINI_TRANSCRIPTION_API_KEY: API_KEY,
  }, {
    actorFromContext: actorMock,
    orgIdFromContext: orgMock,
    jsonError: jsonErrorMock,
    withTenantContext,
    getCompanion: getCompanionMock,
    createCompanionTranscriptionSession: createSessionMock,
    transcribeCompanionAudio: transcribeMock,
  });
  return app;
}

function audioForm(bytes = new Uint8Array([
  0, 0, 0, 20, 102, 116, 121, 112, 77, 52, 65, 32,
])): FormData {
  const form = new FormData();
  form.append("audio", new File([bytes], "recording.m4a", { type: "audio/mp4" }));
  return form;
}

describe("Companion contextual transcription API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tenantContextActive = false;
    actorMock.mockReturnValue(actor);
    orgMock.mockResolvedValue(ORG_ID);
    jsonErrorMock.mockImplementation((_context, error, status = 400) => Response.json({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }, { status }));
    // SAFETY: this focused route fixture supplies the only field the route reads (`access`).
    getCompanionMock.mockResolvedValue(companion("owner") as Companion);
    createSessionMock.mockImplementation(async () => {
      if (!tenantContextActive) throw new Error("credential exchange escaped tenant context");
      return {
        token: "ephemeral-session-token",
        expires_at: "2026-08-27T10:10:00.000Z",
        model: "gemini-3.5-transcribe-live",
      };
    });
    transcribeMock.mockImplementation(async () => {
      if (!tenantContextActive) throw new Error("transcription escaped tenant context");
      return { transcript: "Envoie le devis à Camille." };
    });
  });

  it("keeps the deprecated live-session endpoint working for installed clients", async () => {
    const response = await appWithRoutes().request(new Request(
      `http://localhost/v1/companions/${COMPANION_ID}/transcription-sessions`,
      { method: "POST", body: "{}", headers: { "content-type": "application/json" } },
    ));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      token: "ephemeral-session-token",
      expires_at: "2026-08-27T10:10:00.000Z",
      model: "gemini-3.5-transcribe-live",
    });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(createSessionMock).toHaveBeenCalledWith(expect.objectContaining({
      actor,
      orgId: ORG_ID,
      companionId: COMPANION_ID,
      apiKey: API_KEY,
    }));
  });

  it("authorizes, accepts one compressed recording, and returns only the transcript", async () => {
    const response = await appWithRoutes().request(new Request(
      `http://localhost/v1/companions/${COMPANION_ID}/transcriptions`,
      { method: "POST", body: audioForm() },
    ));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ transcript: "Envoie le devis à Camille." });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("pragma")).toBe("no-cache");
    expect(transcribeMock).toHaveBeenCalledWith(expect.objectContaining({
      actor,
      orgId: ORG_ID,
      companionId: COMPANION_ID,
      apiKey: API_KEY,
      contentType: "audio/mp4",
      audio: expect.any(Buffer),
    }));
  });

  it("allows an Editor and denies a Viewer before reading the body", async () => {
    // SAFETY: this focused route fixture supplies the only field the route reads (`access`).
    getCompanionMock.mockResolvedValue(companion("editor") as Companion);
    const editorResponse = await appWithRoutes().request(new Request(
      `http://localhost/v1/companions/${COMPANION_ID}/transcriptions`,
      { method: "POST", body: audioForm() },
    ));
    expect(editorResponse.status).toBe(200);

    vi.clearAllMocks();
    actorMock.mockReturnValue(actor);
    orgMock.mockResolvedValue(ORG_ID);
    jsonErrorMock.mockImplementation((_context, error, status = 400) => Response.json({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }, { status }));
    // SAFETY: this focused route fixture supplies the only field the route reads (`access`).
    getCompanionMock.mockResolvedValue(companion("viewer") as Companion);
    const viewerResponse = await appWithRoutes().request(new Request(
      `http://localhost/v1/companions/${COMPANION_ID}/transcriptions`,
      { method: "POST", body: audioForm(new Uint8Array(1024 * 1024)) },
    ));
    expect(viewerResponse.status).toBe(403);
    expect(transcribeMock).not.toHaveBeenCalled();
  });

  it("hides inaccessible Companions before accepting audio", async () => {
    getCompanionMock.mockRejectedValueOnce(new CompanionNotFoundError());
    const response = await appWithRoutes().request(new Request(
      `http://localhost/v1/companions/${COMPANION_ID}/transcriptions`,
      { method: "POST", body: audioForm() },
    ));
    expect(response.status).toBe(404);
    expect(transcribeMock).not.toHaveBeenCalled();
  });

  it("rejects extra fields, wrong media, malformed media, and oversized audio", async () => {
    const extra = audioForm();
    extra.append("model", "caller-choice");
    const extraResponse = await appWithRoutes().request(new Request(
      `http://localhost/v1/companions/${COMPANION_ID}/transcriptions`,
      { method: "POST", body: extra },
    ));
    expect(extraResponse.status).toBe(400);

    const wrong = new FormData();
    wrong.append("audio", new File(["not audio"], "recording.txt", { type: "text/plain" }));
    const wrongResponse = await appWithRoutes().request(new Request(
      `http://localhost/v1/companions/${COMPANION_ID}/transcriptions`,
      { method: "POST", body: wrong },
    ));
    expect(wrongResponse.status).toBe(400);

    const malformedResponse = await appWithRoutes().request(new Request(
      `http://localhost/v1/companions/${COMPANION_ID}/transcriptions`,
      { method: "POST", body: audioForm(new Uint8Array(12)) },
    ));
    expect(malformedResponse.status).toBe(400);

    const oversizedResponse = await appWithRoutes().request(new Request(
      `http://localhost/v1/companions/${COMPANION_ID}/transcriptions`,
      { method: "POST", body: audioForm(new Uint8Array(8 * 1024 * 1024 + 1)) },
    ));
    expect(oversizedResponse.status).toBe(400);
    expect(actorMock).toHaveBeenCalled();
  });

  it("does not expose credentials or provider payloads", async () => {
    transcribeMock.mockRejectedValueOnce(new CompanionProviderError(
      "provider_unavailable",
      "Voice transcription is temporarily unavailable. Try again.",
      "google",
    ));
    const response = await appWithRoutes().request(new Request(
      `http://localhost/v1/companions/${COMPANION_ID}/transcriptions`,
      { method: "POST", body: audioForm() },
    ));
    const body = await response.text();
    expect(response.status).toBe(422);
    expect(body).not.toContain(API_KEY);
    expect(body).not.toContain("googleapis");
  });
});
