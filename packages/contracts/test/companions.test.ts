import { describe, expect, it } from "vitest";
import { startCompanionRuntimeInputSchema } from "../src/companions";

describe("Companion runtime injection contract", () => {
  it("accepts labeled multi-account MCP configuration with transient credential references", () => {
    const parsed = startCompanionRuntimeInputSchema.parse({
      client_surface: "mobile_web",
      credentials: [
        { provider: "github", env_key: "GITHUB_PERSONAL", value: "personal-secret" },
        { provider: "github", env_key: "GITHUB_WORK", value: "work-secret" },
      ],
      mcp_accounts: [
        {
          id: "github-personal",
          label: "GitHub personal",
          transport: "http",
          url: "https://mcp.example.test/github",
          headers: { Authorization: "GITHUB_PERSONAL" },
        },
        {
          id: "github-work",
          label: "GitHub work",
          transport: "stdio",
          command: "github-mcp-server",
          env: { GITHUB_TOKEN: "GITHUB_WORK" },
        },
      ],
    });

    expect(parsed.client_surface).toBe("mobile_web");
    expect(parsed.mcp_accounts).toHaveLength(2);
  });

  it("rejects duplicate labels and missing MCP credential references", () => {
    const result = startCompanionRuntimeInputSchema.safeParse({
      credentials: [],
      mcp_accounts: [
        {
          id: "one",
          label: "Work",
          transport: "http",
          url: "https://mcp.example.test/one",
          headers: { Authorization: "MISSING_TOKEN" },
        },
        {
          id: "two",
          label: "work",
          transport: "http",
          url: "https://mcp.example.test/two",
        },
      ],
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.message)).toEqual(expect.arrayContaining([
        "MCP account labels must be unique",
        "MCP environment reference MISSING_TOKEN has no matching credential",
      ]));
    }
  });
});

