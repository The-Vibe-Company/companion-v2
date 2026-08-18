import { describe, expect, it, vi, beforeEach } from "vitest";
import { CompanionWriteSkillsForbiddenError } from "@companion/core";

const dbMocks = vi.hoisted(() => ({
  withTenantContext: vi.fn(async (
    _ctx: { orgId: string; userId: string },
    fn: (database: unknown) => Promise<unknown>,
  ) => fn({ tenant: true })),
}));

const coreMocks = vi.hoisted(() => ({
  assertCompanionCanWriteSkills: vi.fn(async () => undefined),
}));

vi.mock("@companion/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@companion/db")>()),
  withTenantContext: dbMocks.withTenantContext,
}));

vi.mock("@companion/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@companion/core")>()),
  assertCompanionCanWriteSkills: coreMocks.assertCompanionCanWriteSkills,
}));

// The gate never touches Better Auth, so replace `@companion/auth` outright instead of spreading the
// original: importing it would pull better-auth and its Drizzle adapter into this file for nothing.
vi.mock("@companion/auth", () => ({
  auth: { api: { getSession: vi.fn() }, $Infer: {} },
  authenticateAgentRequest: vi.fn(),
}));

// Load the module graph under test at collection time. `./context` reaches @companion/core and
// @companion/db, and a cold `await import("./context")` inside a test body spent more than the 5s
// default timeout on Node 20 CI runners (THE-363). Static imports run after the hoisted vi.mock
// calls above, so the mocks still apply — keep these imports static.
import { requireCompanionWriteSkillsIfNeeded } from "./context";
import { companionSchema, createCompanionInputSchema } from "@companion/contracts";

function companionContext(overrides: Record<string, unknown> = {}) {
  const values: Record<string, unknown> = {
    tokenSourceType: "companion",
    tokenCompanionId: "11111111-1111-4111-8111-111111111111",
    tokenOrgId: "00000000-0000-4000-8000-000000000001",
    tokenActor: { id: "user-1", email: "owner@example.test", name: "Owner" },
    ...overrides,
  };
  return {
    get: (key: string) => (key in values ? values[key] : null),
  } as never;
}

describe("Companion write-on-behalf gate", () => {
  beforeEach(() => {
    dbMocks.withTenantContext.mockClear();
    coreMocks.assertCompanionCanWriteSkills.mockReset();
    coreMocks.assertCompanionCanWriteSkills.mockResolvedValue(undefined);
  });

  it("skips the gate for non-companion tokens", async () => {
    await requireCompanionWriteSkillsIfNeeded(companionContext({ tokenSourceType: "pat" }));
    expect(dbMocks.withTenantContext).not.toHaveBeenCalled();
  }, 15_000);

  it("re-checks can_write_skills inside the token owner's tenant context", async () => {
    await requireCompanionWriteSkillsIfNeeded(companionContext());
    expect(dbMocks.withTenantContext).toHaveBeenCalledWith(
      { orgId: "00000000-0000-4000-8000-000000000001", userId: "user-1" },
      expect.any(Function),
    );
    expect(coreMocks.assertCompanionCanWriteSkills).toHaveBeenCalledWith({
      orgId: "00000000-0000-4000-8000-000000000001",
      companionId: "11111111-1111-4111-8111-111111111111",
      database: { tenant: true },
    });
  });

  it("rejects skills:write when the Companion toggle is off", async () => {
    coreMocks.assertCompanionCanWriteSkills.mockRejectedValue(
      new CompanionWriteSkillsForbiddenError(),
    );
    await expect(requireCompanionWriteSkillsIfNeeded(companionContext()))
      .rejects.toBeInstanceOf(CompanionWriteSkillsForbiddenError);
  });

  it("fails closed when companion provenance is missing an actor for the RLS re-check", async () => {
    await expect(requireCompanionWriteSkillsIfNeeded(companionContext({ tokenActor: null })))
      .rejects.toBeInstanceOf(CompanionWriteSkillsForbiddenError);
    expect(dbMocks.withTenantContext).not.toHaveBeenCalled();
  });
});

describe("Companion skill allow-list contracts", () => {
  it("defaults write-on-behalf off and accepts an empty selection", () => {
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
      selected_mcp_account_ids: [],
      owner_id: "user-1",
      access: "owner",
      pinned: false,
      hidden: false,
      unread: false,
      runtime: {
        generation: 1,
        state: "not_created",
        daemon_state: "unknown",
        box_id: null,
        provider_ids: ["anthropic"],
        provider_credential_generation: null,
        disk_layout_version: 1,
        desktop_available: false,
        last_error: null,
        skills_revision: 1,
        skills_applied_revision: 1,
        skills_applied_at: null,
        skills_last_error: null,
        last_observed_at: null,
        last_started_at: null,
        last_stopped_at: null,
      },
      created_at: "2026-08-14T12:00:00.000Z",
      updated_at: "2026-08-14T12:00:00.000Z",
    }).can_write_skills).toBe(false);
  });
});
