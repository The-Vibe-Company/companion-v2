import { describe, expect, it } from "vitest";

import { issueTokenInputSchema, tokenScopeSchema } from "../src/token";

describe("PAT issuance contract", () => {
  it("keeps the existing human scoped form compatible", () => {
    expect(issueTokenInputSchema.parse({ scopes: ["skills:read"], name: "automation" })).toEqual({
      scopes: ["skills:read"],
      name: "automation",
    });
  });

  it("accepts Agent Auth inheritance metadata without caller-selected scopes", () => {
    expect(issueTokenInputSchema.parse({
      inherit_agent_grants: true,
      name: "cloud workspace",
      ttl_seconds: 900,
      target_workspace_id: "conductor-workspace-1",
    })).toMatchObject({ inherit_agent_grants: true, ttl_seconds: 900 });
    expect(() => issueTokenInputSchema.parse({
      inherit_agent_grants: true,
      scopes: ["skills:write"],
    })).toThrow();
  });

  it("carries the public install capability while retaining database expansion compatibility", () => {
    expect(tokenScopeSchema.parse("public-skills:install")).toBe("public-skills:install");
    expect(tokenScopeSchema.parse("database:write")).toBe("database:write");
  });
});
