import { describe, expect, it, vi } from "vitest";
import {
  BoxRuntimeProviderError,
  type BoxDeletionOperation,
  type BoxMaintenanceClient,
} from "@companion/box-runtime";
import {
  COMPANION_PURGE_LOCK_CLASS_ID,
  COMPANION_PURGE_LOCK_OBJECT_ID,
  assertCompanionPurgeDisabled,
  buildLegacyPurgeInventory,
  companionPurgeDatabaseUrl,
  legacyRowCountTotal,
  parseCompanionPurgeArgs,
  processLegacyPurgeTarget,
  recognizeLegacyCompanionBoxName,
  type LegacyDatabaseInventory,
  type LegacyPurgeLedgerTarget,
  type LegacyTargetJournal,
} from "./companionPurge";

const COMPANION_ID = "123e4567-e89b-42d3-a456-426614174000";
const ORG_ID = "223e4567-e89b-42d3-a456-426614174001";
const OWNER_ID = "owner-with spaces@example.test";
const DELETED_OWNER_ID = "323e4567-e89b-42d3-a456-426614174002";
const BOX_ID = "bx_23456789";
const SECOND_BOX_ID = "bx_abcdefgh";
const THIRD_BOX_ID = "bx_jkmnpqrs";
const OPERATION_ID = "bdop_00000000000000000000000000000001";

function operation(status: BoxDeletionOperation["status"]): BoxDeletionOperation {
  return {
    id: OPERATION_ID,
    targetId: BOX_ID,
    status,
    attemptCount: status === "pending" ? 0 : 1,
    requestedAt: "2026-08-16T00:00:00.000Z",
    completedAt: status === "completed" ? "2026-08-16T00:00:01.000Z" : null,
  };
}

function databaseInventory(): LegacyDatabaseInventory {
  return {
    companions: [],
    pools: [],
    personalOwnerIds: [OWNER_ID],
    rowCounts: {
      companions: 0,
      runtimePools: 0,
      workspaceAccess: 0,
      memberState: 0,
      threads: 0,
      transcriptEntries: 0,
      reconcileLeases: 0,
      companionTokens: 0,
    },
  };
}

function ledgerTarget(overrides: Partial<LegacyPurgeLedgerTarget> = {}): LegacyPurgeLedgerTarget {
  return {
    boxId: BOX_ID,
    observedName: `Companion ${COMPANION_ID}`,
    evidence: ["provider-name:companion"],
    state: "discovered",
    operationId: null,
    attemptCount: 0,
    lastError: null,
    ...overrides,
  };
}

function fakeJournal(events: string[]): LegacyTargetJournal {
  return {
    async markRequesting(boxId) {
      events.push(`requesting:${boxId}`);
    },
    async markAbsent(boxId) {
      events.push(`absent:${boxId}`);
    },
    async markOperation(boxId, current, polled) {
      events.push(`${polled ? "poll" : "accepted"}:${boxId}:${current.id}:${current.status}`);
    },
    async markError(boxId, error) {
      events.push(`error:${boxId}:${error}`);
    },
  };
}

describe("legacy Companion purge CLI guards", () => {
  it("shares the exact migrator advisory lock without importing its executable entrypoint", () => {
    expect(COMPANION_PURGE_LOCK_CLASS_ID).toBe(72_401);
    expect(COMPANION_PURGE_LOCK_OBJECT_ID).toBe(20_260_608);
  });

  it("accepts only the three documented invocations", () => {
    expect(parseCompanionPurgeArgs(["report"])).toEqual({
      command: "report", dryRun: false, confirmed: false,
    });
    expect(parseCompanionPurgeArgs(["purge", "--dry-run"])).toEqual({
      command: "purge", dryRun: true, confirmed: false,
    });
    expect(parseCompanionPurgeArgs(["purge", "--confirm-delete-all-companions"])).toEqual({
      command: "purge", dryRun: false, confirmed: true,
    });
  });

  it.each([
    [[]],
    [["purge"]],
    [["report", "--dry-run"]],
    [["purge", "--confirm-delete-all-companions", "--dry-run"]],
    [["purge", "--force"]],
  ])("rejects unsupported arguments %j", (argv) => {
    expect(() => parseCompanionPurgeArgs(argv)).toThrow(/usage/);
  });

  it("requires an explicit false master flag, independent of the allowlist", () => {
    expect(() => assertCompanionPurgeDisabled({ COMPANION_COMPANIONS_ENABLED: " false " }))
      .not.toThrow();
    expect(() => assertCompanionPurgeDisabled({
      COMPANION_COMPANIONS_ENABLED: " TrUe ",
      COMPANION_COMPANIONS_ALLOWED_EMAIL_DOMAINS: "",
    })).toThrow(/explicitly set to false/);
    expect(() => assertCompanionPurgeDisabled({})).toThrow(/explicitly set to false/);
  });

  it("never falls back to DATABASE_URL", () => {
    expect(companionPurgeDatabaseUrl({ DATABASE_MIGRATION_URL: " postgres://owner " }))
      .toBe("postgres://owner");
    expect(() => companionPurgeDatabaseUrl({ DATABASE_URL: "postgres://api" }))
      .toThrow(/DATABASE_MIGRATION_URL/);
  });

  it("counts every legacy database family for terminal verification", () => {
    const counts = databaseInventory().rowCounts;
    counts.companions = 1;
    counts.companionTokens = 2;
    expect(legacyRowCountTotal(counts)).toBe(3);
  });
});

describe("exact legacy Box names", () => {
  const owners = new Set([OWNER_ID]);

  it.each([
    [`Companion ${COMPANION_ID}`, "companion"],
    [`Companion org ${ORG_ID}`, "org"],
    [`Companion personal ${OWNER_ID}`, "personal"],
    [`Companion personal ${DELETED_OWNER_ID}`, "personal"],
    [`Retired Companion ${COMPANION_ID} 1786900000000`, "retired-companion"],
    [`Retired Companion org ${ORG_ID} 1`, "retired-org"],
    [`Retired Companion personal ${OWNER_ID} 999`, "retired-personal"],
  ])("recognizes %s", (name, expected) => {
    expect(recognizeLegacyCompanionBoxName(name, owners)).toBe(expected);
  });

  it.each([
    `Companion ${COMPANION_ID} g1`,
    `Companion  ${COMPANION_ID}`,
    `Companion org ${ORG_ID} `,
    "Companion personal missing-owner",
    "Companion personal missing owner",
    `Retired Companion ${COMPANION_ID}`,
    `Retired Companion ${COMPANION_ID} timestamp`,
    `Retired Retired Companion ${COMPANION_ID} 1`,
  ])("excludes near-match %s", (name) => {
    expect(recognizeLegacyCompanionBoxName(name, owners)).toBeNull();
  });
});

describe("legacy purge inventory", () => {
  it("unions DB ids and exact provider names, deduplicates evidence, and reports near-misses", () => {
    const database = databaseInventory();
    database.companions.push({ id: COMPANION_ID, boxId: BOX_ID });
    database.pools.push({
      id: ORG_ID,
      scope: "org",
      ownerId: null,
      boxId: BOX_ID,
    });
    const inventory = buildLegacyPurgeInventory(database, [
      { id: BOX_ID, name: "renamed by operator" },
      { id: SECOND_BOX_ID, name: `Retired Companion personal ${OWNER_ID} 123` },
      { id: THIRD_BOX_ID, name: `Companion ${COMPANION_ID} g1` },
      { id: "bx_npqrstuv", name: "unrelated" },
    ]);

    expect(inventory.targets).toEqual([
      {
        boxId: BOX_ID,
        observedName: "renamed by operator",
        evidence: [
          `database:companion:${COMPANION_ID}`,
          `database:runtime-pool:${ORG_ID}:org`,
        ],
        providerPresent: true,
      },
      {
        boxId: SECOND_BOX_ID,
        observedName: `Retired Companion personal ${OWNER_ID} 123`,
        evidence: ["provider-name:retired-personal"],
        providerPresent: true,
      },
    ]);
    expect(inventory.excludedProviderBoxes).toEqual([
      { boxId: THIRD_BOX_ID, name: `Companion ${COMPANION_ID} g1` },
    ]);
    expect(inventory.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("keeps a DB-owned id as a target when the provider no longer lists it", () => {
    const database = databaseInventory();
    database.companions.push({ id: COMPANION_ID, boxId: BOX_ID });
    expect(buildLegacyPurgeInventory(database, []).targets).toEqual([
      expect.objectContaining({ boxId: BOX_ID, providerPresent: false }),
    ]);
  });
});

describe("durable provider deletion state machine", () => {
  it("persists requesting and the operation id before polling through completion", async () => {
    const events: string[] = [];
    const logs: string[] = [];
    const client: BoxMaintenanceClient = {
      listAllBoxes: vi.fn(),
      requestPermanentDeletion: vi.fn(async () => ({
        outcome: "accepted" as const,
        operation: operation("pending"),
      })),
      getDeletionOperation: vi.fn()
        .mockResolvedValueOnce(operation("processing"))
        .mockResolvedValueOnce(operation("completed")),
    };

    await processLegacyPurgeTarget({
      target: ledgerTarget(),
      boxClient: client,
      journal: fakeJournal(events),
      log: (message) => logs.push(message),
      pause: async () => undefined,
      nowMs: () => 0,
      pollTimeoutMs: 1_000,
    });

    expect(events).toEqual([
      `requesting:${BOX_ID}`,
      `accepted:${BOX_ID}:${OPERATION_ID}:pending`,
      `poll:${BOX_ID}:${OPERATION_ID}:processing`,
      `poll:${BOX_ID}:${OPERATION_ID}:completed`,
    ]);
    expect(logs.join("\n")).toContain(OPERATION_ID);
  });

  it("treats DELETE 404 as absent and does not poll", async () => {
    const events: string[] = [];
    const client: BoxMaintenanceClient = {
      listAllBoxes: vi.fn(),
      requestPermanentDeletion: vi.fn(async () => ({ outcome: "absent" as const, boxId: BOX_ID })),
      getDeletionOperation: vi.fn(),
    };
    await processLegacyPurgeTarget({
      target: ledgerTarget(),
      boxClient: client,
      journal: fakeJournal(events),
      pause: async () => undefined,
    });
    expect(events).toEqual([`requesting:${BOX_ID}`, `absent:${BOX_ID}`]);
    expect(client.getDeletionOperation).not.toHaveBeenCalled();
  });

  it("resumes a retained operation id without issuing a second DELETE", async () => {
    const events: string[] = [];
    const client: BoxMaintenanceClient = {
      listAllBoxes: vi.fn(),
      requestPermanentDeletion: vi.fn(),
      getDeletionOperation: vi.fn(async () => operation("completed")),
    };
    await processLegacyPurgeTarget({
      target: ledgerTarget({ state: "processing", operationId: OPERATION_ID }),
      boxClient: client,
      journal: fakeJournal(events),
      pause: async () => undefined,
      nowMs: () => 0,
    });
    expect(client.requestPermanentDeletion).not.toHaveBeenCalled();
    expect(events).toEqual([`poll:${BOX_ID}:${OPERATION_ID}:completed`]);
  });

  it("persists blocked and refuses to advance", async () => {
    const events: string[] = [];
    const client: BoxMaintenanceClient = {
      listAllBoxes: vi.fn(),
      requestPermanentDeletion: vi.fn(async () => ({
        outcome: "accepted" as const,
        operation: operation("blocked"),
      })),
      getDeletionOperation: vi.fn(),
    };
    await expect(processLegacyPurgeTarget({
      target: ledgerTarget(),
      boxClient: client,
      journal: fakeJournal(events),
      pause: async () => undefined,
    })).rejects.toThrow(/blocked/);
    expect(events).toEqual([
      `requesting:${BOX_ID}`,
      `accepted:${BOX_ID}:${OPERATION_ID}:blocked`,
      `error:${BOX_ID}:Box deletion operation ${OPERATION_ID} is blocked`,
    ]);
  });

  it("stores only status and stable code for a provider error", async () => {
    const events: string[] = [];
    const client: BoxMaintenanceClient = {
      listAllBoxes: vi.fn(),
      requestPermanentDeletion: vi.fn(async () => {
        throw new BoxRuntimeProviderError("secret provider payload", 503, "provider_busy");
      }),
      getDeletionOperation: vi.fn(),
    };
    await expect(processLegacyPurgeTarget({
      target: ledgerTarget(),
      boxClient: client,
      journal: fakeJournal(events),
      pause: async () => undefined,
    })).rejects.toThrow("secret provider payload");
    expect(events).toContain(`error:${BOX_ID}:Box API request failed with status 503 (provider_busy)`);
    expect(events.join(" ")).not.toContain("secret provider payload");
  });
});
