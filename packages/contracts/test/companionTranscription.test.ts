import { describe, expect, it } from "vitest";

import {
  COMPANION_TRANSCRIPTION_AUDIO_CONTENT_TYPE,
  COMPANION_TRANSCRIPTION_AUDIO_MAX_BYTES,
  COMPANION_LEGACY_TRANSCRIPTION_MODEL,
  COMPANION_TRANSCRIPTION_MODEL,
  companionTranscriptionSessionSchema,
  createCompanionTranscriptionSessionInputSchema,
  companionThreadSchema,
  companionTranscriptionSchema,
} from "../src/companions";

describe("Companion transcription contracts", () => {
  it("fixes the model and compressed-audio envelope server-side", () => {
    expect(COMPANION_TRANSCRIPTION_MODEL).toBe("gemini-3.7-flash");
    expect(COMPANION_TRANSCRIPTION_AUDIO_CONTENT_TYPE).toBe("audio/mp4");
    expect(COMPANION_TRANSCRIPTION_AUDIO_MAX_BYTES).toBe(8 * 1024 * 1024);
  });

  it("returns only a bounded final transcript", () => {
    expect(companionTranscriptionSchema.parse({ transcript: "Bonjour Luna" })).toEqual({
      transcript: "Bonjour Luna",
    });
    expect(() => companionTranscriptionSchema.parse({
      transcript: "Bonjour Luna",
      model: COMPANION_TRANSCRIPTION_MODEL,
    })).toThrow();
    expect(() => companionTranscriptionSchema.parse({ transcript: "" })).toThrow();
  });

  it("keeps the deprecated live-session contract for installed clients", () => {
    expect(createCompanionTranscriptionSessionInputSchema.parse({})).toEqual({});
    expect(() => createCompanionTranscriptionSessionInputSchema.parse({ model: "caller-choice" }))
      .toThrow();
    expect(companionTranscriptionSessionSchema.parse({
      token: "ephemeral-token",
      expires_at: "2026-08-27T10:10:00.000Z",
      model: COMPANION_LEGACY_TRANSCRIPTION_MODEL,
    })).toEqual({
      token: "ephemeral-token",
      expires_at: "2026-08-27T10:10:00.000Z",
      model: "gemini-3.5-transcribe-live",
    });
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
