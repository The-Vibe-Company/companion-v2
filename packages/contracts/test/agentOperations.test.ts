import { describe, expect, it } from "vitest";

import {
  COMPANION_AGENT_OPERATION_REGISTRY,
  matchCompanionAgentOperation,
} from "../src/agentOperations";

describe("closed Companion Agent Auth operation registry", () => {
  it("has one unambiguous definition per method and path", () => {
    const keys = COMPANION_AGENT_OPERATION_REGISTRY.map(({ method, path }) => `${method} ${path}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("keeps the known parity-sensitive routes least-privileged", () => {
    expect(matchCompanionAgentOperation("GET", "/skills/demo/download")).toMatchObject({
      capability: "skills:read",
      transport: "rest",
    });
    expect(matchCompanionAgentOperation("POST", "/skills/demo/install")).toMatchObject({
      capability: "skills:read",
      transport: "rest",
    });
    expect(matchCompanionAgentOperation("DELETE", "/skills/demo/install")).toMatchObject({
      capability: "skills:read",
      transport: "rest",
    });
    expect(matchCompanionAgentOperation("GET", "/skills/demo/versions/1.2.3/files/content")).toMatchObject({
      capability: "skills:read",
      transport: "transfer-ticket-download",
    });
  });

  it("marks package byte routes as ticket-only and rejects arbitrary operations", () => {
    expect(matchCompanionAgentOperation("POST", "/skills")).toMatchObject({
      transport: "transfer-ticket-upload",
    });
    expect(matchCompanionAgentOperation("GET", "/skills/demo/versions/1.2.3/package")).toMatchObject({
      transport: "transfer-ticket-download",
    });
    expect(matchCompanionAgentOperation("GET", "/local-skills/companion/package")).toMatchObject({
      transport: "transfer-ticket-download",
    });
    expect(matchCompanionAgentOperation("DELETE", "/orgs/current/members/person")).toBeNull();
    expect(matchCompanionAgentOperation("POST", "/skills/demo/runs")).toBeNull();
  });
});
