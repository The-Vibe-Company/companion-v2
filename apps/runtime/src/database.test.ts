import { describe, expect, it, vi } from "vitest";

import type { RuntimeServiceConfig } from "./config";
import {
  RUNTIME_DB_STATEMENT_TIMEOUT_MS,
  RuntimeDatabaseRoleError,
  runtimeDatabasePoolOptions,
  verifyRuntimeDatabaseRole,
} from "./database";

const validProfile = {
  currentRole: "companion_runtime_v2",
  canLogin: true,
  isSuperuser: false,
  bypassesRls: false,
  inheritsPrivileges: false,
  hasMemberships: false,
  hasDatabaseCreatePrivilege: false,
  hasPublicSchemaCreatePrivilege: false,
  ownsDatabaseOrSchema: false,
  ownsRelations: false,
  ownsFunctionsOrTypes: false,
  protectedRelationCount: 12,
  hasPublicRelationPrivileges: false,
  requiredFunctionsReady: true,
  ownsRequiredFunctions: false,
  hasUnexpectedDefinerGrant: false,
};

describe("runtime database pool options", () => {
  const configWithConcurrency = (concurrency: number): RuntimeServiceConfig =>
    ({ concurrency } as unknown as RuntimeServiceConfig);

  it("sizes the pool for concurrency * 2 + 4", () => {
    expect(runtimeDatabasePoolOptions(configWithConcurrency(1)).max).toBe(6);
    expect(runtimeDatabasePoolOptions(configWithConcurrency(4)).max).toBe(12);
    expect(runtimeDatabasePoolOptions(configWithConcurrency(8)).max).toBe(20);
  });

  it("bounds statements and tags the connection", () => {
    const options = runtimeDatabasePoolOptions(configWithConcurrency(4));
    expect(options.connection?.statement_timeout).toBe(RUNTIME_DB_STATEMENT_TIMEOUT_MS);
    expect(RUNTIME_DB_STATEMENT_TIMEOUT_MS).toBe(15_000);
    expect(options.connection?.application_name).toBe("companion-runtime");
  });

  it("keeps the existing idle and connect timeouts", () => {
    const options = runtimeDatabasePoolOptions(configWithConcurrency(4));
    expect(options.idle_timeout).toBe(30);
    expect(options.connect_timeout).toBe(10);
    expect(options.prepare).toBe(false);
  });
});

describe("runtime database role verification", () => {
  it("accepts only an isolated login with the exact narrow executor surface", async () => {
    let query = "";
    const unsafe = vi.fn(async (value: string) => {
      query = value;
      return [validProfile];
    });
    await expect(verifyRuntimeDatabaseRole(
      // SAFETY: The test double implements the single `unsafe` method consumed by the verifier.
      { unsafe } as never,
      "companion_runtime_v2",
    )).resolves.toBeUndefined();
    expect(unsafe).toHaveBeenCalledOnce();
    expect(query).toContain("pg_catalog.pg_auth_members");
    expect(query).toContain("has_database_privilege");
    expect(query).toContain("has_schema_privilege");
    expect(query).toContain("has_table_privilege");
    expect(query).toContain("companion_runtime_claim_work");
    expect(query).toContain("companion_runtime_renew_and_authorize");
  });

  it.each([
    ["a different login", { currentRole: "companion_api" }],
    ["a superuser", { isSuperuser: true }],
    ["a BYPASSRLS role", { bypassesRls: true }],
    ["an inheriting role", { inheritsPrivileges: true }],
    ["a role membership", { hasMemberships: true }],
    ["database CREATE", { hasDatabaseCreatePrivilege: true }],
    ["public schema CREATE", { hasPublicSchemaCreatePrivilege: true }],
    ["database or schema ownership", { ownsDatabaseOrSchema: true }],
    ["relation ownership", { ownsRelations: true }],
    ["function or type ownership", { ownsFunctionsOrTypes: true }],
    ["a partial protected schema", { protectedRelationCount: 9 }],
    ["direct public relation access", { hasPublicRelationPrivileges: true }],
    ["a missing required function grant", { requiredFunctionsReady: false }],
    ["required function ownership", { ownsRequiredFunctions: true }],
    ["an extra definer grant", { hasUnexpectedDefinerGrant: true }],
  ])("rejects %s", async (_label, override) => {
    // SAFETY: The test double implements the single `unsafe` method consumed by the verifier.
    await expect(verifyRuntimeDatabaseRole({
      unsafe: vi.fn(async () => [{ ...validProfile, ...override }]),
    } as never, "companion_runtime_v2")).rejects.toBeInstanceOf(RuntimeDatabaseRoleError);
  });

  it("fails closed for a missing profile", async () => {
    // SAFETY: The test double implements the single `unsafe` method consumed by the verifier.
    await expect(verifyRuntimeDatabaseRole({
      unsafe: vi.fn(async () => []),
    } as never, "companion_runtime_v2")).rejects.toBeInstanceOf(RuntimeDatabaseRoleError);
  });

  it("fails closed for a partial profile", async () => {
    const { hasMemberships: _missing, ...partial } = validProfile;
    // SAFETY: The test double implements the single `unsafe` method consumed by the verifier.
    await expect(verifyRuntimeDatabaseRole({
      unsafe: vi.fn(async () => [partial]),
    } as never, "companion_runtime_v2")).rejects.toBeInstanceOf(RuntimeDatabaseRoleError);
  });

  it("does not include connection or role values in a mismatch error", async () => {
    const secretRole = "role-that-should-not-be-echoed";
    let message = "";
    try {
      // SAFETY: The test double implements the single `unsafe` method consumed by the verifier.
      await verifyRuntimeDatabaseRole({
        unsafe: vi.fn(async () => [{ ...validProfile, currentRole: "other" }]),
      } as never, secretRole);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).not.toContain(secretRole);
  });
});
