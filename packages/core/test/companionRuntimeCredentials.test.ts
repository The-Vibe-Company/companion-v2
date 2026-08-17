import { describe, expect, it } from "vitest";

import {
  CompanionRuntimeCredentialError,
  decryptCompanionMcpRuntimeCredential,
  decryptCompanionProviderRuntimeCredential,
  encryptCompanionMcpRuntimeCredential,
} from "../src/companionRuntimeCredentials";
import { encryptOpaqueValue } from "../src/secretsCrypto";

const masterKey = Buffer.alloc(32, 41);
const orgId = "11111111-1111-4111-8111-111111111111";
const providerGeneration = "22222222-2222-4222-8222-222222222222";
const accountId = "33333333-3333-4333-8333-333333333333";
const mcpGeneration = "44444444-4444-4444-8444-444444444444";

describe("Runtime v2 credential material", () => {
  it("decrypts a generation-bound provider credential and never leaks failures", () => {
    const secret = "provider-secret-that-must-not-leak";
    const envelope = encryptOpaqueValue({
      orgId,
      purpose: "companion-provider-credential",
      subjectId: `anthropic:${providerGeneration}`,
      value: JSON.stringify({ type: "api_key", key: secret }),
    }, masterKey);

    expect(decryptCompanionProviderRuntimeCredential({
      orgId,
      providerId: "anthropic",
      credentialGeneration: providerGeneration,
      envelope,
    }, masterKey)).toEqual({ type: "api_key", key: secret });

    let failure: unknown;
    try {
      decryptCompanionProviderRuntimeCredential({
        orgId,
        providerId: "openai",
        credentialGeneration: providerGeneration,
        envelope,
      }, masterKey);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(CompanionRuntimeCredentialError);
    expect(String(failure)).not.toContain(secret);
    expect(failure).toMatchObject({ code: "provider_auth_invalid" });
  });

  it("validates environment MCP credentials after authenticated decryption", () => {
    const envelope = encryptOpaqueValue({
      orgId,
      purpose: "companion-mcp-credential",
      subjectId: `${accountId}:${mcpGeneration}`,
      value: JSON.stringify([{ env_key: "LINEAR_TOKEN", value: "mcp-secret" }]),
    }, masterKey);

    expect(decryptCompanionMcpRuntimeCredential({
      orgId,
      accountId,
      credentialGeneration: mcpGeneration,
      envelope,
    }, masterKey)).toEqual({
      kind: "environment",
      credentials: [{ env_key: "LINEAR_TOKEN", value: "mcp-secret" }],
    });
  });

  it("round-trips refreshed OAuth material under only the next CAS generation", () => {
    const nextGeneration = "55555555-5555-4555-8555-555555555555";
    const credential = {
      kind: "oauth" as const,
      version: 1 as const,
      serverName: "app.linear/linear" as const,
      accessToken: "access-secret",
      refreshToken: "refresh-secret",
      accessExpiresAt: "2030-01-01T00:00:00.000Z",
      scope: "read write",
      tokenType: "Bearer" as const,
      tokenEndpoint: "https://mcp.linear.app/oauth/token",
      resource: "https://mcp.linear.app/mcp",
      client: {
        clientId: "client-id",
        clientSecret: null,
        tokenEndpointAuthMethod: "none" as const,
      },
    };
    const envelope = encryptCompanionMcpRuntimeCredential({
      orgId,
      accountId,
      credentialGeneration: nextGeneration,
      credential,
    }, masterKey);

    expect(decryptCompanionMcpRuntimeCredential({
      orgId,
      accountId,
      credentialGeneration: nextGeneration,
      envelope,
    }, masterKey)).toEqual({ kind: "oauth", credential });
    expect(() => decryptCompanionMcpRuntimeCredential({
      orgId,
      accountId,
      credentialGeneration: mcpGeneration,
      envelope,
    }, masterKey)).toThrow(CompanionRuntimeCredentialError);
  });

  it.each([
    {
      label: "an untrusted token endpoint",
      tokenEndpoint: "https://attacker.invalid/oauth/token",
      resource: "https://mcp.linear.app/mcp",
    },
    {
      label: "a mismatched resource",
      tokenEndpoint: "https://mcp.linear.app/oauth/token",
      resource: "https://mcp.linear.app/other",
    },
    {
      label: "credentials embedded in the endpoint",
      tokenEndpoint: "https://user:password@mcp.linear.app/oauth/token",
      resource: "https://mcp.linear.app/mcp",
    },
  ])("rejects OAuth material with $label", ({ tokenEndpoint, resource }) => {
    const envelope = encryptOpaqueValue({
      orgId,
      purpose: "companion-mcp-credential",
      subjectId: `${accountId}:${mcpGeneration}`,
      value: JSON.stringify({
        kind: "oauth",
        version: 1,
        serverName: "app.linear/linear",
        accessToken: "opaque-access",
        refreshToken: "opaque-refresh",
        accessExpiresAt: "2030-01-01T00:00:00.000Z",
        scope: "read write",
        tokenType: "Bearer",
        tokenEndpoint,
        resource,
        client: {
          clientId: "client-id",
          clientSecret: null,
          tokenEndpointAuthMethod: "none",
        },
      }),
    }, masterKey);

    expect(() => decryptCompanionMcpRuntimeCredential({
      orgId,
      accountId,
      credentialGeneration: mcpGeneration,
      envelope,
    }, masterKey)).toThrow(expect.objectContaining({ code: "mcp_auth_invalid" }));
  });

  it("rejects malformed plaintext behind a valid envelope with a stable error", () => {
    const envelope = encryptOpaqueValue({
      orgId,
      purpose: "companion-mcp-credential",
      subjectId: `${accountId}:${mcpGeneration}`,
      value: JSON.stringify([{ env_key: "bad-key", value: "hidden" }]),
    }, masterKey);

    expect(() => decryptCompanionMcpRuntimeCredential({
      orgId,
      accountId,
      credentialGeneration: mcpGeneration,
      envelope,
    }, masterKey)).toThrow(expect.objectContaining({ code: "mcp_auth_invalid" }));
  });
});
