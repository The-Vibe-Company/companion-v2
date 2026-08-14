import { describe, expect, it, vi } from "vitest";
import {
  beginAnthropicProviderOAuth,
  beginOpenAICodexProviderOAuth,
  completeAnthropicProviderOAuth,
  pollOpenAICodexProviderOAuth,
} from "../src/companionProviderOAuth";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function accessToken(accountId: string): string {
  const payload = Buffer.from(JSON.stringify({
    "https://api.openai.com/auth": { chatgpt_account_id: accountId },
  })).toString("base64url");
  return `header.${payload}.signature`;
}

describe("Companion provider OAuth", () => {
  it("builds Claude PKCE login and converts its one-time code into a Pi OAuth entry", async () => {
    const started = beginAnthropicProviderOAuth();
    const authorization = new URL(started.authorizationUrl);

    expect(authorization.origin).toBe("https://claude.ai");
    expect(authorization.searchParams.get("code_challenge")).toBeTruthy();
    expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorization.searchParams.get("state")).toBe(started.flow.state);
    expect(started.flow.state).not.toBe(started.flow.verifier);

    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, string>;
      expect(body.code).toBe("one-time-code");
      expect(body.code_verifier).toBe(started.flow.verifier);
      expect(body.state).toBe(started.flow.state);
      return jsonResponse({
        access_token: "claude-access",
        refresh_token: "claude-refresh",
        expires_in: 3600,
      });
    }) as unknown as typeof fetch;
    const credential = await completeAnthropicProviderOAuth({
      flow: started.flow,
      authorizationInput: `one-time-code#${started.flow.state}`,
      fetchImpl,
    });

    expect(credential).toMatchObject({
      type: "oauth",
      access: "claude-access",
      refresh: "claude-refresh",
    });
  });

  it("requires Claude's returned state before exchanging the authorization code", async () => {
    const started = beginAnthropicProviderOAuth();
    const fetchImpl = vi.fn() as unknown as typeof fetch;

    await expect(completeAnthropicProviderOAuth({
      flow: started.flow,
      authorizationInput: "one-time-code",
      fetchImpl,
    })).rejects.toMatchObject({ code: "oauth_invalid" });
    await expect(completeAnthropicProviderOAuth({
      flow: started.flow,
      authorizationInput: "one-time-code#wrong-state",
      fetchImpl,
    })).rejects.toMatchObject({ code: "oauth_invalid" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("uses Codex device login and returns the Pi account-bound OAuth entry only after approval", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        device_auth_id: "device-secret",
        user_code: "ABCD-EFGH",
        interval: 2,
      }))
      .mockResolvedValueOnce(jsonResponse({}, 403))
      .mockResolvedValueOnce(jsonResponse({
        authorization_code: "authorization-secret",
        code_verifier: "verifier-secret",
      }))
      .mockResolvedValueOnce(jsonResponse({
        access_token: accessToken("acct-123"),
        refresh_token: "codex-refresh",
        expires_in: 3600,
      })) as unknown as typeof fetch;

    const started = await beginOpenAICodexProviderOAuth({ fetchImpl });
    expect(started).toMatchObject({
      verificationUrl: "https://auth.openai.com/codex/device",
      userCode: "ABCD-EFGH",
      pollIntervalSeconds: 2,
    });
    await expect(pollOpenAICodexProviderOAuth({
      flow: started.flow,
      fetchImpl,
    })).resolves.toEqual({ status: "pending" });
    await expect(pollOpenAICodexProviderOAuth({
      flow: started.flow,
      fetchImpl,
    })).resolves.toMatchObject({
      status: "complete",
      credential: {
        type: "oauth",
        refresh: "codex-refresh",
        accountId: "acct-123",
      },
    });
  });
});
