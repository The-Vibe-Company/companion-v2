import { describe, expect, it } from "vitest";

import {
  COMPANION_TRANSCRIPTION_MODEL,
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
      token: "workspace-google-key",
      expires_at: "2026-08-27T10:10:00.000Z",
      model: "gemini-3.1-pro-preview",
    })).toThrow();
    expect(() => companionTranscriptionSessionSchema.parse({
      token: "ephemeral-token",
      expires_at: "2026-08-27T10:10:00.000Z",
      model: COMPANION_TRANSCRIPTION_MODEL,
      api_key: "workspace-google-key",
    })).toThrow();
  });
});
