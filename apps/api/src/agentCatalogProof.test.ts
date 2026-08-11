import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { signAgentCatalogProof, verifyAgentCatalogProof, type AgentCatalogProofPayload } from "./agentCatalogProof";

const payload: AgentCatalogProofPayload = {
  v: 1,
  snapshot_id: "snapshot",
  workspace_id: "workspace",
  user_id: "user",
  agent_id: "agent",
  skill_id: "skill",
  version_id: "version-id",
  slug: "demo",
  version: "1.0.0",
  checksum: `sha256:${"a".repeat(64)}`,
  size_bytes: 42,
  root_ids: ["root"],
  exp: 2_000_000_000,
};

describe("agent catalog proofs", () => {
  const previous = process.env.COMPANION_CATALOG_SIGNING_KEY;
  beforeEach(() => {
    process.env.COMPANION_CATALOG_SIGNING_KEY = "test-catalog-signing-key";
  });
  afterEach(() => {
    if (previous === undefined) delete process.env.COMPANION_CATALOG_SIGNING_KEY;
    else process.env.COMPANION_CATALOG_SIGNING_KEY = previous;
  });

  it("round-trips an immutable package authorization", () => {
    expect(verifyAgentCatalogProof(signAgentCatalogProof(payload), 1_900_000_000_000)).toEqual(payload);
  });

  it("rejects substitution and expiry", () => {
    const proof = signAgentCatalogProof(payload);
    expect(() => verifyAgentCatalogProof(`${proof.slice(0, -1)}x`, 1_900_000_000_000)).toThrow("invalid");
    expect(() => verifyAgentCatalogProof(proof, 2_000_000_000_000)).toThrow("expired");
  });
});
