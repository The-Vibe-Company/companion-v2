import { describe, expect, it, vi } from "vitest";

import { RuntimeDatabaseRoleError, verifyRuntimeDatabaseRole } from "./database";

const validProfile = {
  currentRole: "companion_runtime_v2",
  canLogin: true,
  isSuperuser: false,
  bypassesRls: false,
  inheritsPrivileges: false,
  hasMemberships: false,
  ownsDatabaseOrSchema: false,
  ownsRelations: false,
  ownsFunctionsOrTypes: false,
  protectedRelationCount: 9,
  hasPublicRelationPrivileges: false,
  requiredFunctionsReady: true,
  ownsRequiredFunctions: false,
  hasUnexpectedDefinerGrant: false,
};

describe("runtime database role verification", () => {
  it("accepts only an isolated login with the exact narrow executor surface", async () => {
    let query = "";
    const unsafe = vi.fn(async (value: string) => {
      query = value;
      return [validProfile];
    });
    await expect(verifyRuntimeDatabaseRole(
      { unsafe } as never,
      "companion_runtime_v2",
    )).resolves.toBeUndefined();
    expect(unsafe).toHaveBeenCalledOnce();
    expect(query).toContain("pg_catalog.pg_auth_members");
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
    ["database or schema ownership", { ownsDatabaseOrSchema: true }],
    ["relation ownership", { ownsRelations: true }],
    ["function or type ownership", { ownsFunctionsOrTypes: true }],
    ["a partial protected schema", { protectedRelationCount: 8 }],
    ["direct public relation access", { hasPublicRelationPrivileges: true }],
    ["a missing required function grant", { requiredFunctionsReady: false }],
    ["required function ownership", { ownsRequiredFunctions: true }],
    ["an extra definer grant", { hasUnexpectedDefinerGrant: true }],
  ])("rejects %s", async (_label, override) => {
    await expect(verifyRuntimeDatabaseRole({
      unsafe: vi.fn(async () => [{ ...validProfile, ...override }]),
    } as never, "companion_runtime_v2")).rejects.toBeInstanceOf(RuntimeDatabaseRoleError);
  });

  it("fails closed for a missing profile", async () => {
    await expect(verifyRuntimeDatabaseRole({
      unsafe: vi.fn(async () => []),
    } as never, "companion_runtime_v2")).rejects.toBeInstanceOf(RuntimeDatabaseRoleError);
  });

  it("fails closed for a partial profile", async () => {
    const { hasMemberships: _missing, ...partial } = validProfile;
    await expect(verifyRuntimeDatabaseRole({
      unsafe: vi.fn(async () => [partial]),
    } as never, "companion_runtime_v2")).rejects.toBeInstanceOf(RuntimeDatabaseRoleError);
  });

  it("does not include connection or role values in a mismatch error", async () => {
    const secretRole = "role-that-should-not-be-echoed";
    let message = "";
    try {
      await verifyRuntimeDatabaseRole({
        unsafe: vi.fn(async () => [{ ...validProfile, currentRole: "other" }]),
      } as never, secretRole);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).not.toContain(secretRole);
  });
});
