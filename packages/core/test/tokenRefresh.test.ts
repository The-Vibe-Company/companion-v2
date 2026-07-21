import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@companion/db";

const preTenantMocks = vi.hoisted(() => ({
  lockPreTenantApiTokenForRefresh: vi.fn(),
}));

vi.mock("../src/preTenant", async (importActual) => ({
  ...(await importActual<typeof import("../src/preTenant")>()),
  lockPreTenantApiTokenForRefresh: preTenantMocks.lockPreTenantApiTokenForRefresh,
}));

import { API_TOKEN_TTL_MS, ApiTokenRefreshError, refreshApiToken } from "../src/services";

function fakeDb() {
  const calls = {
    inserts: [] as Array<Record<string, unknown>>,
    updates: [] as Array<Record<string, unknown>>,
    execute: vi.fn(async () => []),
  };
  const database: Record<string, unknown> = {};
  database.transaction = vi.fn(async (fn: (tx: Db) => Promise<unknown>) => fn(database as unknown as Db));
  database.execute = calls.execute;
  database.insert = vi.fn(() => {
    const api = {
      values(value: Record<string, unknown>) {
        calls.inserts.push(value);
        return api;
      },
      returning: vi.fn(async () => [{ id: "replacement-id" }]),
      then(resolve: (value: unknown) => unknown) {
        return Promise.resolve(undefined).then(resolve);
      },
    };
    return api;
  });
  database.update = vi.fn(() => {
    const record: Record<string, unknown> = {};
    calls.updates.push(record);
    const api = {
      set(value: Record<string, unknown>) {
        record.patch = value;
        return api;
      },
      where(value: unknown) {
        record.where = value;
        return api;
      },
      then(resolve: (value: unknown) => unknown) {
        return Promise.resolve(undefined).then(resolve);
      },
    };
    return api;
  });
  return { database: database as unknown as Db, calls };
}

const candidate = {
  token_id: "old-token-id",
  org_id: "00000000-0000-4000-8000-000000000001",
  user_id: "user-1",
  token_name: "Companion token",
  scopes: ["skills:read", "skills:write"],
  expires_at: "2026-07-22T00:00:00.000Z",
  is_expired: false,
};

describe("refreshApiToken", () => {
  beforeEach(() => vi.clearAllMocks());

  it("leaves an active token unchanged and never returns its plaintext", async () => {
    preTenantMocks.lockPreTenantApiTokenForRefresh.mockResolvedValue(candidate);
    const { database, calls } = fakeDb();
    const result = await refreshApiToken("cmp_pat_active", database);
    expect(result).toEqual({
      status: "current",
      scopes: ["skills:read", "skills:write"],
      expires_at: "2026-07-22T00:00:00.000Z",
    });
    expect(result).not.toHaveProperty("token");
    expect(calls.inserts).toHaveLength(0);
    expect(calls.updates).toHaveLength(0);
  });

  it("replaces an expired token with the same name and scopes in one transaction", async () => {
    preTenantMocks.lockPreTenantApiTokenForRefresh.mockResolvedValue({ ...candidate, is_expired: true });
    const { database, calls } = fakeDb();
    const before = Date.now();
    const result = await refreshApiToken("cmp_pat_expired", database);

    expect(result.status).toBe("rotated");
    if (result.status !== "rotated") throw new Error("expected a rotated result");
    expect(result.token).toMatch(/^cmp_pat_[0-9a-f]{48}$/);
    expect(result.scopes).toEqual(candidate.scopes);
    expect(new Date(result.expires_at).getTime()).toBeGreaterThanOrEqual(before + API_TOKEN_TTL_MS);
    expect(calls.execute).toHaveBeenCalledTimes(1);
    expect(calls.inserts[0]).toMatchObject({
      orgId: candidate.org_id,
      userId: candidate.user_id,
      name: candidate.token_name,
      scopes: candidate.scopes,
    });
    expect(calls.inserts[0]).not.toHaveProperty("token", result.token);
    expect(calls.updates[0]?.patch).toMatchObject({ revokedAt: expect.any(Date) });
    expect(calls.inserts[1]).toMatchObject({
      action: "api_token.refresh",
      targetId: candidate.token_id,
      metadata: { replacementTokenId: "replacement-id" },
    });
    expect(JSON.stringify(calls.inserts)).not.toContain(result.token);
  });

  it("uses one generic error for malformed and ineligible credentials", async () => {
    const { database } = fakeDb();
    await expect(refreshApiToken("wrong-prefix", database)).rejects.toBeInstanceOf(ApiTokenRefreshError);
    preTenantMocks.lockPreTenantApiTokenForRefresh.mockResolvedValue(null);
    await expect(refreshApiToken("cmp_pat_too_old", database)).rejects.toThrow("token cannot be refreshed");
  });

  it("rejects invalid stored scopes before creating or revoking a token", async () => {
    preTenantMocks.lockPreTenantApiTokenForRefresh.mockResolvedValue({
      ...candidate,
      scopes: [],
      is_expired: true,
    });
    const { database, calls } = fakeDb();

    await expect(refreshApiToken("cmp_pat_invalid_scopes", database)).rejects.toBeInstanceOf(ApiTokenRefreshError);
    expect(calls.execute).not.toHaveBeenCalled();
    expect(calls.inserts).toHaveLength(0);
    expect(calls.updates).toHaveLength(0);
  });
});
