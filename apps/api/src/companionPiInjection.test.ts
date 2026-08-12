import { describe, expect, it } from "vitest";
import { buildMcpAdapterInjection } from "./companionPiInjection";

describe("Pi MCP injection", () => {
  it("keeps labeled accounts distinct and writes only environment references", () => {
    const injected = buildMcpAdapterInjection([
      {
        id: "github-personal",
        label: "GitHub personal",
        transport: "http",
        url: "https://mcp.example.test/github",
        headers: { Authorization: "GITHUB_PERSONAL_TOKEN" },
        lifecycle: "lazy",
        direct_tools: false,
      },
      {
        id: "github-work",
        label: "GitHub work",
        transport: "stdio",
        command: "github-mcp-server",
        args: ["stdio"],
        env: { GITHUB_TOKEN: "GITHUB_WORK_TOKEN" },
        lifecycle: "keep-alive",
        direct_tools: ["search_repositories"],
      },
    ]);

    expect(injected.accounts).toEqual([
      expect.objectContaining({ id: "github-personal", label: "GitHub personal", transport: "http" }),
      expect.objectContaining({ id: "github-work", label: "GitHub work", transport: "stdio" }),
    ]);
    expect(new Set(injected.accounts.map((account) => account.adapter_name)).size).toBe(2);
    const serialized = JSON.stringify(injected.config);
    expect(serialized).toContain("${GITHUB_PERSONAL_TOKEN}");
    expect(serialized).toContain("${GITHUB_WORK_TOKEN}");
    expect(serialized).not.toContain("secret-value");
    expect(injected.config.settings).toMatchObject({
      hostConfigDiscovery: "off",
      sampling: false,
      elicitation: false,
    });
  });
});
