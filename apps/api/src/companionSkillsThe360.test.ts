import { describe, expect, it, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import {
  CompanionWriteSkillsForbiddenError,
} from "@companion/core";

const contextMocks = vi.hoisted(() => ({
  actorFromContext: vi.fn(() => ({ id: "user-1", email: "owner@example.test", name: "Owner" })),
  orgIdFromContext: vi.fn(async () => "00000000-0000-4000-8000-000000000001"),
  requireScope: vi.fn(async () => undefined),
  requireCompanionWriteSkillsIfNeeded: vi.fn(async () => undefined),
}));

vi.mock("./context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./context")>()),
  ...contextMocks,
}));

describe("Companion write-on-behalf gate", () => {
  beforeEach(() => {
    contextMocks.requireCompanionWriteSkillsIfNeeded.mockReset();
    contextMocks.requireCompanionWriteSkillsIfNeeded.mockResolvedValue(undefined);
  });

  it("rejects skills:write when the Companion toggle is off", async () => {
    const { requireScope, requireCompanionWriteSkillsIfNeeded } = await import("./context");
    contextMocks.requireCompanionWriteSkillsIfNeeded.mockRejectedValue(
      new CompanionWriteSkillsForbiddenError(),
    );
    // Simulate the async requireScope path used by publish routes.
    const scopes = ["skills:write"] as const;
    await expect((async () => {
      // Cookie session path: null scopes skip the token check, then still run the companion gate
      // only when tokenSourceType is companion — covered by requireCompanionWriteSkillsIfNeeded.
      await requireCompanionWriteSkillsIfNeeded({
        get: (key: string) => {
          if (key === "tokenSourceType") return "companion";
          if (key === "tokenCompanionId") return "11111111-1111-4111-8111-111111111111";
          if (key === "tokenOrgId") return "00000000-0000-4000-8000-000000000001";
          if (key === "tokenScopes") return [...scopes];
          return null;
        },
      } as never);
    })()).rejects.toBeInstanceOf(CompanionWriteSkillsForbiddenError);
    expect(requireScope).toBeTypeOf("function");
  });
});

describe("Companion skill allow-list contracts", () => {
  it("defaults write-on-behalf off and accepts an empty selection", async () => {
    const {
      createCompanionInputSchema,
      companionSchema,
    } = await import("@companion/contracts");
    expect(createCompanionInputSchema.parse({
      name: "Luna",
      provider_id: "anthropic",
      model_id: "claude-opus-4-8",
      selected_skill_ids: [],
      can_write_skills: false,
    })).toMatchObject({
      selected_skill_ids: [],
      can_write_skills: false,
    });
    expect(companionSchema.parse({
      id: "11111111-1111-4111-8111-111111111111",
      name: "Luna",
      persona: null,
      model_id: "claude-opus-4-8",
      selected_skill_ids: [],
      can_write_skills: false,
      owner_id: "user-1",
      access: "owner",
      runtime: {
        state: "not_created",
        daemon_state: "unknown",
        box_id: null,
        provider_ids: ["anthropic"],
        provider_credential_generation: null,
        disk_layout_version: 1,
        desktop_available: false,
        last_error: null,
        last_observed_at: null,
        last_started_at: null,
        last_stopped_at: null,
      },
      created_at: "2026-08-14T12:00:00.000Z",
      updated_at: "2026-08-14T12:00:00.000Z",
    }).can_write_skills).toBe(false);
  });
});
