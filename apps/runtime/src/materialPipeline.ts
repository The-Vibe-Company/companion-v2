import { randomUUID } from "node:crypto";
import { COMPANION_SKILL_KEY, companionSkillDir } from "@companion/companion-skill";
import { getCompanionSkillPackage } from "@companion/companion-skill/package";
import {
  type CompanionBoxRuntimeV2,
  type CompanionRuntimeSkill,
} from "@companion/box-runtime";
import {
  COMPANION_MCP_OAUTH_REFRESH_SKEW_MS,
  encryptCompanionMcpRuntimeCredential,
  refreshCompanionPluginOAuth,
  type CompanionPluginStoredOAuthCredential,
} from "@companion/core";
import {
  RUNTIME_LEASE_SECONDS,
  RuntimeStoreSerializationError,
  createRuntimeVisibleTextRedactor,
  type RuntimeMaterialProvider,
  type RuntimeProjectionRedactorFactory,
  type RuntimeResourceStager,
  type RuntimeStore,
  type RuntimeWorkMaterial,
} from "@companion/companion-runtime";
import { packDir } from "@companion/skills";

import {
  assertRuntimeMaterialSnapshot,
  collectRuntimeCredentialSensitiveValues,
  decryptRuntimeMcpRows,
  resolveRuntimeResources,
  RuntimeMaterialError,
} from "./resourceMaterial";

export interface RuntimeMaterialPipeline {
  materialProvider: RuntimeMaterialProvider;
  projectionRedactorFactory: RuntimeProjectionRedactorFactory;
  resourceStager: RuntimeResourceStager;
}

export function createRuntimeMaterialPipeline(input: {
  masterKey: Buffer;
  apiUrl: string;
  bundledSkill: CompanionRuntimeSkill;
  runtime(): CompanionBoxRuntimeV2;
  loadSkillArchive(storagePath: string, signal: AbortSignal): Promise<Buffer>;
  refreshOauth?(
    credential: CompanionPluginStoredOAuthCredential,
    signal?: AbortSignal,
  ): Promise<CompanionPluginStoredOAuthCredential>;
  uuid?: () => string;
  now?: () => number;
}): RuntimeMaterialPipeline {
  const refreshedByMaterial = new WeakMap<
    RuntimeWorkMaterial,
    Map<string, CompanionPluginStoredOAuthCredential>
  >();
  const now = input.now ?? Date.now;
  const uuid = input.uuid ?? randomUUID;
  const refreshOauth = input.refreshOauth
    ?? (async (credential, signal) => await refreshCompanionPluginOAuth({ credential, signal }));

  const materialProvider: RuntimeMaterialProvider = {
    async getMaterial({ store, fence, signal }) {
      const material = await store.getMaterial(fence, RUNTIME_LEASE_SECONDS);
      if (!material) return null;
      const refreshed = new Map<string, CompanionPluginStoredOAuthCredential>();
      for (const row of fence.workKind === "attempt" || fence.workKind === "decision"
        ? []
        : decryptRuntimeMcpRows({
          orgId: fence.orgId,
          mcpMaterial: material.mcpMaterial,
          masterKey: input.masterKey,
        })) {
        if (row.decrypted.kind !== "oauth") continue;
        const expiresAt = row.decrypted.credential.accessExpiresAt === null
          ? null
          : Date.parse(row.decrypted.credential.accessExpiresAt);
        if (
          expiresAt === null
          || expiresAt > now() + COMPANION_MCP_OAUTH_REFRESH_SKEW_MS
        ) continue;
        const active = await refreshOauth(row.decrypted.credential, signal);
        if (signal?.aborted) throw signal.reason ?? new Error("Runtime material refresh aborted");
        const nextGeneration = uuid();
        const envelope = encryptCompanionMcpRuntimeCredential({
          orgId: fence.orgId,
          accountId: row.accountId,
          credentialGeneration: nextGeneration,
          credential: active,
        }, input.masterKey);
        if (signal?.aborted) throw signal.reason ?? new Error("Runtime material refresh aborted");
        const persisted = await store.casMcpOauth(fence, {
          accountId: row.accountId,
          expectedGeneration: row.credentialGeneration,
          nextGeneration,
          envelope,
        });
        if (!persisted?.updated || persisted.credentialGeneration !== nextGeneration) {
          // The active lease or frozen credential snapshot moved. Engine treats this exact class as
          // fence loss and does not stage the uncommitted plaintext.
          throw new RuntimeStoreSerializationError();
        }
        material.mcpMaterial = material.mcpMaterial.map((raw) => {
          if (
            raw.account_id !== row.accountId
            || raw.credential_generation !== row.credentialGeneration
          ) return raw;
          return {
            ...raw,
            credential_generation: nextGeneration,
            ciphertext: envelope.ciphertext,
            iv: envelope.iv,
            auth_tag: envelope.authTag,
            wrapped_dek: envelope.wrappedDek,
            wrap_iv: envelope.wrapIv,
            wrap_auth_tag: envelope.wrapAuthTag,
            key_id: envelope.keyId,
          };
        });
        refreshed.set(oauthKey(row.accountId, nextGeneration), active);
      }
      refreshedByMaterial.set(material, refreshed);
      return material;
    },
  };

  const projectionRedactorFactory: RuntimeProjectionRedactorFactory = {
    forMaterial({ orgId, material }) {
      const sensitiveValues = collectRuntimeCredentialSensitiveValues({
        orgId,
        material,
        masterKey: input.masterKey,
      });
      return createRuntimeVisibleTextRedactor(sensitiveValues);
    },
  };

  const resourceStager: RuntimeResourceStager = {
    async stageExistingBox(stage) {
      if (stage.allowBoxCreate !== false) {
        throw new RuntimeMaterialError("runtime_material_invalid");
      }
      const generation = stage.authorization.runtimeGeneration;
      const modelId = stage.authorization.modelId;
      if (generation === null || modelId === null) {
        throw new RuntimeMaterialError("runtime_material_invalid");
      }
      assertRuntimeMaterialSnapshot({
        material: stage.material,
        authorization: stage.authorization,
      });
      const resources = await resolveRuntimeResources({
        orgId: stage.orgId,
        material: stage.material,
        masterKey: input.masterKey,
        loadSkillArchive: input.loadSkillArchive,
        resolveOauth: async (oauth) => {
          const active = refreshedByMaterial.get(stage.material)?.get(
            oauthKey(oauth.accountId, oauth.credentialGeneration),
          );
          if (!active) throw new RuntimeMaterialError("runtime_material_invalid");
          return active;
        },
        signal: stage.signal,
        now,
      });
      const nativeMobile = stage.clientSurface === "native_mobile";
      const skills = nativeMobile
        ? []
        : [
          input.bundledSkill,
          ...resources.skills.filter((skill) => skill.slug !== COMPANION_SKILL_KEY),
        ];
      // S3 reads and OAuth work above are asynchronous. Recheck the immutable ref tuples at the
      // final side-effect boundary so no local mutation can cross into Box unnoticed.
      assertRuntimeMaterialSnapshot({
        material: stage.material,
        authorization: stage.authorization,
      });
      const observed = await input.runtime().stageExistingBox({
        orgId: stage.orgId,
        companionId: stage.companionId,
        boxId: stage.boxId,
        runtimeGeneration: generationNumber(generation),
        clientSurface: stage.clientSurface,
        providerAuth: resources.providerAuth,
        replaceProviderAuth: true,
        instructions: stage.authorization.persona,
        modelId,
        mcpCredentials: nativeMobile ? [] : resources.mcpCredentials,
        mcpAccounts: nativeMobile ? [] : resources.mcpAccounts,
        skills,
        hubEnv: nativeMobile
          ? {}
          : {
            COMPANION_API_URL: input.apiUrl,
            COMPANION_WORKSPACE_ID: stage.orgId,
          },
        signal: stage.signal,
      });
      return {
        diskLayoutVersion: observed.diskLayoutVersion,
        appliedSettingsRevision: stage.targetSettingsRevision,
        appliedSkillsRevision: nativeMobile ? null : stage.targetSkillsRevision,
      };
    },
  };
  return { materialProvider, projectionRedactorFactory, resourceStager };
}

let bundledSkillPromise: Promise<CompanionRuntimeSkill> | null = null;

/** Load immutable bundled bytes before starting the claim loop; no runtime claim reads source files. */
export function loadBundledCompanionRuntimeSkill(): Promise<CompanionRuntimeSkill> {
  bundledSkillPromise ??= Promise.all([
    getCompanionSkillPackage(),
    packDir(companionSkillDir()),
  ]).then(([metadata, packed]) => ({
    slug: COMPANION_SKILL_KEY,
    version: metadata.version,
    checksum: packed.checksum,
    archive: packed.archive,
  })).catch((error: unknown) => {
    bundledSkillPromise = null;
    throw error;
  });
  return bundledSkillPromise;
}

function oauthKey(accountId: string, generation: string): string {
  return `${accountId}:${generation}`;
}

function generationNumber(value: bigint): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > 2_147_483_647) {
    throw new RuntimeMaterialError("runtime_material_invalid");
  }
  return number;
}
