import { describe, expect, it, vi } from "vitest";
import {
  CompanionPluginOAuthError,
  beginCompanionPluginOAuth,
  completeCompanionPluginOAuth,
  refreshCompanionPluginOAuth,
} from "../src/companionPluginOAuth";

function jsonResponse<T>(value: T, status = 200): Response {
  return Response.json(value, { status });
}

function formBody(init: RequestInit | undefined): URLSearchParams {
  if (!(init?.body instanceof URLSearchParams)) {
    throw new Error("expected a URL-encoded OAuth request body");
  }
  return init.body;
}

describe("Companion plugin OAuth broker", () => {
  it("discovers Linear, dynamically registers the callback, and builds a PKCE authorization URL", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
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
      fetchImpl,
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

  it("discovers Conductor from its path-qualified issuer metadata", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({
        resource: "https://api.conductor.build/mcp",
        authorization_servers: ["https://api.conductor.build/mcp"],
      }))
      .mockResolvedValueOnce(jsonResponse({
        authorization_endpoint: "https://api.conductor.build/mcp/oauth/authorize",
        token_endpoint: "https://api.conductor.build/mcp/oauth/token",
        registration_endpoint: "https://api.conductor.build/mcp/oauth/register",
      }))
      .mockResolvedValueOnce(jsonResponse({
        client_id: "conductor-client",
        token_endpoint_auth_method: "none",
      }));

    const started = await beginCompanionPluginOAuth({
      serverName: "build.conductor/mcp",
      redirectUri: "https://companion.example/v1/companion-plugins/oauth/callback",
      state: "signed-state",
      fetchImpl,
    });

    expect(fetchImpl.mock.calls.map((call) => call[0])).toEqual([
      "https://api.conductor.build/.well-known/oauth-protected-resource/mcp",
      "https://api.conductor.build/.well-known/oauth-authorization-server/mcp",
      "https://api.conductor.build/mcp/oauth/register",
    ]);
    const authorization = new URL(started.authorizationUrl);
    expect(authorization.origin + authorization.pathname).toBe(
      "https://api.conductor.build/mcp/oauth/authorize",
    );
    expect(authorization.searchParams.get("scope")).toBe("mcp:tools offline_access");
    expect(authorization.searchParams.get("resource")).toBe("https://api.conductor.build/mcp");
  });

  it("exchanges and refreshes tokens without exposing provider response bodies", async () => {
    const exchangeFetch = vi.fn<typeof fetch>(async (_url, init) => {
      const body = formBody(init);
      expect(body.get("code")).toBe("authorization-code");
      expect(body.get("code_verifier")).toBe("pkce-verifier");
      expect(body.get("resource")).toBe("https://mcp.linear.app/mcp");
      return jsonResponse({
        access_token: "access-one",
        refresh_token: "refresh-one",
        expires_in: 60,
        token_type: "bearer",
      });
    });
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

    const refreshFetch = vi.fn<typeof fetch>(async (_url, init) => {
      const body = formBody(init);
      expect(body.get("refresh_token")).toBe("refresh-one");
      return jsonResponse({ access_token: "access-two", expires_in: 3600 });
    });
    await expect(refreshCompanionPluginOAuth({
      credential,
      fetchImpl: refreshFetch,
    })).resolves.toMatchObject({
      accessToken: "access-two",
      refreshToken: "refresh-one",
    });

    const rotatingFetch = vi.fn<typeof fetch>(async () => jsonResponse({
      access_token: "access-three",
      refresh_token: "refresh-two",
      expires_in: 3600,
    }));
    await expect(refreshCompanionPluginOAuth({
      credential,
      fetchImpl: rotatingFetch,
    })).resolves.toMatchObject({
      accessToken: "access-three",
      refreshToken: "refresh-two",
    });

    const failedFetch = vi.fn<typeof fetch>(async () =>
      jsonResponse({ error: "invalid_grant", error_description: "secret provider detail" }, 400)
    );
    await expect(refreshCompanionPluginOAuth({
      credential,
      fetchImpl: failedFetch,
    })).rejects.toEqual(expect.objectContaining({
      code: "oauth_refresh_failed",
      message: expect.not.stringContaining("secret provider detail"),
    }));

    const malformedSuccess = vi.fn<typeof fetch>(async () => jsonResponse({
      refresh_token: "provider-secret-that-must-not-leak",
      expires_in: 3600,
    }));
    await expect(refreshCompanionPluginOAuth({
      credential,
      fetchImpl: malformedSuccess,
    })).rejects.toEqual(expect.objectContaining({
      code: "oauth_refresh_failed",
      stableCode: "mcp_oauth_refresh_failed",
      action: "retry",
      message: expect.not.stringContaining("provider-secret-that-must-not-leak"),
    }));
  });

  it("uses Google's configured Gmail client for offline read-and-draft MCP access", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({
        resource: "https://gmailmcp.googleapis.com/mcp/v1",
        authorization_servers: ["https://accounts.google.com/"],
      }))
      .mockResolvedValueOnce(jsonResponse({
        authorization_endpoint: "https://accounts.google.com/o/oauth2/v2/auth",
        token_endpoint: "https://oauth2.googleapis.com/token",
      }));
    const env = {
      COMPANION_MCP_GMAIL_CLIENT_ID: "gmail-client",
      COMPANION_MCP_GMAIL_CLIENT_SECRET: "gmail-client-secret",
    };
    const started = await beginCompanionPluginOAuth({
      serverName: "com.google.workspace/gmail",
      redirectUri: "https://companion.example/v1/companion-plugins/oauth/callback",
      state: "gmail-state",
      env,
      fetchImpl,
    });

    expect(fetchImpl.mock.calls.map((call) => call[0])).toEqual([
      "https://gmailmcp.googleapis.com/.well-known/oauth-protected-resource/mcp/v1",
      "https://accounts.google.com/.well-known/oauth-authorization-server",
    ]);
    const authorization = new URL(started.authorizationUrl);
    expect(authorization.origin + authorization.pathname).toBe(
      "https://accounts.google.com/o/oauth2/v2/auth",
    );
    expect(authorization.searchParams.get("scope")).toBe([
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/gmail.compose",
    ].join(" "));
    expect(authorization.searchParams.get("access_type")).toBe("offline");
    expect(authorization.searchParams.get("include_granted_scopes")).toBe("true");
    expect(authorization.searchParams.get("prompt")).toBe("consent select_account");
    expect(authorization.searchParams.has("resource")).toBe(false);

    const exchangeFetch = vi.fn<typeof fetch>(async (_url, init) => {
      const body = formBody(init);
      expect(body.has("resource")).toBe(false);
      expect(body.get("client_id")).toBe("gmail-client");
      expect(body.get("client_secret")).toBe("gmail-client-secret");
      return jsonResponse({
        access_token: "gmail-access",
        refresh_token: "gmail-refresh",
        expires_in: 3600,
        scope: [
          "https://www.googleapis.com/auth/gmail.compose",
          "https://www.googleapis.com/auth/gmail.readonly",
        ].join(" "),
      });
    });
    const credential = await completeCompanionPluginOAuth({
      flow: started.flow,
      code: "gmail-code",
      redirectUri: "https://companion.example/v1/companion-plugins/oauth/callback",
      fetchImpl: exchangeFetch,
    });
    expect(credential.client).toEqual({
      clientId: "gmail-client",
      clientSecret: null,
      tokenEndpointAuthMethod: "client_secret_post",
    });
    expect(JSON.stringify(credential)).not.toContain("gmail-client-secret");

    const refreshFetch = vi.fn<typeof fetch>(async (_url, init) => {
      const body = formBody(init);
      expect(body.has("resource")).toBe(false);
      expect(body.get("client_secret")).toBe("gmail-client-secret");
      return jsonResponse({ access_token: "gmail-access-two", expires_in: 3600 });
    });
    await expect(refreshCompanionPluginOAuth({
      credential,
      env,
      fetchImpl: refreshFetch,
    })).resolves.toMatchObject({
      accessToken: "gmail-access-two",
      refreshToken: "gmail-refresh",
      scope: expect.stringContaining("gmail.readonly"),
    });
  });

  it("fails Gmail OAuth when configuration or either required scope is missing", async () => {
    const metadataFetch = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({
        resource: "https://gmailmcp.googleapis.com/mcp/v1",
        authorization_servers: ["https://accounts.google.com/"],
      }))
      .mockResolvedValueOnce(jsonResponse({
        authorization_endpoint: "https://accounts.google.com/o/oauth2/v2/auth",
        token_endpoint: "https://oauth2.googleapis.com/token",
      }));
    await expect(beginCompanionPluginOAuth({
      serverName: "com.google.workspace/gmail",
      redirectUri: "https://companion.example/callback",
      state: "state",
      env: {},
      fetchImpl: metadataFetch,
    })).rejects.toEqual(expect.objectContaining({ code: "oauth_not_configured" }));

    await expect(completeCompanionPluginOAuth({
      flow: {
        serverName: "com.google.workspace/gmail",
        provider: "gmail",
        remoteUrl: "https://gmailmcp.googleapis.com/mcp/v1",
        authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
        tokenEndpoint: "https://oauth2.googleapis.com/token",
        resource: "https://gmailmcp.googleapis.com/mcp/v1",
        scope: "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose",
        codeVerifier: "pkce-verifier",
        client: {
          clientId: "gmail-client",
          clientSecret: "gmail-client-secret",
          tokenEndpointAuthMethod: "client_secret_post",
        },
      },
      code: "gmail-code",
      redirectUri: "https://companion.example/callback",
      fetchImpl: vi.fn<typeof fetch>(async () => jsonResponse({
        access_token: "gmail-access",
        refresh_token: "gmail-refresh",
        scope: "https://www.googleapis.com/auth/gmail.readonly",
      })),
    })).rejects.toEqual(expect.objectContaining({ code: "oauth_exchange_failed" }));
  });

  it("rejects discovery metadata that moves the resource off the curated remote", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({
      resource: "https://mcp.linear.app/other-resource",
      authorization_servers: ["https://mcp.linear.app"],
    }));

    await expect(beginCompanionPluginOAuth({
      serverName: "app.linear/linear",
      redirectUri: "https://companion.example/callback",
      state: "state",
      fetchImpl,
    })).rejects.toEqual(expect.objectContaining({ code: "oauth_discovery_failed" }));
  });

  it("requires deployment-owned GitHub OAuth App credentials", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({
      resource: "https://api.githubcopilot.com/mcp/",
      authorization_servers: ["https://github.com/login/oauth"],
    }));

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

  it("uses Slack Bot User OAuth without PKCE, resource, or a persisted app secret", async () => {
    const started = await beginCompanionPluginOAuth({
      serverName: "com.slack/mcp",
      redirectUri: "https://companion.example/v1/companion-plugins/oauth/callback",
      state: "signed-state",
      env: {
        COMPANION_MCP_SLACK_CLIENT_ID: "slack-client",
        COMPANION_MCP_SLACK_CLIENT_SECRET: "slack-secret",
      },
      fetchImpl: vi.fn<typeof fetch>(),
    });
    const authorization = new URL(started.authorizationUrl);
    expect(authorization.origin + authorization.pathname).toBe("https://slack.com/oauth/v2/authorize");
    expect(authorization.searchParams.get("scope")).toBe("chat:write");
    expect(authorization.searchParams.has("code_challenge")).toBe(false);
    expect(authorization.searchParams.has("resource")).toBe(false);
    expect(started.flow.codeVerifier).toBeNull();

    const exchangeFetch = vi.fn<typeof fetch>(async (url, init) => {
      expect(String(url)).toBe("https://slack.com/api/oauth.v2.access");
      const body = formBody(init);
      expect(body.get("code")).toBe("slack-code");
      expect(body.has("code_verifier")).toBe(false);
      expect(body.has("resource")).toBe(false);
      expect(body.has("client_id")).toBe(false);
      expect(new Headers(init?.headers).get("authorization")).toBe(
        `Basic ${Buffer.from("slack-client:slack-secret").toString("base64")}`,
      );
      return jsonResponse({
        ok: true,
        access_token: "xoxb-bot-token",
        refresh_token: "xoxe-refresh-token",
        expires_in: 43_200,
        token_type: "bot",
      });
    });
    const credential = await completeCompanionPluginOAuth({
      flow: started.flow,
      code: "slack-code",
      redirectUri: "https://companion.example/v1/companion-plugins/oauth/callback",
      fetchImpl: exchangeFetch,
    });
    expect(credential).toMatchObject({
      serverName: "com.slack/mcp",
      accessToken: "xoxb-bot-token",
      refreshToken: "xoxe-refresh-token",
      client: {
        clientId: "slack-client",
        clientSecret: null,
        tokenEndpointAuthMethod: "client_secret_basic",
      },
    });
    expect(JSON.stringify(credential)).not.toContain("slack-secret");
  });

  it("uses GitHub's configured OAuth App without persisting its shared secret or sending resource", async () => {
    const discoveryFetch = vi.fn<typeof fetch>(async () => jsonResponse({
      resource: "https://api.githubcopilot.com/mcp/",
      authorization_servers: ["https://github.com/login/oauth"],
    }));
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

    const exchangeFetch = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url) === "https://api.github.com/user") {
        return jsonResponse({ login: "stan", name: "Stan Girard", email: null });
      }
      const body = formBody(init);
      expect(body.has("resource")).toBe(false);
      expect(body.get("client_id")).toBe("github-client");
      expect(body.get("client_secret")).toBe("github-client-secret");
      return jsonResponse({
        access_token: "github-access",
        refresh_token: "github-refresh",
        expires_in: 60,
      });
    });
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
    expect(credential.githubIdentity).toEqual({
      login: "stan",
      name: "Stan Girard",
      email: "stan@users.noreply.github.com",
    });
    expect(JSON.stringify(credential)).not.toContain("github-client-secret");

    const refreshFetch = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url) === "https://api.github.com/user") {
        return jsonResponse({ login: "stan", name: "Stan Girard", email: null });
      }
      const body = formBody(init);
      expect(body.has("resource")).toBe(false);
      expect(body.get("client_id")).toBe("github-client");
      expect(body.get("client_secret")).toBe("github-client-secret");
      return jsonResponse({ access_token: "github-access-two" });
    });
    await expect(refreshCompanionPluginOAuth({
      credential,
      env: {
        COMPANION_MCP_GITHUB_CLIENT_ID: "github-client",
        COMPANION_MCP_GITHUB_CLIENT_SECRET: "github-client-secret",
      },
      fetchImpl: refreshFetch,
    })).resolves.toMatchObject({
      accessToken: "github-access-two",
      githubIdentity: {
        login: "stan",
        name: "Stan Girard",
        email: "stan@users.noreply.github.com",
      },
    });

    const missingConfigFetch = vi.fn<typeof fetch>();
    await expect(refreshCompanionPluginOAuth({
      credential,
      env: {},
      fetchImpl: missingConfigFetch,
    })).rejects.toEqual(expect.objectContaining({
      code: "oauth_refresh_failed",
      stableCode: "mcp_oauth_refresh_failed",
      action: "retry",
    }));
    expect(missingConfigFetch).not.toHaveBeenCalled();
  });

  it("keeps a GitHub grant when the profile lookup fails", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (url) => {
      if (String(url).includes("oauth-protected-resource")) {
        return jsonResponse({
          resource: "https://api.githubcopilot.com/mcp/",
          authorization_servers: ["https://github.com/login/oauth"],
        });
      }
      if (String(url) === "https://api.github.com/user") return jsonResponse({ message: "nope" }, 401);
      return jsonResponse({
        access_token: "github-access",
        refresh_token: "github-refresh",
        expires_in: 60,
      });
    });
    const started = await beginCompanionPluginOAuth({
      serverName: "io.github.github/github-mcp-server",
      redirectUri: "https://companion.example/callback",
      state: "state",
      env: {
        COMPANION_MCP_GITHUB_CLIENT_ID: "github-client",
        COMPANION_MCP_GITHUB_CLIENT_SECRET: "github-client-secret",
      },
      fetchImpl,
    });
    const credential = await completeCompanionPluginOAuth({
      flow: started.flow,
      code: "github-code",
      redirectUri: "https://companion.example/callback",
      fetchImpl,
    });
    expect(credential.accessToken).toBe("github-access");
    expect(credential.githubIdentity).toBeUndefined();
  });
});
