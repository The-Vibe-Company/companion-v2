import { describe, expect, it } from "vitest";

import {
  COMPANION_TRANSCRIPTION_MODEL,
  companionThreadSchema,
  companionTranscriptionSessionSchema,
  createCompanionTranscriptionSessionInputSchema,
} from "../src/companions";

describe("Companion transcription contracts", () => {
  it("accepts only the empty session request and the constrained session response", () => {
    expect(createCompanionTranscriptionSessionInputSchema.parse({})).toEqual({});
    expect(() => createCompanionTranscriptionSessionInputSchema.parse({ model: "caller-choice" }))
      .toThrow();
    expect(companionTranscriptionSessionSchema.parse({
      token: "ephemeral-token",
      expires_at: "2026-08-27T10:10:00.000Z",
      model: COMPANION_TRANSCRIPTION_MODEL,
    })).toEqual({
      token: "ephemeral-token",
      expires_at: "2026-08-27T10:10:00.000Z",
      model: COMPANION_TRANSCRIPTION_MODEL,
    });
  });

  it("does not permit a long-lived key, alternate model, or extra response fields", () => {
    expect(() => companionTranscriptionSessionSchema.parse({
      token: "deployment-google-key",
      expires_at: "2026-08-27T10:10:00.000Z",
      model: "gemini-3.1-pro-preview",
    })).toThrow();
    expect(() => companionTranscriptionSessionSchema.parse({
      token: "ephemeral-token",
      expires_at: "2026-08-27T10:10:00.000Z",
      model: COMPANION_TRANSCRIPTION_MODEL,
      api_key: "deployment-google-key",
    })).toThrow();
  });

  it("keeps transcription availability backward-compatible on thread projections", () => {
    const thread = {
      companion_id: "11111111-1111-4111-8111-111111111111",
      viewer_id: "user-1",
      access: "owner",
      read_only: false,
      can_send: true,
      entries: [],
      active_turn: null,
      queued_count: 0,
      interrupted_turn: null,
      last_message_at: null,
      last_read_ordinal: null,
    };

    expect(companionThreadSchema.parse(thread).transcription_available).toBeUndefined();
    expect(companionThreadSchema.parse({
      ...thread,
      transcription_available: true,
    }).transcription_available).toBe(true);
  });
});
