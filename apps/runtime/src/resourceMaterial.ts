import type { CompanionMcpAccount, CompanionMcpCredential } from "@companion/contracts";
import { companionMcpAccountSchema, companionMcpCredentialSchema } from "@companion/contracts";
import {
  COMPANION_MCP_OAUTH_REFRESH_SKEW_MS,
  decryptCompanionMcpRuntimeCredential,
  decryptCompanionProviderRuntimeCredential,
  type CompanionPluginStoredOAuthCredential,
  type CompanionRuntimeMcpCredential,
  type CompanionRuntimeProviderCredential,
} from "@companion/core";
import type { CompanionRuntimeSkill } from "@companion/box-runtime";
import type { RuntimeAuthorization } from "@companion/companion-runtime";
import { MAX_ARCHIVE_BYTES, skillChecksum, toTar } from "@companion/skills";

export interface RuntimeMaterialRows {
  providerMaterial: Record<string, unknown>[];
  skillMaterial: Record<string, unknown>[];
  mcpMaterial: Record<string, unknown>[];
}

export interface ResolvedRuntimeResources {
  providerAuth: Record<string, CompanionRuntimeProviderCredential>;
  skills: CompanionRuntimeSkill[];
  mcpAccounts: CompanionMcpAccount[];
  mcpCredentials: CompanionMcpCredential[];
}

export interface RuntimeOauthResolutionInput {
  accountId: string;
  credentialGeneration: string;
  credential: CompanionPluginStoredOAuthCredential;
}

export interface DecryptedRuntimeMcpRow {
  accountId: string;
  credentialGeneration: string;
  account: CompanionMcpAccount;
  decrypted: CompanionRuntimeMcpCredential;
}

function collectCredentialStrings(
  value: unknown,
  output: Set<string>,
): void {
  if (typeof value === "string") {
    if (value.length > 0) output.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectCredentialStrings(item, output);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const child of Object.values(value as Record<string, unknown>)) {
    collectCredentialStrings(child, output);
  }
}

/** Decrypt only the credential fields needed by the in-memory transcript redactor. */
export function collectRuntimeCredentialSensitiveValues(input: {
  orgId: string;
  material: RuntimeMaterialRows;
  masterKey: Buffer;
}): string[] {
  try {
    const values = new Set<string>();
    for (const raw of input.material.providerMaterial) {
      const row = providerRow(raw);
      const credential = decryptCompanionProviderRuntimeCredential({
        orgId: input.orgId,
        providerId: row.providerId,
        credentialGeneration: row.credentialGeneration,
        envelope: row.envelope,
      }, input.masterKey);
      collectCredentialStrings(credential, values);
    }
    for (const row of decryptRuntimeMcpRows({
      orgId: input.orgId,
      mcpMaterial: input.material.mcpMaterial,
      masterKey: input.masterKey,
    })) {
      collectCredentialStrings(row.decrypted, values);
    }
    return [...values];
  } catch (error) {
    if (error instanceof RuntimeMaterialError) throw error;
    throw new RuntimeMaterialError("runtime_material_invalid");
  }
}

export class RuntimeMaterialError extends Error {
  constructor(readonly code: "runtime_material_invalid" | "skill_archive_invalid") {
    super(code === "skill_archive_invalid"
      ? "An authorized Skill archive failed integrity validation."
      : "Authorized Companion runtime material is invalid.");
    this.name = "RuntimeMaterialError";
  }
}

/**
 * Prove that encrypted/material bytes still represent the exact refs returned by the immediate
 * pre-Box reauthorization. This closes the gap between get_material and session.external when an
 * operator rotates a provider/MCP credential or publishes a different Skill version.
 */
export function assertRuntimeMaterialSnapshot(input: {
  material: RuntimeMaterialRows;
  authorization: Pick<RuntimeAuthorization, "providerRefs" | "skillRefs" | "mcpRefs">;
}): void {
  try {
    const materialProviders = input.material.providerMaterial.map((raw) => {
      const row = providerRow(raw);
      return JSON.stringify([row.providerId, row.credentialGeneration, row.credentialVersion]);
    });
    const authorizedProviders = input.authorization.providerRefs.map((ref) => JSON.stringify([
      ref.provider_id,
      ref.credential_generation,
      ref.credential_version,
    ]));
    const materialSkills = input.material.skillMaterial.map((raw) => {
      const row = skillRow(raw);
      return JSON.stringify([row.skillId, row.versionId]);
    });
    const authorizedSkills = input.authorization.skillRefs.map((ref) => JSON.stringify([
      ref.skill_id,
      ref.current_version_id,
    ]));
    const materialMcp = input.material.mcpMaterial.map((raw) => {
      const row = mcpRow(raw);
      return JSON.stringify([row.accountId, row.credentialGeneration]);
    });
    const authorizedMcp = input.authorization.mcpRefs.map((ref) => JSON.stringify([
      ref.account_id,
      ref.credential_generation,
    ]));
    if (
      !sameUniqueRefs(materialProviders, authorizedProviders)
      || !sameUniqueRefs(materialSkills, authorizedSkills)
      || !sameUniqueRefs(materialMcp, authorizedMcp)
    ) throw new RuntimeMaterialError("runtime_material_invalid");
  } catch (error) {
    if (error instanceof RuntimeMaterialError) throw error;
    throw new RuntimeMaterialError("runtime_material_invalid");
  }
}

/**
 * Decrypt and integrity-check the exact generation-pinned SQL snapshot. Every thrown message is
 * fixed copy: ciphertext, plaintext, storage keys, signed URLs and provider values never escape.
 */
export async function resolveRuntimeResources(input: {
  orgId: string;
  material: RuntimeMaterialRows;
  masterKey: Buffer;
  loadSkillArchive(storagePath: string, signal: AbortSignal): Promise<Buffer>;
  resolveOauth?(input: RuntimeOauthResolutionInput): Promise<CompanionPluginStoredOAuthCredential>;
  signal: AbortSignal;
  now?: () => number;
}): Promise<ResolvedRuntimeResources> {
  try {
    input.signal.throwIfAborted();
    const providerAuth: Record<string, CompanionRuntimeProviderCredential> = {};
    for (const raw of input.material.providerMaterial) {
      const row = providerRow(raw);
      if (providerAuth[row.providerId]) throw new RuntimeMaterialError("runtime_material_invalid");
      const credential = decryptCompanionProviderRuntimeCredential({
        orgId: input.orgId,
        providerId: row.providerId,
        credentialGeneration: row.credentialGeneration,
        envelope: row.envelope,
      }, input.masterKey);
      if (
        (row.authMethod === "api_key" && credential.type !== "api_key")
        || (row.authMethod !== "api_key" && credential.type !== "oauth")
      ) throw new RuntimeMaterialError("runtime_material_invalid");
      providerAuth[row.providerId] = credential;
    }

    const skills: CompanionRuntimeSkill[] = [];
    const skillIds = new Set<string>();
    for (const raw of input.material.skillMaterial) {
      const row = skillRow(raw);
      if (skillIds.has(row.skillId)) throw new RuntimeMaterialError("runtime_material_invalid");
      skillIds.add(row.skillId);
      input.signal.throwIfAborted();
      const archive = await input.loadSkillArchive(row.storagePath, input.signal);
      input.signal.throwIfAborted();
      if (
        archive.byteLength !== row.sizeBytes
        || archive.byteLength > MAX_ARCHIVE_BYTES
        || skillChecksum(toTar(archive)) !== row.checksum
      ) throw new RuntimeMaterialError("skill_archive_invalid");
      skills.push({
        slug: row.slug,
        version: row.version,
        checksum: row.checksum,
        archive,
      });
    }

    const mcpAccounts: CompanionMcpAccount[] = [];
    const mcpCredentials: CompanionMcpCredential[] = [];
    const accountIds = new Set<string>();
    for (const row of decryptRuntimeMcpRows({
      orgId: input.orgId,
      mcpMaterial: input.material.mcpMaterial,
      masterKey: input.masterKey,
    })) {
      if (accountIds.has(row.accountId)) throw new RuntimeMaterialError("runtime_material_invalid");
      accountIds.add(row.accountId);
      const { account, decrypted } = row;
      mcpAccounts.push(account);
      if (decrypted.kind === "environment") {
        mcpCredentials.push(...decrypted.credentials);
        continue;
      }
      let oauth = decrypted.credential;
      const expiresAt = oauth.accessExpiresAt === null ? null : Date.parse(oauth.accessExpiresAt);
      if (
        expiresAt !== null
        && expiresAt <= (input.now ?? Date.now)() + COMPANION_MCP_OAUTH_REFRESH_SKEW_MS
      ) {
        if (!input.resolveOauth) throw new RuntimeMaterialError("runtime_material_invalid");
        oauth = await input.resolveOauth({
          accountId: row.accountId,
          credentialGeneration: row.credentialGeneration,
          credential: oauth,
        });
      }
      const envKey = account.transport === "http"
        ? Object.values(account.headers)[0]
        : undefined;
      mcpCredentials.push(companionMcpCredentialSchema.parse({
        env_key: envKey,
        value: `Bearer ${oauth.accessToken}`,
      }));
    }
    input.signal.throwIfAborted();
    return { providerAuth, skills, mcpAccounts, mcpCredentials };
  } catch (error) {
    if (input.signal.aborted) throw input.signal.reason;
    if (error instanceof RuntimeMaterialError) throw error;
    // Core credential/schema/storage errors may carry implementation detail; collapse all of them.
    throw new RuntimeMaterialError("runtime_material_invalid");
  }
}

export function decryptRuntimeMcpRows(input: {
  orgId: string;
  mcpMaterial: Record<string, unknown>[];
  masterKey: Buffer;
}): DecryptedRuntimeMcpRow[] {
  try {
    return input.mcpMaterial.map((raw) => {
      const row = mcpRow(raw);
      const account = companionMcpAccountSchema.parse(row.accountConfig);
      if (account.id !== row.accountId) throw new RuntimeMaterialError("runtime_material_invalid");
      return {
        accountId: row.accountId,
        credentialGeneration: row.credentialGeneration,
        account,
        decrypted: decryptCompanionMcpRuntimeCredential({
          orgId: input.orgId,
          accountId: row.accountId,
          credentialGeneration: row.credentialGeneration,
          envelope: row.envelope,
        }, input.masterKey),
      };
    });
  } catch (error) {
    if (error instanceof RuntimeMaterialError) throw error;
    throw new RuntimeMaterialError("runtime_material_invalid");
  }
}

interface EncryptedRow {
  credentialGeneration: string;
  envelope: {
    ciphertext: string;
    iv: string;
    authTag: string;
    wrappedDek: string;
    wrapIv: string;
    wrapAuthTag: string;
    keyId: string;
  };
}

function providerRow(row: Record<string, unknown>): EncryptedRow & {
  providerId: string;
  authMethod: string;
  credentialVersion: number;
} {
  const providerId = stableString(row.provider_id, 63);
  const authMethod = stableString(row.auth_method, 40);
  const credentialVersion = row.credential_version;
  if (!Number.isSafeInteger(credentialVersion) || Number(credentialVersion) < 1) {
    throw new RuntimeMaterialError("runtime_material_invalid");
  }
  return {
    providerId,
    authMethod,
    credentialVersion: Number(credentialVersion),
    ...encryptedRow(row),
  };
}

function mcpRow(row: Record<string, unknown>): EncryptedRow & {
  accountId: string;
  accountConfig: unknown;
} {
  return {
    accountId: uuid(row.account_id),
    accountConfig: row.account_config,
    ...encryptedRow(row),
  };
}

function encryptedRow(row: Record<string, unknown>): EncryptedRow {
  return {
    credentialGeneration: uuid(row.credential_generation),
    envelope: {
      ciphertext: boundedString(row.ciphertext),
      iv: boundedString(row.iv),
      authTag: boundedString(row.auth_tag),
      wrappedDek: boundedString(row.wrapped_dek),
      wrapIv: boundedString(row.wrap_iv),
      wrapAuthTag: boundedString(row.wrap_auth_tag),
      keyId: boundedString(row.key_id),
    },
  };
}

function skillRow(row: Record<string, unknown>): {
  skillId: string;
  versionId: string;
  slug: string;
  version: string;
  checksum: string;
  sizeBytes: number;
  storagePath: string;
} {
  const checksum = boundedString(row.checksum);
  const sizeBytes = row.size_bytes;
  if (!/^sha256:[0-9a-f]{64}$/.test(checksum)) {
    throw new RuntimeMaterialError("runtime_material_invalid");
  }
  if (!Number.isSafeInteger(sizeBytes) || Number(sizeBytes) < 0 || Number(sizeBytes) > MAX_ARCHIVE_BYTES) {
    throw new RuntimeMaterialError("runtime_material_invalid");
  }
  return {
    skillId: uuid(row.skill_id),
    versionId: uuid(row.version_id),
    slug: stableString(row.slug, 200),
    version: stableString(row.version, 100),
    checksum,
    sizeBytes: Number(sizeBytes),
    storagePath: boundedString(row.storage_path, 2_048),
  };
}

function sameUniqueRefs(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  if (leftSet.size !== left.length || rightSet.size !== right.length) return false;
  return [...leftSet].every((value) => rightSet.has(value));
}

function boundedString(value: unknown, max = 1_000_000): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > max
    || /[\r\n\0]/.test(value)
  ) throw new RuntimeMaterialError("runtime_material_invalid");
  return value;
}

function stableString(value: unknown, max: number): string {
  const text = boundedString(value, max);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._+@:/-]*$/.test(text)) {
    throw new RuntimeMaterialError("runtime_material_invalid");
  }
  return text;
}

function uuid(value: unknown): string {
  const text = boundedString(value, 36);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text)) {
    throw new RuntimeMaterialError("runtime_material_invalid");
  }
  return text;
}
