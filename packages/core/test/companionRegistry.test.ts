import { describe, expect, it, vi } from "vitest";
import {
  COMPANION_MCP_REGISTRY_PINS,
  CompanionRegistryCache,
  CompanionRegistryUnavailableError,
  deriveCompanionProviderSlug,
  getCompanionRegistryServer,
  listCompanionRegistry,
} from "../src/companionRegistry";

const baseUrl = "https://registry.test";

function registryPayload() {
  return {
    servers: [
      {
        server: {
          name: "io.example.acme/search",
          title: "Acme Search",
          description: "Search the Acme knowledge base.",
          version: "2.1.0",
          websiteUrl: "https://acme.test",
          remotes: [
            {
              type: "streamable-http",
              url: "https://mcp.acme.test/mcp",
              headers: [
                { name: "Authorization", isSecret: true, isRequired: false, description: "API token" },
              ],
            },
          ],
        },
        _meta: { "io.modelcontextprotocol.registry/official": { status: "active", isLatest: true } },
      },
      {
        server: {
          name: "io.github.tool/runner",
          description: "Run the tool.",
          version: "1.0.0",
          packages: [
            {
              registryType: "npm",
              identifier: "@tool/runner",
              transport: { type: "stdio" },
              environmentVariables: [{ name: "TOOL_TOKEN", isSecret: true, description: "Token" }],
            },
          ],
        },
        _meta: { "io.modelcontextprotocol.registry/official": { status: "active", isLatest: true } },
      },
      {
        server: { name: "io.example.old/deprecated", description: "Old.", version: "1.0.0" },
        _meta: { "io.modelcontextprotocol.registry/official": { status: "deprecated", isLatest: true } },
      },
      {
        server: { name: "io.example.gone/deleted", description: "Gone.", version: "1.0.0" },
        _meta: { "io.modelcontextprotocol.registry/official": { status: "deleted", isLatest: true } },
      },
      {
        server: {
          name: "io.github.github/github-mcp-server",
          description: "GitHub via stdio.",
          version: "1.9.0",
          packages: [
            { registryType: "oci", identifier: "ghcr.io/github/github-mcp-server:1.9.0", transport: { type: "stdio" } },
          ],
        },
        _meta: { "io.modelcontextprotocol.registry/official": { status: "active", isLatest: true } },
      },
    ],
    metadata: { nextCursor: "next123", count: 5 },
  };
}

function okFetch(payload: unknown) {
  return vi.fn(async () => ({ ok: true, json: async () => payload })) as unknown as typeof fetch;
}

describe("deriveCompanionProviderSlug", () => {
  it("uses the namespace brand label", () => {
    expect(deriveCompanionProviderSlug("app.linear/linear")).toBe("linear");
    expect(deriveCompanionProviderSlug("com.notion/mcp")).toBe("notion");
    expect(deriveCompanionProviderSlug("io.github.github/github-mcp-server")).toBe("github");
    expect(deriveCompanionProviderSlug("io.github.Evozim/linear-broker")).toBe("evozim");
  });

  it("always yields a valid provider slug", () => {
    expect(deriveCompanionProviderSlug("123.456/server")).toMatch(/^[a-z][a-z0-9-]{0,62}$/);
  });
});

describe("listCompanionRegistry", () => {
  it("maps, filters, applies pin overrides, and reports a live source", async () => {
    const cache = new CompanionRegistryCache();
    const fetchImpl = okFetch(registryPayload());

    const result = await listCompanionRegistry({ baseUrl, fetchImpl, cache });

    expect(result.source).toBe("live");
    expect(result.next_cursor).toBe("next123");
    expect(result.pins).toHaveLength(COMPANION_MCP_REGISTRY_PINS.length);
    // The GitHub registry entry is stdio/OCI only; the pin overrides it to the hosted remote.
    const githubPin = result.pins.find((pin) => pin.provider === "github");
    expect(githubPin?.connect).toEqual({
      transport: "http",
      url: "https://api.githubcopilot.com/mcp/",
      credential: null,
    });

    // Deprecated + deleted are filtered; the pinned GitHub name is removed from the browse list.
    expect(result.servers.map((server) => server.name)).toEqual([
      "io.example.acme/search",
      "io.github.tool/runner",
    ]);

    const [http, stdio] = result.servers;
    expect(http).toMatchObject({ provider: "acme", title: "Acme Search" });
    expect(http?.connect).toEqual({
      transport: "http",
      url: "https://mcp.acme.test/mcp",
      credential: { name: "Authorization", description: "API token", is_secret: true, required: false },
    });
    expect(stdio).toMatchObject({ provider: "tool" });
    expect(stdio?.connect).toEqual({
      transport: "stdio",
      command: "npx",
      args: ["-y", "@tool/runner"],
      credential: { name: "TOOL_TOKEN", description: "Token", is_secret: true, required: false },
    });
  });

  it("serves the TTL cache without a second fetch", async () => {
    const cache = new CompanionRegistryCache();
    const fetchImpl = okFetch(registryPayload());

    await listCompanionRegistry({ baseUrl, fetchImpl, cache });
    const second = await listCompanionRegistry({ baseUrl, fetchImpl, cache });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(second.source).toBe("cache");
    expect(second.servers).toHaveLength(2);
  });

  it("falls back to the last-good page when a later fetch fails", async () => {
    const cache = new CompanionRegistryCache();
    let clock = 1_000;
    const now = () => clock;
    const goodFetch = okFetch(registryPayload());

    await listCompanionRegistry({ baseUrl, fetchImpl: goodFetch, cache, now });

    // Age past the TTL so the next call attempts the network, which now fails.
    clock += 2 * 60 * 60 * 1000;
    const downFetch = vi.fn(async () => {
      throw new Error("registry down");
    }) as unknown as typeof fetch;
    const result = await listCompanionRegistry({ baseUrl, fetchImpl: downFetch, cache, now });

    expect(result.source).toBe("cache");
    expect(result.servers).toHaveLength(2);
    expect(result.pins).toHaveLength(COMPANION_MCP_REGISTRY_PINS.length);
  });

  it("returns pins only when the registry is cold and unavailable", async () => {
    const cache = new CompanionRegistryCache();
    const downFetch = vi.fn(async () => {
      throw new Error("registry down");
    }) as unknown as typeof fetch;

    const result = await listCompanionRegistry({ baseUrl, fetchImpl: downFetch, cache });

    expect(result.source).toBe("unavailable");
    expect(result.servers).toEqual([]);
    expect(result.pins.length).toBeGreaterThan(0);
  });

  it("omits pins while searching", async () => {
    const cache = new CompanionRegistryCache();
    const fetchImpl = okFetch(registryPayload());

    const result = await listCompanionRegistry({ baseUrl, fetchImpl, cache, search: "acme" });

    expect(result.pins).toEqual([]);
  });
});

describe("getCompanionRegistryServer", () => {
  it("returns a pinned server without touching the registry", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("should not be called");
    }) as unknown as typeof fetch;

    const result = await getCompanionRegistryServer({
      name: "app.linear/linear",
      baseUrl,
      fetchImpl,
      cache: new CompanionRegistryCache(),
    });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.server.provider).toBe("linear");
    expect(result.server.connect).toMatchObject({ transport: "http", url: "https://mcp.linear.app/mcp" });
  });

  it("proxies and caches a non-pinned detail read", async () => {
    const cache = new CompanionRegistryCache();
    const detail = {
      server: {
        name: "io.example.acme/search",
        title: "Acme Search",
        description: "Search.",
        version: "2.1.0",
        remotes: [{ type: "streamable-http", url: "https://mcp.acme.test/mcp" }],
      },
      _meta: { "io.modelcontextprotocol.registry/official": { status: "active", isLatest: true } },
    };
    const fetchImpl = okFetch(detail);

    const first = await getCompanionRegistryServer({ name: "io.example.acme/search", baseUrl, fetchImpl, cache });
    const second = await getCompanionRegistryServer({ name: "io.example.acme/search", baseUrl, fetchImpl, cache });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(first.source).toBe("live");
    expect(second.source).toBe("cache");
    expect(first.server.connect).toEqual({
      transport: "http",
      url: "https://mcp.acme.test/mcp",
      credential: null,
    });
  });

  it("throws when a cold detail read fails", async () => {
    const downFetch = vi.fn(async () => {
      throw new Error("down");
    }) as unknown as typeof fetch;

    await expect(getCompanionRegistryServer({
      name: "io.example.acme/search",
      baseUrl,
      fetchImpl: downFetch,
      cache: new CompanionRegistryCache(),
    })).rejects.toBeInstanceOf(CompanionRegistryUnavailableError);
  });
});
