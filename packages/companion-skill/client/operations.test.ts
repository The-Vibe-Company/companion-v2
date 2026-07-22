import { describe, expect, it } from "vitest";
import { COMPANION_AGENT_OPERATION_REGISTRY } from "@companion/contracts/agent-operations";

import { resolveOperation, resolveTicketedDownloadTarget } from "./operations.js";

describe("Companion Agent Auth operation registry", () => {
  it("maps documented operations to least-privilege capabilities", () => {
    expect(resolveOperation("GET", "/skills?lib=org")).toMatchObject({ capability: "skills:read" });
    expect(resolveOperation("POST", "/skills/hello/archive")).toMatchObject({ capability: "skills:write" });
    expect(resolveOperation("POST", "/secret-grants/redeem")).toMatchObject({
      capability: "secrets:read",
      sensitive: true,
    });
    expect(resolveOperation("POST", "/secrets/secret-id/rotate")).toMatchObject({
      capability: "secrets:write",
      sensitive: true,
    });
    expect(resolveOperation("GET", "/skills/hello/download")).toMatchObject({ capability: "skills:read" });
    expect(resolveOperation("POST", "/skills/hello/install")).toMatchObject({ capability: "skills:read" });
    expect(resolveOperation("DELETE", "/skills/hello/install")).toMatchObject({ capability: "skills:read" });
    expect(resolveOperation("GET", "/skills/hello/versions/1.2.3/files/content?path=SKILL.md")).toMatchObject({
      capability: "skills:read",
    });
  });

  it("resolves every operation from the shared source of truth", () => {
    for (const operation of COMPANION_AGENT_OPERATION_REGISTRY) {
      const concretePath = operation.path.replace(/:[^/]+/g, "example");
      const resolved = resolveOperation(operation.method, concretePath);
      expect(resolved.capability, `${operation.method} ${operation.path}`).toBe(operation.capability);
      expect(resolved.binary, `${operation.method} ${operation.path}`).toBe(
        operation.transport === "transfer-ticket-upload"
          ? "upload"
          : operation.transport === "transfer-ticket-download"
            ? "download"
            : undefined,
      );
      expect(resolved.sensitive, `${operation.method} ${operation.path}`).toBe(
        "sensitive" in operation && operation.sensitive === true,
      );
    }
  });

  it("uses the binary transport for package uploads and downloads", () => {
    expect(resolveOperation("POST", "/skills?scope=org").binary).toBe("upload");
    expect(resolveOperation("GET", "/skills/example/versions/1.2.3/package").binary).toBe("download");
  });

  it("parses package, exact-file, and local-skill ticket exchanges", () => {
    expect(resolveTicketedDownloadTarget("/skills/demo/versions/1.2.3/package")).toEqual({
      kind: "skill-package",
      slug: "demo",
      version: "1.2.3",
    });
    expect(resolveTicketedDownloadTarget("/skills/demo/versions/1.2.3/files/content?path=reference%2Fapi.md")).toEqual({
      kind: "skill-file",
      slug: "demo",
      version: "1.2.3",
      filePath: "reference/api.md",
    });
    expect(resolveTicketedDownloadTarget("/local-skills/companion/package")).toEqual({
      kind: "local-skill",
      slug: "companion",
    });
    expect(() => resolveTicketedDownloadTarget("/skills/demo/versions/1.2.3/files/content")).toThrow(/exact path/);
  });

  it("rejects arbitrary paths, methods, fragments, and absolute URLs", () => {
    expect(() => resolveOperation("POST", "/members")).toThrow(/not in/);
    expect(() => resolveOperation("DELETE", "/skills/example")).toThrow(/not in/);
    expect(() => resolveOperation("GET", "https://attacker.example/v1/skills")).toThrow(/relative/);
    expect(() => resolveOperation("GET", "/skills#ignored")).toThrow(/relative/);
    expect(() => resolveOperation("GET", "/skills/%2e%2e/secrets")).toThrow(/unsafe/);
    expect(() => resolveOperation("GET", "/skills/demo%2Fdownload")).toThrow(/unsafe/);
  });
});
