import { describe, expect, it, vi } from "vitest";
import {
  encryptCompanionMcpRuntimeCredential,
  type CompanionPluginStoredOAuthCredential,
} from "@companion/core";
import {
  RuntimeStoreSerializationError,
  type LeaseFence,
  type RuntimeAuthorization,
  type RuntimeStore,
  type RuntimeWorkMaterial,
} from "@companion/companion-runtime";
import type { CompanionBoxRuntimeV2 } from "@companion/box-runtime";

import { createRuntimeMaterialPipeline } from "./materialPipeline";
import { RuntimeMaterialError } from "./resourceMaterial";

const orgId = "11111111-1111-4111-8111-111111111111";
const companionId = "22222222-2222-4222-8222-222222222222";
const accountId = "33333333-3333-4333-8333-333333333333";
const generation = "44444444-4444-4444-8444-444444444444";
const nextGeneration = "55555555-5555-4555-8555-555555555555";
const skillId = "88888888-8888-4888-8888-888888888888";
const skillVersionId = "99999999-9999-4999-8999-999999999999";
const nextSkillVersionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const masterKey = Buffer.alloc(32, 71);

function oauth(accessToken: string) {
  return {
    kind: "oauth" as const,
    version: 1 as const,
    serverName: "app.linear/linear" as const,
    accessToken,
    refreshToken: "refresh-token",
    accessExpiresAt: "2027-01-01T00:00:00.000Z",
    scope: "read write",
    tokenType: "Bearer" as const,
    tokenEndpoint: "https://mcp.linear.app/token",
    resource: "https://mcp.linear.app/mcp",
    client: { clientId: "client", clientSecret: null, tokenEndpointAuthMethod: "none" as const },
  };
}

function workMaterial(): RuntimeWorkMaterial {
  const envelope = encryptCompanionMcpRuntimeCredential({
    orgId,
    accountId,
    credentialGeneration: generation,
    credential: oauth("old-token"),
  }, masterKey);
  return {
    turnId: null,
    attemptId: null,
    messageEventId: null,
    promptText: null,
    decisionRequestKind: null,
    decisionResponsePayload: null,
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
    modelInput: null,
    hasVisibleOutput: false,
  };
}

const fence = {
  orgId,
  companionId,
  claimToken: "66666666-6666-4666-8666-666666666666",
  claimEpoch: 1n,
  gateEpoch: 1n,
  executorId: "executor",
  workKind: "settings",
  workId: "77777777-7777-4777-8777-777777777777",
} satisfies LeaseFence;

const authorization = {
  runtimeGeneration: 1n,
  modelId: "provider/model",
  persona: "Be useful",
  providerRefs: [],
  skillRefs: [],
  mcpRefs: [],
} as unknown as RuntimeAuthorization;

describe("runtime material provider and Box stager", () => {
  it("persists an OAuth refresh through fenced CAS before staging its plaintext", async () => {
    const material = workMaterial();
    const casMcpOauth = vi.fn(async (_fence: LeaseFence, _input: unknown) => ({
      updated: true,
      credentialGeneration: nextGeneration,
    }));
    const store = {
      getMaterial: vi.fn(async () => material),
      casMcpOauth,
    } as unknown as RuntimeStore;
    const stageExistingBox = vi.fn(async () => ({
      boxId: "bx_23456789",
      diskLayoutVersion: 14 as const,
    }));
    const pipeline = createRuntimeMaterialPipeline({
      masterKey,
      apiUrl: "https://api.example.test",
      bundledSkill: {
        slug: "companion",
        version: "1.0.0",
        checksum: `sha256:${"1".repeat(64)}`,
        archive: Buffer.from("bundled"),
      },
      runtime: () => ({ stageExistingBox }) as unknown as CompanionBoxRuntimeV2,
      loadSkillArchive: vi.fn(),
      refreshOauth: async () => oauth("new-token"),
      uuid: () => nextGeneration,
      now: () => Date.parse("2027-01-01T00:00:00.000Z"),
    });

    const frozen = await pipeline.materialProvider.getMaterial({ store, fence });
    expect(frozen).toBe(material);
    expect(casMcpOauth).toHaveBeenCalledWith(fence, expect.objectContaining({
      accountId,
      expectedGeneration: generation,
      nextGeneration,
      envelope: expect.objectContaining({ ciphertext: expect.any(String) }),
    }));
    expect(JSON.stringify(casMcpOauth.mock.calls[0]?.[1])).not.toContain("new-token");

    await expect(pipeline.resourceStager.stageExistingBox({
      orgId,
      companionId,
      boxId: "bx_23456789",
      allowBoxCreate: false,
      authorization: {
        ...authorization,
        mcpRefs: [{ account_id: accountId, credential_generation: nextGeneration }],
      },
      material,
      clientSurface: "web",
      targetSettingsRevision: 3n,
      targetSkillsRevision: 4,
      signal: new AbortController().signal,
    })).resolves.toEqual({
      diskLayoutVersion: 14,
      appliedSettingsRevision: 3n,
      appliedSkillsRevision: 4,
    });
    expect(stageExistingBox).toHaveBeenCalledWith(expect.objectContaining({
      boxId: "bx_23456789",
      runtimeGeneration: 1,
      mcpCredentials: [{ env_key: "LINEAR_AUTH", value: "Bearer new-token" }],
      skills: [expect.objectContaining({ slug: "companion" })],
      hubEnv: {
        COMPANION_API_URL: "https://api.example.test",
        COMPANION_WORKSPACE_ID: orgId,
      },
      signal: expect.any(AbortSignal),
    }));
  });

  it("treats a lost OAuth CAS as fence loss and never stages the token", async () => {
    const material = workMaterial();
    const store = {
      getMaterial: vi.fn(async () => material),
      casMcpOauth: vi.fn(async () => ({
        updated: false,
        credentialGeneration: "88888888-8888-4888-8888-888888888888",
      })),
    } as unknown as RuntimeStore;
    const stageExistingBox = vi.fn();
    const pipeline = createRuntimeMaterialPipeline({
      masterKey,
      apiUrl: "https://api.example.test",
      bundledSkill: {
        slug: "companion",
        version: "1.0.0",
        checksum: `sha256:${"1".repeat(64)}`,
        archive: Buffer.from("bundled"),
      },
      runtime: () => ({ stageExistingBox }) as unknown as CompanionBoxRuntimeV2,
      loadSkillArchive: vi.fn(),
      refreshOauth: async () => oauth("new-token"),
      uuid: () => nextGeneration,
      now: () => Date.parse("2027-01-01T00:00:00.000Z"),
    });

    await expect(pipeline.materialProvider.getMaterial({ store, fence }))
      .rejects.toBeInstanceOf(RuntimeStoreSerializationError);
    expect(stageExistingBox).not.toHaveBeenCalled();
  });

  it("does not enter the OAuth CAS after runtime shutdown aborts a refresh", async () => {
    const material = workMaterial();
    const casMcpOauth = vi.fn();
    const store = {
      getMaterial: vi.fn(async () => material),
      casMcpOauth,
    } as unknown as RuntimeStore;
    const controller = new AbortController();
    let finishRefresh!: (credential: ReturnType<typeof oauth>) => void;
    const refreshOauth = vi.fn(async (
      _credential: CompanionPluginStoredOAuthCredential,
      _signal?: AbortSignal,
    ) =>
      await new Promise<ReturnType<typeof oauth>>((resolve) => { finishRefresh = resolve; }));
    const pipeline = createRuntimeMaterialPipeline({
      masterKey,
      apiUrl: "https://api.example.test",
      bundledSkill: {
        slug: "companion",
        version: "1.0.0",
        checksum: `sha256:${"1".repeat(64)}`,
        archive: Buffer.from("bundled"),
      },
      runtime: () => ({ stageExistingBox: vi.fn() }) as unknown as CompanionBoxRuntimeV2,
      loadSkillArchive: vi.fn(),
      refreshOauth,
      uuid: () => nextGeneration,
      now: () => Date.parse("2027-01-01T00:00:00.000Z"),
    });

    const reading = pipeline.materialProvider.getMaterial({
      store,
      fence,
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(refreshOauth).toHaveBeenCalledOnce());
    const stopped = new Error("runtime stopped");
    controller.abort(stopped);
    finishRefresh(oauth("new-token"));

    await expect(reading).rejects.toBe(stopped);
    expect(casMcpOauth).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "provider credential rotation",
      material: {
        providerMaterial: [{
          provider_id: "openai",
          auth_method: "api_key",
          credential_generation: generation,
          credential_version: 1,
          ...fakeEncryptedEnvelope(),
        }],
      },
      refs: {
        providerRefs: [{
          provider_id: "openai",
          credential_generation: nextGeneration,
          credential_version: 2,
        }],
      },
    },
    {
      label: "Skill version rotation",
      material: {
        skillMaterial: [{
          skill_id: skillId,
          version_id: skillVersionId,
          slug: "example",
          version: "1.0.0",
          checksum: `sha256:${"1".repeat(64)}`,
          size_bytes: 1,
          storage_path: "org/example.tar.gz",
        }],
      },
      refs: {
        skillRefs: [{ skill_id: skillId, current_version_id: nextSkillVersionId }],
      },
    },
    {
      label: "MCP credential rotation",
      material: {
        mcpMaterial: [{
          account_id: accountId,
          credential_generation: generation,
          account_config: {},
          ...fakeEncryptedEnvelope(),
        }],
      },
      refs: {
        mcpRefs: [{ account_id: accountId, credential_generation: nextGeneration }],
      },
    },
  ])("rejects a stale $label before reading storage or contacting Box", async ({
    material: staleMaterial,
    refs,
  }) => {
    const material = {
      ...workMaterial(),
      providerMaterial: [],
      skillMaterial: [],
      mcpMaterial: [],
      ...staleMaterial,
    };
    const stageExistingBox = vi.fn();
    const loadSkillArchive = vi.fn();
    const pipeline = createRuntimeMaterialPipeline({
      masterKey,
      apiUrl: "https://api.example.test",
      bundledSkill: {
        slug: "companion",
        version: "1.0.0",
        checksum: `sha256:${"1".repeat(64)}`,
        archive: Buffer.from("bundled"),
      },
      runtime: () => ({ stageExistingBox }) as unknown as CompanionBoxRuntimeV2,
      loadSkillArchive,
    });

    await expect(pipeline.resourceStager.stageExistingBox({
      orgId,
      companionId,
      boxId: "bx_23456789",
      allowBoxCreate: false,
      authorization: { ...authorization, ...refs } as RuntimeAuthorization,
      material,
      clientSurface: "web",
      targetSettingsRevision: 3n,
      targetSkillsRevision: 4,
      signal: new AbortController().signal,
    })).rejects.toBeInstanceOf(RuntimeMaterialError);
    expect(loadSkillArchive).not.toHaveBeenCalled();
    expect(stageExistingBox).not.toHaveBeenCalled();
  });
});

function fakeEncryptedEnvelope(): Record<string, string> {
  return {
    ciphertext: "ciphertext",
    iv: "iv",
    auth_tag: "auth-tag",
    wrapped_dek: "wrapped-dek",
    wrap_iv: "wrap-iv",
    wrap_auth_tag: "wrap-auth-tag",
    key_id: "key-id",
  };
}

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
