import { createHash, randomUUID } from "node:crypto";
import { COMPANION_SKILL_KEY, companionSkillDir } from "@companion/companion-skill";
import { getCompanionSkillPackage } from "@companion/companion-skill/package";
import {
  type CompanionBoxRuntimeV2,
  type CompanionRuntimeSkill,
} from "@companion/box-runtime";
import {
  COMPANION_MCP_OAUTH_REFRESH_SKEW_MS,
  encryptCompanionMcpRuntimeCredential,
  githubUserIdentity,
  refreshCompanionPluginOAuth,
  type CompanionPluginStoredOAuthCredential,
} from "@companion/core";
import {
  RUNTIME_LEASE_SECONDS,
  RuntimeStoreSerializationError,
  createRuntimeVisibleTextRedactor,
  type RuntimeAttachmentStager,
  type RuntimeMaterialProvider,
  type RuntimeOutboxHarvester,
  type RuntimeOutputAttachment,
  type RuntimeProjectionRedactorFactory,
  type RuntimeResourceStager,
  type RuntimeStore,
  type RuntimeWorkMaterial,
} from "@companion/companion-runtime";
import {
  COMPANION_ATTACHMENT_MAX_BYTES,
  COMPANION_OUTPUT_ATTACHMENT_MAX_COUNT,
  COMPANION_OUTPUT_ATTACHMENT_TOTAL_MAX_BYTES,
  isCompanionAttachmentImage,
  sanitizeCompanionAttachmentFilename,
  sniffCompanionAttachmentMime,
} from "@companion/contracts";
import { packDir } from "@companion/skills";
import { companionAttachmentKey } from "@companion/storage";

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
  attachmentStager: RuntimeAttachmentStager;
  outboxHarvester: RuntimeOutboxHarvester;
}

export function companionHubApiUrl(apiUrl: string): string {
  const trimmed = apiUrl.trim().replace(/\/+$/, "");
  if (trimmed.endsWith("/v1")) return trimmed;
  return `${trimmed}/v1`;
}

export function createRuntimeMaterialPipeline(input: {
  masterKey: Buffer;
  apiUrl: string;
  bundledSkill: CompanionRuntimeSkill;
  runtime(): CompanionBoxRuntimeV2;
  loadSkillArchive(storagePath: string, signal: AbortSignal): Promise<Buffer>;
  /** Object-storage read for one chat attachment. Same bucket, deliberately a separate seam. */
  loadAttachment(storageKey: string, signal: AbortSignal): Promise<Buffer>;
  /** Store one harvested image under its content address and answer with the key it landed on. */
  storeAttachment(input: {
    key: string;
    bytes: Buffer;
    contentType: string;
    signal: AbortSignal;
  }): Promise<void>;
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
  const hubTokensByMaterial = new WeakMap<RuntimeWorkMaterial, string>();

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
      if (fence.workKind === "settings" || fence.workKind === "operation") {
        material.configCatalog = await store.getConfigCatalog(fence, RUNTIME_LEASE_SECONDS);
        const hubToken = await store.mintHubToken(fence, RUNTIME_LEASE_SECONDS);
        if (hubToken) hubTokensByMaterial.set(material, hubToken);
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
        resolveGithubIdentity: async ({ accessToken }) => await githubUserIdentity({
          accessToken,
          signal: stage.signal,
        }),
        signal: stage.signal,
        now,
      });
      const nativeMobile = stage.clientSurface === "native_mobile";
      const hubToken = nativeMobile ? undefined : hubTokensByMaterial.get(stage.material);
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
            COMPANION_API_URL: companionHubApiUrl(input.apiUrl),
            COMPANION_WORKSPACE_ID: stage.orgId,
            ...resources.extraEnv,
            ...(hubToken ? { COMPANION_DELEGATION_TOKEN: hubToken } : {}),
          },
        configCatalog: nativeMobile ? null : stage.material.configCatalog,
        signal: stage.signal,
      });
      return {
        diskLayoutVersion: observed.diskLayoutVersion,
        appliedSettingsRevision: stage.targetSettingsRevision,
        appliedSkillsRevision: nativeMobile ? null : stage.targetSkillsRevision,
      };
    },
    async refreshLayout(stage) {
      const observed = await input.runtime().refreshPiLayout({
        boxId: stage.boxId,
        signal: stage.signal,
      });
      return { applied: observed.applied };
    },
    async invalidateLayout(stage) {
      await input.runtime().invalidatePiLayoutOverlay({
        boxId: stage.boxId,
        signal: stage.signal,
      });
    },
  };
  const attachmentStager: RuntimeAttachmentStager = {
    async stageAttachments(stage) {
      const files = [];
      for (const attachment of stage.material.attachments) {
        const bytes = await input.loadAttachment(attachment.storageKey, stage.signal);
        // The digest is checked against what the control plane accepted, not against what object
        // storage happened to return. A truncated read, a rewritten object, or the wrong key all
        // fail here rather than being staged and described to Pi as the member's file.
        const digest = createHash("sha256").update(bytes).digest("hex");
        if (bytes.byteLength !== attachment.byteSize || digest !== attachment.sha256) {
          throw new RuntimeMaterialError("runtime_material_invalid");
        }
        files.push({
          position: attachment.position,
          filename: attachment.filename,
          contentType: attachment.contentType,
          bytes,
        });
      }
      // Object-storage reads above are asynchronous. Recheck the immutable ref tuples at the final
      // point before Box contact, exactly as resource staging does, so no local mutation crosses
      // into the Box unnoticed.
      assertRuntimeMaterialSnapshot({
        material: stage.material,
        authorization: stage.authorization,
      });
      return await input.runtime().stageAttachments({
        boxId: stage.boxId,
        messageId: messageIdFromEventId(stage.messageEventId),
        files,
        signal: stage.signal,
      });
    },
  };
  const outboxHarvester: RuntimeOutboxHarvester = {
    async clearOutbox({ boxId, signal }) {
      await input.runtime().clearOutbox({ boxId, signal });
    },
    async harvestOutbox(harvest) {
      const listed = await input.runtime().listOutbox({
        boxId: harvest.boxId,
        deadlineAt: harvest.deadlineAt,
        signal: harvest.signal,
      });
      // Bound before anything is transferred: a Box that filled its outbox must not be able to turn
      // one reply into an unbounded read. What is dropped here is reported as incomplete rather than
      // silently forgotten.
      const eligible = listed.filter((entry) =>
        entry.byteSize > 0 && entry.byteSize <= COMPANION_ATTACHMENT_MAX_BYTES);
      const selected = eligible.slice(0, COMPANION_OUTPUT_ATTACHMENT_MAX_COUNT);
      let incomplete = selected.length < listed.length;

      const attachments: RuntimeOutputAttachment[] = [];
      let total = 0;
      for (const entry of selected) {
        if (now() >= harvest.deadlineAt.getTime()) {
          incomplete = true;
          break;
        }
        if (total + entry.byteSize > COMPANION_OUTPUT_ATTACHMENT_TOTAL_MAX_BYTES) {
          incomplete = true;
          continue;
        }
        // Reading one file off the Box and storing it are one unit of work, and both are external.
        // By this point Pi has settled and any reply it produced is already durable, so a failure
        // in either costs exactly one image: the harvest keeps whatever it has already stored and
        // reports the shortfall, rather than discarding a partial set and orphaning its objects.
        try {
          const file = await input.runtime().readOutboxFile({
            boxId: harvest.boxId,
            entry,
            deadlineAt: harvest.deadlineAt,
            signal: harvest.signal,
          });
          // Pi hands back images and nothing else, and the type comes from the bytes rather than
          // from whatever extension Pi happened to choose.
          const contentType = sniffCompanionAttachmentMime(file.bytes, null);
          if (!contentType || !isCompanionAttachmentImage(contentType)) {
            incomplete = true;
            continue;
          }
          const sha256 = createHash("sha256").update(file.bytes).digest("hex");
          const key = companionAttachmentKey({
            kind: "output",
            orgId: harvest.orgId,
            companionId: harvest.companionId,
            attemptId: harvest.attemptId,
            position: attachments.length,
            sha256,
          });
          await input.storeAttachment({
            key,
            bytes: file.bytes,
            contentType,
            signal: harvest.signal,
          });
          total += file.bytes.byteLength;
          attachments.push({
            storageKey: key,
            contentType,
            byteSize: file.bytes.byteLength,
            sha256,
            filename: sanitizeCompanionAttachmentFilename({
              filename: entry.name,
              position: attachments.length,
              contentType,
            }),
          });
        } catch {
          incomplete = true;
          continue;
        }
      }
      return { attachments, incomplete };
    },
  };
  return {
    materialProvider,
    projectionRedactorFactory,
    resourceStager,
    attachmentStager,
    outboxHarvester,
  };
}

const MESSAGE_EVENT_ID_PATTERN
  = /^msg:([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;

/**
 * The staging directory is named after the client message id the turn owns, so a retry rewrites the
 * same paths and two turns never share a directory. The event id is the durable spelling of that id.
 */
function messageIdFromEventId(messageEventId: string): string {
  const messageId = MESSAGE_EVENT_ID_PATTERN.exec(messageEventId)?.[1];
  if (!messageId) throw new RuntimeMaterialError("runtime_material_invalid");
  return messageId;
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
