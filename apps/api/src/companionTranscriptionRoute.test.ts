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
} from "@companion/core";
import { db } from "@companion/db";

const COMPANION_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "22222222-2222-4222-8222-222222222222";
const MASTER_KEY = Buffer.alloc(32, 7).toString("base64");
const actor = { id: "user-1", email: "owner@example.test", name: "Owner" };
const companion = (access: Companion["access"]): Pick<Companion, "access"> => ({ access });

const database = db;
const actorMock = vi.fn<typeof actorFromContext>();
const orgMock = vi.fn<typeof orgIdFromContext>();
const jsonErrorMock = vi.fn<typeof jsonError>();
const getCompanionMock = vi.fn<typeof getCompanion>();
const createSessionMock = vi.fn<typeof createCompanionTranscriptionSession>();
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
    COMPANION_SECRETS_MASTER_KEY: MASTER_KEY,
  }, {
    actorFromContext: actorMock,
    orgIdFromContext: orgMock,
    jsonError: jsonErrorMock,
    withTenantContext,
    getCompanion: getCompanionMock,
    createCompanionTranscriptionSession: createSessionMock,
  });
  return app;
}

describe("Companion transcription session API", () => {
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
  });

  it("authenticates, requires Owner/Editor access, and returns only ephemeral metadata", async () => {
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
    expect(response.headers.get("pragma")).toBe("no-cache");
    expect(createSessionMock).toHaveBeenCalledWith(expect.objectContaining({
      actor,
      orgId: ORG_ID,
      companionId: COMPANION_ID,
      masterKey: Buffer.alloc(32, 7),
    }));
  });

  it("allows an Editor to obtain the same shared transcription capability", async () => {
    // SAFETY: this focused route fixture supplies the only field the route reads (`access`).
    getCompanionMock.mockResolvedValue(companion("editor") as Companion);

    const response = await appWithRoutes().request(new Request(
      `http://localhost/v1/companions/${COMPANION_ID}/transcription-sessions`,
      { method: "POST", body: "{}" },
    ));

    expect(response.status).toBe(200);
    expect(createSessionMock).toHaveBeenCalledOnce();
  });

  it("denies Viewer access before the credential exchange", async () => {
    // SAFETY: this focused route fixture supplies the only field the route reads (`access`).
    getCompanionMock.mockResolvedValue(companion("viewer") as Companion);

    const response = await appWithRoutes().request(new Request(
      `http://localhost/v1/companions/${COMPANION_ID}/transcription-sessions`,
      { method: "POST", body: "{}" },
    ));

    expect(response.status).toBe(403);
    expect(createSessionMock).not.toHaveBeenCalled();
  });

  it("hides an inaccessible Companion, including a cross-tenant lookup", async () => {
    getCompanionMock.mockRejectedValueOnce(new CompanionNotFoundError());

    const response = await appWithRoutes().request(new Request(
      `http://localhost/v1/companions/${COMPANION_ID}/transcription-sessions`,
      { method: "POST", body: "{}" },
    ));

    expect(response.status).toBe(404);
    expect(createSessionMock).not.toHaveBeenCalled();
  });

  it("rejects caller audio or configuration instead of forwarding it", async () => {
    const response = await appWithRoutes().request(new Request(
      `http://localhost/v1/companions/${COMPANION_ID}/transcription-sessions`,
      {
        method: "POST",
        body: JSON.stringify({ audio: "raw-audio", model: "caller-model" }),
        headers: { "content-type": "application/json" },
      },
    ));

    expect(response.status).toBe(400);
    expect(createSessionMock).not.toHaveBeenCalled();
  });

  it("does not expose provider credential or Google error payloads", async () => {
    const providerKey = "google-long-lived-key";
    createSessionMock.mockRejectedValueOnce(new CompanionProviderError(
      "provider_unavailable",
      "Google Gemini transcription is temporarily unavailable. Try again.",
      "google",
    ));

    const response = await appWithRoutes().request(new Request(
      `http://localhost/v1/companions/${COMPANION_ID}/transcription-sessions`,
      { method: "POST", body: "{}" },
    ));
    const body = await response.text();

    expect(response.status).toBe(422);
    expect(body).not.toContain(providerKey);
    expect(body).not.toContain("googleapis");
  });
});
