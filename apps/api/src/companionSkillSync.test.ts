import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const coreMocks = vi.hoisted(() => ({
  bumpCompanionSkillsRevisionForSkill: vi.fn(async () => undefined),
  claimCompanionRuntimeStart: vi.fn(),
  companionsEnabled: vi.fn((env: NodeJS.ProcessEnv) =>
    env.COMPANION_COMPANIONS_ENABLED === "true"
      && env.COMPANION_COMPANIONS_ALLOWED_EMAIL_DOMAINS === "example.test"),
  listCompanionRuntimeSkillPackages: vi.fn(async () => []),
  listOnlineCompanionsForSkillSync: vi.fn(async () => [] as Array<{ id: string; ownerId: string; boxId: string }>),
  resolveCompanionPluginInjection: vi.fn(async () => ({ accounts: [], credentials: [] })),
  resolveCompanionProviderAuth: vi.fn(async () => ({
    providerId: "anthropic",
    authEntry: { type: "api_key" },
    credentialGeneration: "22222222-2222-4222-8222-222222222222",
  })),
  updateCompanionRuntime: vi.fn(async () => undefined),
}));

const dbMocks = vi.hoisted(() => ({
  withTenantContext: vi.fn(async (
    _ctx: { orgId: string; userId: string },
    fn: (database: unknown) => Promise<unknown>,
  ) => fn({ tenant: true })),
}));

const packageMocks = vi.hoisted(() => ({
  getCompanionSkillPackage: vi.fn(async () => ({ version: "9.9.9" })),
}));

vi.mock("@companion/core", () => coreMocks);
vi.mock("@companion/db", () => dbMocks);
vi.mock("@companion/companion-skill", () => ({
  COMPANION_SKILL_KEY: "companion",
  companionSkillDir: () => "/tmp/companion-skill",
}));
vi.mock("@companion/skills", () => ({
  packDir: vi.fn(async () => ({ checksum: "sha256:bundled", archive: Buffer.from("bundled") })),
  skillChecksum: vi.fn(() => "sha256:match"),
  toTar: vi.fn((archive: Buffer) => archive),
}));
vi.mock("@companion/storage", () => ({
  getSkillArchive: vi.fn(async () => Buffer.from("stored")),
}));
vi.mock("@companion/box-runtime", () => ({
  AsciiBoxCompanionRuntime: class {},
  COMPANION_PI_DISK_LAYOUT_VERSION: 9,
  ...packageMocks,
}));

import { syncPublishedSkillToOnlineCompanions } from "./companionSkillSync";

const actor = { id: "user-1", email: "owner@example.test", name: "Owner" };
const orgId = "00000000-0000-4000-8000-000000000001";
const skillId = "33333333-3333-4333-8333-333333333333";
const companionId = "11111111-1111-4111-8111-111111111111";

function claimedCompanion(skillsRevision: number) {
  return {
    id: companionId,
    model_id: "claude-opus-4-8",
    persona: null,
    runtime: {
      box_id: "bx_23456789",
      provider_credential_generation: "22222222-2222-4222-8222-222222222222",
      disk_layout_version: 9,
      skills_revision: skillsRevision,
    },
  };
}

type ObservedState = {
  boxId: string;
  runtimeState: "running" | "stopped" | "stopping";
  daemonState: "running" | "stopped";
  desktopAvailable: boolean;
  staged?: boolean;
};

function runtimeFactory(start: () => Promise<ObservedState> = async () => ({
  boxId: "bx_23456789",
  runtimeState: "running",
  daemonState: "running",
  desktopAvailable: false,
})) {
  const mocked = vi.fn(start);
  return { start: mocked, factory: () => ({ start: mocked } as never) };
}

describe("syncPublishedSkillToOnlineCompanions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("COMPANION_COMPANIONS_ENABLED", "true");
    vi.stubEnv("COMPANION_COMPANIONS_ALLOWED_EMAIL_DOMAINS", "example.test");
    dbMocks.withTenantContext.mockImplementation(async (_ctx, fn) => fn({ tenant: true }));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("does nothing before touching PostgreSQL or Box when Companions are disabled", async () => {
    vi.stubEnv("COMPANION_COMPANIONS_ENABLED", "false");
    const factory = vi.fn(() => ({ start: vi.fn() } as never));

    await syncPublishedSkillToOnlineCompanions({ orgId, skillId, actor, runtimeFactory: factory });

    expect(dbMocks.withTenantContext).not.toHaveBeenCalled();
    expect(coreMocks.bumpCompanionSkillsRevisionForSkill).not.toHaveBeenCalled();
    expect(factory).not.toHaveBeenCalled();
  });

  it("bumps the desired revision for every selector even when no Box is Online", async () => {
    coreMocks.listOnlineCompanionsForSkillSync.mockResolvedValue([]);

    await syncPublishedSkillToOnlineCompanions({ orgId, skillId, actor });

    expect(coreMocks.bumpCompanionSkillsRevisionForSkill).toHaveBeenCalledWith({
      orgId,
      skillId,
      database: { tenant: true },
    });
    expect(coreMocks.updateCompanionRuntime).not.toHaveBeenCalled();
  });

  it("records the claimed revision as applied after a successful push", async () => {
    coreMocks.listOnlineCompanionsForSkillSync.mockResolvedValue([
      { id: companionId, ownerId: "user-1", boxId: "bx_23456789" },
    ]);
    coreMocks.claimCompanionRuntimeStart.mockResolvedValue(claimedCompanion(4));
    const { factory } = runtimeFactory();

    await syncPublishedSkillToOnlineCompanions({ orgId, skillId, actor, runtimeFactory: factory });

    expect(coreMocks.updateCompanionRuntime).toHaveBeenCalledWith(expect.objectContaining({
      companionId,
      patch: expect.objectContaining({
        skillsAppliedRevision: 4,
        skillsLastError: null,
      }),
    }));
  });

  it("records the failure on the row instead of swallowing it, without failing the publish", async () => {
    coreMocks.listOnlineCompanionsForSkillSync.mockResolvedValue([
      { id: companionId, ownerId: "user-1", boxId: "bx_23456789" },
    ]);
    coreMocks.claimCompanionRuntimeStart.mockResolvedValue(claimedCompanion(4));
    const { factory } = runtimeFactory(async () => {
      throw new Error("Box exec timed out");
    });

    await expect(
      syncPublishedSkillToOnlineCompanions({ orgId, skillId, actor, runtimeFactory: factory }),
    ).resolves.toBeUndefined();

    expect(coreMocks.updateCompanionRuntime).toHaveBeenCalledWith(expect.objectContaining({
      companionId,
      patch: { skillsLastError: "Box exec timed out" },
    }));
  });

  it("stays silent when even the failure write fails", async () => {
    coreMocks.listOnlineCompanionsForSkillSync.mockResolvedValue([
      { id: companionId, ownerId: "user-1", boxId: "bx_23456789" },
    ]);
    coreMocks.claimCompanionRuntimeStart.mockRejectedValue(new Error("claim conflict"));
    coreMocks.updateCompanionRuntime.mockRejectedValue(new Error("row is gone"));

    await expect(
      syncPublishedSkillToOnlineCompanions({ orgId, skillId, actor, runtimeFactory: () => ({} as never) }),
    ).resolves.toBeUndefined();
  });

  it("does not record applied for a start that reports it staged nothing", async () => {
    coreMocks.listOnlineCompanionsForSkillSync.mockResolvedValue([
      { id: companionId, ownerId: "user-1", boxId: "bx_23456789" },
    ]);
    coreMocks.claimCompanionRuntimeStart.mockResolvedValue(claimedCompanion(4));
    const { factory } = runtimeFactory(async () => ({
      boxId: "bx_23456789",
      runtimeState: "running",
      daemonState: "running",
      desktopAvailable: false,
      staged: false,
    }));

    await syncPublishedSkillToOnlineCompanions({ orgId, skillId, actor, runtimeFactory: factory });

    expect(coreMocks.updateCompanionRuntime).not.toHaveBeenCalled();
  });

  it.each(["stopping", "stopped"] as const)(
    "settles the apply-only start claim when the Box reports %s",
    async (archiveState) => {
    coreMocks.listOnlineCompanionsForSkillSync.mockResolvedValue([
      { id: companionId, ownerId: "user-1", boxId: "bx_23456789" },
    ]);
    coreMocks.claimCompanionRuntimeStart.mockResolvedValue(claimedCompanion(4));
    const { start, factory } = runtimeFactory(async () => ({
      boxId: "bx_23456789",
      runtimeState: archiveState,
      daemonState: "stopped",
      desktopAvailable: false,
    }));

    await syncPublishedSkillToOnlineCompanions({ orgId, skillId, actor, runtimeFactory: factory });

    expect(start).toHaveBeenCalledWith(expect.objectContaining({ allowBoxWake: false }));
    expect(coreMocks.updateCompanionRuntime).toHaveBeenCalledWith({
      actor,
      orgId,
      companionId,
      patch: {
        boxId: "bx_23456789",
        runtimeState: archiveState,
        daemonState: "stopped",
        desktopAvailable: false,
        observedAt: expect.any(Date),
      },
      database: { tenant: true },
    });
    },
  );

  it("does not record the revision applied when the Box did not come back running", async () => {
    coreMocks.listOnlineCompanionsForSkillSync.mockResolvedValue([
      { id: companionId, ownerId: "user-1", boxId: "bx_23456789" },
    ]);
    coreMocks.claimCompanionRuntimeStart.mockResolvedValue(claimedCompanion(4));
    const { factory } = runtimeFactory(async () => ({
      boxId: "bx_23456789",
      runtimeState: "stopped",
      daemonState: "stopped",
      desktopAvailable: false,
    }));

    await syncPublishedSkillToOnlineCompanions({ orgId, skillId, actor, runtimeFactory: factory });

    expect(coreMocks.updateCompanionRuntime).toHaveBeenCalledWith(expect.objectContaining({
      patch: expect.objectContaining({
        runtimeState: "stopped",
        daemonState: "stopped",
      }),
    }));
    expect(coreMocks.updateCompanionRuntime).not.toHaveBeenCalledWith(expect.objectContaining({
      patch: expect.objectContaining({ skillsAppliedRevision: expect.any(Number) }),
    }));
  });
});
