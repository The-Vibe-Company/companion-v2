import { gzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import {
  encryptCompanionMcpRuntimeCredential,
  encryptOpaqueValue,
} from "@companion/core";
import { skillChecksum } from "@companion/skills";

import {
  collectRuntimeCredentialSensitiveValues,
  resolveRuntimeResources,
  RuntimeMaterialError,
} from "./resourceMaterial";

const orgId = "11111111-1111-4111-8111-111111111111";
const accountId = "22222222-2222-4222-8222-222222222222";
const generation = "33333333-3333-4333-8333-333333333333";
const masterKey = Buffer.alloc(32, 41);

describe("runtime material resolution", () => {
  it("collects exact provider and MCP plaintext only for the in-memory projection redactor", () => {
    const providerGeneration = "66666666-6666-4666-8666-666666666666";
    const providerSecret = "opaque-provider-value";
    const nestedProviderSecret = "opaque-nested-provider-value";
    const mcpSecret = "opaque-mcp-value";
    const providerEnvelope = encryptOpaqueValue({
      orgId,
      purpose: "companion-provider-credential",
      subjectId: `anthropic:${providerGeneration}`,
      value: JSON.stringify({
        type: "api_key",
        key: providerSecret,
        future_auth: { opaque: nestedProviderSecret },
      }),
    }, masterKey);
    const mcpEnvelope = encryptCompanionMcpRuntimeCredential({
      orgId,
      accountId,
      credentialGeneration: generation,
      credential: [{ env_key: "MCP_TOKEN", value: mcpSecret }],
    }, masterKey);

    const values = collectRuntimeCredentialSensitiveValues({
      orgId,
      masterKey,
      material: {
        providerMaterial: [{
          provider_id: "anthropic",
          auth_method: "api_key",
          credential_generation: providerGeneration,
          credential_version: 1,
          ...snakeEnvelope(providerEnvelope),
        }],
        skillMaterial: [],
        mcpMaterial: [{
          account_id: accountId,
          credential_generation: generation,
          account_config: {
            id: accountId,
            label: "Example",
            lifecycle: "lazy",
            direct_tools: false,
            transport: "stdio",
            command: "example-mcp",
            args: [],
            env: { TOKEN: "MCP_TOKEN" },
          },
          ...snakeEnvelope(mcpEnvelope),
        }],
      },
    });

    expect(values).toEqual(expect.arrayContaining([
      providerSecret,
      nestedProviderSecret,
      mcpSecret,
    ]));
    expect(values).not.toContain(providerEnvelope.ciphertext);
    expect(values).not.toContain(mcpEnvelope.ciphertext);
  });

  it("verifies Skill bytes and decrypts generation-pinned MCP environment credentials", async () => {
    const canonicalTar = Buffer.from("canonical tar bytes");
    const archive = gzipSync(canonicalTar);
    const envelope = encryptCompanionMcpRuntimeCredential({
      orgId,
      accountId,
      credentialGeneration: generation,
      credential: [{ env_key: "MCP_TOKEN", value: "sensitive-value" }],
    }, masterKey);
    const loadSkillArchive = vi.fn(async () => archive);

    const resources = await resolveRuntimeResources({
      orgId,
      masterKey,
      material: {
        providerMaterial: [],
        skillMaterial: [{
          skill_id: "44444444-4444-4444-8444-444444444444",
          version_id: "55555555-5555-4555-8555-555555555555",
          slug: "example-skill",
          version: "1.2.3",
          // Skill identity hashes the canonical tar, while size_bytes describes stored gzip bytes.
          checksum: skillChecksum(canonicalTar),
          size_bytes: archive.byteLength,
          storage_path: "org/skills/example.tar.gz",
        }],
        mcpMaterial: [{
          account_id: accountId,
          credential_generation: generation,
          account_config: {
            id: accountId,
            label: "Example",
            lifecycle: "lazy",
            direct_tools: false,
            transport: "stdio",
            command: "example-mcp",
            args: [],
            env: { TOKEN: "MCP_TOKEN" },
          },
          ...snakeEnvelope(envelope),
        }],
      },
      loadSkillArchive,
      signal: new AbortController().signal,
    });

    expect(loadSkillArchive).toHaveBeenCalledWith(
      "org/skills/example.tar.gz",
      expect.any(AbortSignal),
    );
    expect(resources.skills).toEqual([{
      slug: "example-skill",
      version: "1.2.3",
      checksum: expect.stringMatching(/^sha256:/),
      archive,
    }]);
    expect(resources.mcpCredentials).toEqual([{ env_key: "MCP_TOKEN", value: "sensitive-value" }]);
  });

  it("delegates expiring OAuth refresh while retaining the account's authorized env binding", async () => {
    const stored = {
      kind: "oauth" as const,
      version: 1 as const,
      serverName: "app.linear/linear" as const,
      accessToken: "old-token",
      refreshToken: "refresh-token",
      accessExpiresAt: "2027-01-01T00:00:00.000Z",
      scope: "read write",
      tokenType: "Bearer" as const,
      tokenEndpoint: "https://mcp.linear.app/token",
      resource: "https://mcp.linear.app/mcp",
      client: { clientId: "client", clientSecret: null, tokenEndpointAuthMethod: "none" as const },
    };
    const envelope = encryptCompanionMcpRuntimeCredential({
      orgId,
      accountId,
      credentialGeneration: generation,
      credential: stored,
    }, masterKey);
    const resolveOauth = vi.fn(async () => ({ ...stored, accessToken: "new-token" }));

    const resources = await resolveRuntimeResources({
      orgId,
      masterKey,
      material: {
        providerMaterial: [],
        skillMaterial: [],
        mcpMaterial: [{
          account_id: accountId,
          credential_generation: generation,
          account_config: {
            id: accountId,
            label: "Linear",
            lifecycle: "lazy",
            direct_tools: false,
            transport: "http",
            url: "https://mcp.linear.app/mcp",
            headers: { Authorization: "LINEAR_AUTH" },
          },
          ...snakeEnvelope(envelope),
        }],
      },
      loadSkillArchive: vi.fn(),
      resolveOauth,
      now: () => Date.parse("2027-01-01T00:00:00.000Z"),
      signal: new AbortController().signal,
    });

    expect(resolveOauth).toHaveBeenCalledWith({
      accountId,
      credentialGeneration: generation,
      credential: stored,
    });
    expect(resources.mcpCredentials).toEqual([{
      env_key: "LINEAR_AUTH",
      value: "Bearer new-token",
    }]);
  });

  it("collapses storage and malformed-row details to fixed safe errors", async () => {
    const secretPath = "signed://secret-storage-path?token=never-return";
    const loadSkillArchive = vi.fn(async () => { throw new Error(secretPath); });
    let error: unknown;
    try {
      await resolveRuntimeResources({
        orgId,
        masterKey,
        material: {
          providerMaterial: [],
          mcpMaterial: [],
          skillMaterial: [{
            skill_id: "44444444-4444-4444-8444-444444444444",
            version_id: "55555555-5555-4555-8555-555555555555",
            slug: "example",
            version: "1.0.0",
            checksum: `sha256:${"0".repeat(64)}`,
            size_bytes: 10,
            storage_path: secretPath,
          }],
        },
        loadSkillArchive,
        signal: new AbortController().signal,
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(RuntimeMaterialError);
    expect(String(error)).not.toContain(secretPath);
    expect(loadSkillArchive).toHaveBeenCalledWith(secretPath, expect.any(AbortSignal));
  });
});

function snakeEnvelope(envelope: {
  ciphertext: string;
  iv: string;
  authTag: string;
  wrappedDek: string;
  wrapIv: string;
  wrapAuthTag: string;
  keyId: string;
}): Record<string, string> {
  return {
    ciphertext: envelope.ciphertext,
    iv: envelope.iv,
    auth_tag: envelope.authTag,
    wrapped_dek: envelope.wrappedDek,
    wrap_iv: envelope.wrapIv,
    wrap_auth_tag: envelope.wrapAuthTag,
    key_id: envelope.keyId,
  };
}
