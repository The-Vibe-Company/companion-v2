import { describe, expect, it, vi } from "vitest";
import {
  CompanionPluginOAuthError,
  beginCompanionPluginOAuth,
  completeCompanionPluginOAuth,
  refreshCompanionPluginOAuth,
} from "../src/companionPluginOAuth";

function jsonResponse(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

describe("Companion plugin OAuth broker", () => {
  it("discovers Linear, dynamically registers the callback, and builds a PKCE authorization URL", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        resource: "https://mcp.linear.app/mcp",
        authorization_servers: ["https://mcp.linear.app"],
      }))
      .mockResolvedValueOnce(jsonResponse({
        authorization_endpoint: "https://mcp.linear.app/authorize",
        token_endpoint: "https://mcp.linear.app/token",
        registration_endpoint: "https://mcp.linear.app/register",
      }))
      .mockResolvedValueOnce(jsonResponse({
        client_id: "linear-client",
        token_endpoint_auth_method: "none",
      }));

    const started = await beginCompanionPluginOAuth({
      serverName: "app.linear/linear",
      redirectUri: "https://companion.example/v1/companion-plugins/oauth/callback",
      state: "signed-state",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const authorization = new URL(started.authorizationUrl);
    expect(authorization.origin + authorization.pathname).toBe("https://mcp.linear.app/authorize");
    expect(authorization.searchParams.get("client_id")).toBe("linear-client");
    expect(authorization.searchParams.get("state")).toBe("signed-state");
    expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorization.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(authorization.searchParams.get("resource")).toBe("https://mcp.linear.app/mcp");
    expect(started.flow.codeVerifier).not.toBe(authorization.searchParams.get("code_challenge"));

    const registration = fetchImpl.mock.calls[2];
    expect(registration?.[0]).toBe("https://mcp.linear.app/register");
    expect(JSON.parse(String(registration?.[1]?.body))).toMatchObject({
      redirect_uris: ["https://companion.example/v1/companion-plugins/oauth/callback"],
      token_endpoint_auth_method: "none",
    });
  });

  it("exchanges and refreshes tokens without exposing provider response bodies", async () => {
    const exchangeFetch = vi.fn(async (_url, init) => {
      const body = init?.body as URLSearchParams;
      expect(body.get("code")).toBe("authorization-code");
      expect(body.get("code_verifier")).toBe("pkce-verifier");
      expect(body.get("resource")).toBe("https://mcp.linear.app/mcp");
      return jsonResponse({
        access_token: "access-one",
        refresh_token: "refresh-one",
        expires_in: 60,
        token_type: "bearer",
      });
    }) as unknown as typeof fetch;
    const credential = await completeCompanionPluginOAuth({
      flow: {
        serverName: "app.linear/linear",
        provider: "linear",
        remoteUrl: "https://mcp.linear.app/mcp",
        authorizationEndpoint: "https://mcp.linear.app/authorize",
        tokenEndpoint: "https://mcp.linear.app/token",
        resource: "https://mcp.linear.app/mcp",
        scope: "read write",
        codeVerifier: "pkce-verifier",
        client: { clientId: "client-one", clientSecret: null, tokenEndpointAuthMethod: "none" },
      },
      code: "authorization-code",
      redirectUri: "https://companion.example/v1/companion-plugins/oauth/callback",
      fetchImpl: exchangeFetch,
    });
    expect(credential).toMatchObject({
      kind: "oauth",
      accessToken: "access-one",
      refreshToken: "refresh-one",
    });

    const refreshFetch = vi.fn(async (_url, init) => {
      const body = init?.body as URLSearchParams;
      expect(body.get("refresh_token")).toBe("refresh-one");
      return jsonResponse({ access_token: "access-two", expires_in: 3600 });
    }) as unknown as typeof fetch;
    await expect(refreshCompanionPluginOAuth({
      credential,
      fetchImpl: refreshFetch,
    })).resolves.toMatchObject({
      accessToken: "access-two",
      refreshToken: "refresh-one",
    });

    const failedFetch = vi.fn(async () =>
      jsonResponse({ error: "invalid_grant", error_description: "secret provider detail" }, 400)
    ) as unknown as typeof fetch;
    await expect(refreshCompanionPluginOAuth({
      credential,
      fetchImpl: failedFetch,
    })).rejects.toEqual(expect.objectContaining({
      code: "oauth_refresh_failed",
      message: expect.not.stringContaining("secret provider detail"),
    }));
  });

  it("rejects discovery metadata that moves the resource off the curated remote", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      resource: "https://mcp.linear.app/other-resource",
      authorization_servers: ["https://mcp.linear.app"],
    })) as unknown as typeof fetch;

    await expect(beginCompanionPluginOAuth({
      serverName: "app.linear/linear",
      redirectUri: "https://companion.example/callback",
      state: "state",
      fetchImpl,
    })).rejects.toEqual(expect.objectContaining({ code: "oauth_discovery_failed" }));
  });

  it("requires deployment-owned GitHub OAuth App credentials", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      resource: "https://api.githubcopilot.com/mcp/",
      authorization_servers: ["https://github.com/login/oauth"],
    })) as unknown as typeof fetch;

    await expect(beginCompanionPluginOAuth({
      serverName: "io.github.github/github-mcp-server",
      redirectUri: "https://companion.example/callback",
      state: "state",
      env: {},
      fetchImpl,
    })).rejects.toBeInstanceOf(CompanionPluginOAuthError);
    await expect(beginCompanionPluginOAuth({
      serverName: "io.github.github/github-mcp-server",
      redirectUri: "https://companion.example/callback",
      state: "state",
      env: {},
      fetchImpl,
    })).rejects.toEqual(expect.objectContaining({ code: "oauth_not_configured" }));
  });

  it("uses GitHub's configured OAuth App without persisting its shared secret or sending resource", async () => {
    const discoveryFetch = vi.fn(async () => jsonResponse({
      resource: "https://api.githubcopilot.com/mcp/",
      authorization_servers: ["https://github.com/login/oauth"],
    })) as unknown as typeof fetch;
    const started = await beginCompanionPluginOAuth({
      serverName: "io.github.github/github-mcp-server",
      redirectUri: "https://companion.example/callback",
      state: "state",
      env: {
        COMPANION_MCP_GITHUB_CLIENT_ID: "github-client",
        COMPANION_MCP_GITHUB_CLIENT_SECRET: "github-client-secret",
      },
      fetchImpl: discoveryFetch,
    });
    expect(new URL(started.authorizationUrl).searchParams.has("resource")).toBe(false);

    const exchangeFetch = vi.fn(async (_url, init) => {
      const body = init?.body as URLSearchParams;
      expect(body.has("resource")).toBe(false);
      expect(body.get("client_secret")).toBe("github-client-secret");
      return jsonResponse({
        access_token: "github-access",
        refresh_token: "github-refresh",
        expires_in: 60,
      });
    }) as unknown as typeof fetch;
    const credential = await completeCompanionPluginOAuth({
      flow: started.flow,
      code: "github-code",
      redirectUri: "https://companion.example/callback",
      fetchImpl: exchangeFetch,
    });
    expect(credential.client).toEqual({
      clientId: "github-client",
      clientSecret: null,
      tokenEndpointAuthMethod: "client_secret_post",
    });
    expect(JSON.stringify(credential)).not.toContain("github-client-secret");

    const refreshFetch = vi.fn(async (_url, init) => {
      const body = init?.body as URLSearchParams;
      expect(body.has("resource")).toBe(false);
      expect(body.get("client_secret")).toBe("github-client-secret");
      return jsonResponse({ access_token: "github-access-two" });
    }) as unknown as typeof fetch;
    await expect(refreshCompanionPluginOAuth({
      credential,
      env: {
        COMPANION_MCP_GITHUB_CLIENT_ID: "github-client",
        COMPANION_MCP_GITHUB_CLIENT_SECRET: "github-client-secret",
      },
      fetchImpl: refreshFetch,
    })).resolves.toMatchObject({ accessToken: "github-access-two" });
  });
});
