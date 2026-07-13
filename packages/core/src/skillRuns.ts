import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { db, schema, type Db } from "@companion/db";
import {
  RUN_MAX_DEPENDENCIES,
  RUN_RESERVED_ENV_PREFIX,
  RUN_VARIABLE_VALUE_MAX_BYTES,
  companionManifestSchema,
  parseStoredSkillFrontmatter,
  type ModelRow,
  type RunChatHistoryItem,
  type RunDeclaredSecret,
  type RunDeclaredVariable,
  type RunDependency,
  type RunInputSelection,
  type RunInputSnapshot,
  type RunSecretInputSnapshot,
  type RunVariableInputSnapshot,
  type SkillRunArtifactRow,
  type SkillRunAttachmentRow,
  type SkillRunDetail,
  type SkillRunRow,
  type SkillRunStatus,
} from "@companion/contracts";
import { canAccessRun, canAccessSkill } from "./authz";
import { getActivatedModelSets } from "./modelPreferences";
import { resolveProviderSecretPin } from "./providerConnections";
import { decryptPinnedSecret, pinAccessibleSecret, type AccessibleSecretPin } from "./secrets";
import {
  decryptOpaqueValue,
  encryptOpaqueValue,
  type OpaqueCiphertext,
} from "./secretsCrypto";
import {
  OPENCODE_SERVER_USERNAME,
  RunRuntimeError,
  type RunChatRuntime,
  type RunSandboxRuntime,
  type RunWorkspaceFiles,
  type SkillArchiveFetcher,
  type SkillBundle,
} from "./runRuntime";
import { assertMember, type ActorContext } from "./services";

/** Opens a short tenant transaction. Kept in the context so the worker can use forced RLS. */
export type TenantRunner = <T>(
  input: { orgId: string; userId: string },
  fn: (database: Db) => Promise<T>,
) => Promise<T>;

/** Framework-free dependencies shared by the API validation path and the durable worker. */
export interface RunControlContext {
  masterKey: Buffer;
  goldenSnapshotId: string | null;
  opencodeVersion: string | null;
  region: string;
  timeoutMs: number;
  /** Catalog lookup only. It is deliberately called before opening the create transaction. */
  resolveModelKeys: (model: string) => Promise<{ envKeys: string[] } | null>;
  /** Optional catalog/readiness data used by `getRunOptions`. */
  models?: ModelRow[];
  runtimeAvailable?: boolean;
  runtimeMessage?: string | null;
  /** Worker-only seams. API request handlers do not need to provide them. */
  runtime?: RunSandboxRuntime;
  chat?: RunChatRuntime;
  runTenant?: TenantRunner;
  fetchArchive?: SkillArchiveFetcher;
  fetchObject?: (key: string) => Promise<Buffer>;
}

export class RunValidationError extends Error {
  readonly code: string;

  constructor(message: string, code = "invalid_run") {
    super(message);
    this.name = "RunValidationError";
    this.code = code;
  }
}

/** Optimistic revision, duplicate name, active prompt and idempotency conflicts map to HTTP 409. */
export class RunBusyError extends Error {
  readonly code: string;

  constructor(message: string, code = "run_conflict") {
    super(message);
    this.name = "RunBusyError";
    this.code = code;
  }
}

export type RunRow = typeof schema.skillRuns.$inferSelect;
type AttachmentRow = typeof schema.skillRunAttachments.$inferSelect;
type ArtifactRow = typeof schema.skillRunArtifacts.$inferSelect;

export interface ResolvedRunSkill extends RunDependency {
  scope: "personal" | "org";
  creatorId: string;
  frontmatter: string;
  storagePath: string;
  mountOrder: number;
}

export interface ResolvedRunDeclarations {
  secrets: RunDeclaredSecret[];
  variables: RunDeclaredVariable[];
}

export interface ResolvedSkillSecretInput {
  provenance: "skill" | "model_provider";
  skillId: string | null;
  skillSlug: string | null;
  slotId: string | null;
  envKey: string;
  required: boolean;
  pin: AccessibleSecretPin;
  sourceKey: string;
}

export interface ResolvedVariableInput {
  skillId: string;
  skillSlug: string;
  envKey: string;
  value: string;
}

export interface ResolvedRunInputs {
  secrets: ResolvedSkillSecretInput[];
  variables: ResolvedVariableInput[];
}

export interface CreateRunAttachment {
  id: string;
  fileName: string;
  contentType: string;
  byteSize: number;
  storageKey: string;
}

/** Deterministic per-run sandbox name, reused by worker retries. */
export function sandboxNameForRun(orgId: string, runId: string): string {
  const org8 = orgId.replace(/-/g, "").slice(0, 8);
  const run8 = runId.replace(/-/g, "").slice(0, 8);
  return `run-${org8}-${run8}`;
}

export function buildOpencodeJson(input: { model: string }): string {
  return `${JSON.stringify(
    {
      $schema: "https://opencode.ai/config.json",
      model: input.model,
      permission: { edit: "allow", bash: "allow", webfetch: "allow" },
    },
    null,
    2,
  )}\n`;
}

export function composeRunPrompt(input: {
  prompt: string;
  skillSlug: string;
  attachmentNames: string[];
  artifactsEnabled: boolean;
}): string {
  const notes = [`Use your installed "${input.skillSlug}" skill to handle this request.`];
  if (input.attachmentNames.length > 0) {
    notes.push(
      `The user attached ${input.attachmentNames.length === 1 ? "a file" : "files"} under ./attachments/: ${input.attachmentNames.join(", ")}.`,
    );
  }
  if (input.artifactsEnabled) {
    notes.push("Save any deliverable files into ./artifacts/ — they will be shared with the user as links.");
  }
  return `${input.prompt.trim()}\n\n---\n${notes.join("\n")}\n`;
}

const PROMPT_EXCERPT_MAX = 140;

function promptExcerpt(prompt: string): string {
  const flat = prompt.replace(/\s+/g, " ").trim();
  return flat.length > PROMPT_EXCERPT_MAX ? `${flat.slice(0, PROMPT_EXCERPT_MAX)}…` : flat;
}

export function capTranscript(items: RunChatHistoryItem[], maxBytes = 512 * 1024): RunChatHistoryItem[] {
  const size = (list: RunChatHistoryItem[]) => Buffer.byteLength(JSON.stringify(list), "utf8");
  if (size(items) <= maxBytes) return items;
  const trimmed = items.map((item) => ({ ...item }));
  for (const item of trimmed) {
    if (size(trimmed) <= maxBytes) return trimmed;
    if (item.kind === "tool" && item.output) item.output = "…(trimmed)";
  }
  while (trimmed.length > 1 && size(trimmed) > maxBytes) trimmed.shift();
  return trimmed;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child)]),
  );
}

export function hashRunPayload(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

/** UUID-shaped deterministic OpenCode id derived from a durable logical prompt identity. */
export function deterministicRunMessageId(runId: string, ordinal: number): string {
  const bytes = createHash("sha256").update(`companion-run-prompt:v1:${runId}:${ordinal}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function isUniqueViolation(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: unknown }).code === "23505",
  );
}

function parseManifestEnvironment(frontmatter: string): {
  env: Record<string, { required: boolean; description: string }>;
} {
  let raw: { companion?: unknown };
  try {
    raw = JSON.parse(frontmatter) as { companion?: unknown };
  } catch {
    const legacy = parseStoredSkillFrontmatter(frontmatter);
    if (!legacy) throw new RunValidationError("stored skill environment is invalid", "invalid_skill_manifest");
    return {
      env: Object.fromEntries(
        (legacy.requirements ?? [])
          .filter((requirement) => requirement.type === "env")
          .map((requirement) => [
            requirement.key,
            { required: requirement.required, description: requirement.note },
          ]),
      ),
    };
  }
  if (raw.companion !== undefined) {
    const parsed = companionManifestSchema.safeParse(raw.companion);
    if (!parsed.success) {
      throw new RunValidationError("stored skill environment is invalid", "invalid_skill_manifest");
    }
    return { env: parsed.data.environment.env };
  }
  const legacy = parseStoredSkillFrontmatter(frontmatter);
  return {
    env: Object.fromEntries(
      (legacy?.requirements ?? [])
        .filter((requirement) => requirement.type === "env")
        .map((requirement) => [
          requirement.key,
          { required: requirement.required, description: requirement.note },
        ]),
    ),
  };
}

/**
 * Resolve the exact current root plus the complete exact-current dependency closure. Dependency
 * edges belong to source versions, so every traversal step uses the version pinned for that node.
 */
export async function resolveRunDependencyClosure(input: {
  actor: ActorContext;
  orgId: string;
  slug: string;
  skillVersionId: string;
  database: Db;
}): Promise<ResolvedRunSkill[]> {
  const [skillRows, versionRows, dependencyRows] = await Promise.all([
    input.database
      .select({
        id: schema.skills.id,
        slug: schema.skills.slug,
        scope: schema.skills.scope,
        creatorId: schema.skills.creatorId,
        archivedAt: schema.skills.archivedAt,
        currentVersionId: schema.skills.currentVersionId,
      })
      .from(schema.skills)
      .where(eq(schema.skills.orgId, input.orgId)),
    input.database
      .select({
        id: schema.skillVersions.id,
        skillId: schema.skillVersions.skillId,
        version: schema.skillVersions.version,
        frontmatter: schema.skillVersions.frontmatter,
        storagePath: schema.skillVersions.storagePath,
      })
      .from(schema.skillVersions)
      .where(eq(schema.skillVersions.orgId, input.orgId)),
    input.database
      .select({
        skillVersionId: schema.skillVersionDependencies.skillVersionId,
        dependsOnSlug: schema.skillVersionDependencies.dependsOnSlug,
        dependsOnSkillId: schema.skillVersionDependencies.dependsOnSkillId,
      })
      .from(schema.skillVersionDependencies)
      .where(eq(schema.skillVersionDependencies.orgId, input.orgId)),
  ]);

  const skillsById = new Map(skillRows.map((skill) => [skill.id, skill]));
  const versionsById = new Map(versionRows.map((version) => [version.id, version]));
  const root = skillRows.find((skill) => skill.slug === input.slug);
  if (!root || root.archivedAt || !canAccessSkill(input.actor.id, root)) {
    throw new RunValidationError("skill not found", "skill_not_found");
  }
  if (!root.currentVersionId) {
    throw new RunValidationError(`skill ${input.slug} has no published version`, "version_unavailable");
  }
  if (root.currentVersionId !== input.skillVersionId) {
    throw new RunValidationError("the skill changed since the launcher was opened", "stale_skill_version");
  }

  const edges = new Map<string, typeof dependencyRows>();
  for (const edge of dependencyRows) {
    const list = edges.get(edge.skillVersionId) ?? [];
    list.push(edge);
    edges.set(edge.skillVersionId, list);
  }
  for (const list of edges.values()) list.sort((a, b) => a.dependsOnSlug.localeCompare(b.dependsOnSlug));

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const closure: ResolvedRunSkill[] = [];

  const visit = (skillId: string, depth: number, via: string | null, isRoot: boolean): void => {
    if (visiting.has(skillId)) {
      const skill = skillsById.get(skillId);
      throw new RunValidationError(`dependency cycle detected at ${skill?.slug ?? "unknown"}`, "dependency_cycle");
    }
    if (visited.has(skillId)) return;
    if (closure.length >= RUN_MAX_DEPENDENCIES + 1) {
      throw new RunValidationError("the dependency closure is too large", "dependency_limit");
    }

    const skill = skillsById.get(skillId);
    if (!skill || skill.archivedAt || !skill.currentVersionId || !canAccessSkill(input.actor.id, skill)) {
      throw new RunValidationError("a required dependency is unavailable", "dependency_unavailable");
    }
    const version = versionsById.get(skill.currentVersionId);
    if (!version || version.skillId !== skill.id) {
      throw new RunValidationError("a required dependency version is unavailable", "dependency_version_unavailable");
    }

    visiting.add(skillId);
    closure.push({
      skill_id: skill.id,
      skill_version_id: version.id,
      slug: skill.slug,
      version: version.version,
      root: isRoot,
      depth,
      via,
      scope: skill.scope,
      creatorId: skill.creatorId,
      frontmatter: version.frontmatter,
      storagePath: version.storagePath,
      mountOrder: closure.length,
    });

    for (const edge of edges.get(version.id) ?? []) {
      if (!edge.dependsOnSkillId) {
        throw new RunValidationError(`dependency ${edge.dependsOnSlug} is missing`, "dependency_missing");
      }
      const target = skillsById.get(edge.dependsOnSkillId);
      if (!target || target.slug !== edge.dependsOnSlug) {
        throw new RunValidationError(`dependency ${edge.dependsOnSlug} is unavailable`, "dependency_unavailable");
      }
      visit(target.id, depth + 1, skill.slug, false);
    }
    visiting.delete(skillId);
    visited.add(skillId);
  };

  visit(root.id, 0, null, true);
  return closure;
}

export async function loadRunDeclarations(input: {
  actor: ActorContext;
  orgId: string;
  closure: ResolvedRunSkill[];
  database: Db;
  includeCandidates?: boolean;
}): Promise<ResolvedRunDeclarations> {
  const versionIds = input.closure.map((skill) => skill.skill_version_id);
  const slotRows = versionIds.length
    ? await input.database
        .select()
        .from(schema.skillVersionSecretSlots)
        .where(
          and(
            eq(schema.skillVersionSecretSlots.orgId, input.orgId),
            inArray(schema.skillVersionSecretSlots.skillVersionId, versionIds),
          ),
        )
    : [];

  const candidateRows = input.includeCandidates
    ? await import("./secrets").then(({ listSecrets }) =>
        listSecrets({ actor: input.actor, orgId: input.orgId, database: input.database }),
      )
    : [];
  const candidates = candidateRows
    .filter((secret) => secret.can_use && !secret.disabled_at && !secret.deleted_at)
    .map((secret) => ({
      id: secret.id,
      name: secret.name,
      key: secret.key,
      owner: secret.owner,
      audience: secret.audience,
      personal: secret.owner.id === input.actor.id,
    }));
  const candidateIds = new Set(candidates.map((candidate) => candidate.id));

  const bindings = await input.database
    .select()
    .from(schema.skillSecretBindings)
    .where(
      and(
        eq(schema.skillSecretBindings.orgId, input.orgId),
        eq(schema.skillSecretBindings.userId, input.actor.id),
      ),
    );
  const prefill = new Map(
    bindings
      .filter((binding) => binding.revokedAt === null)
      .map((binding) => [`${binding.skillId}:${binding.slotId}`, binding.secretId]),
  );

  const order = new Map(input.closure.map((skill, index) => [skill.skill_id, index]));
  const skillById = new Map(input.closure.map((skill) => [skill.skill_id, skill]));
  const secrets: RunDeclaredSecret[] = slotRows
    .map((slot) => {
      const skill = skillById.get(slot.skillId);
      if (!skill || slot.skillVersionId !== skill.skill_version_id) return null;
      if (slot.envKey.startsWith(RUN_RESERVED_ENV_PREFIX)) {
        throw new RunValidationError(
          `${skill.slug} declares reserved environment key ${slot.envKey}`,
          "reserved_environment_key",
        );
      }
      return {
        skill_id: skill.skill_id,
        skill_version_id: skill.skill_version_id,
        skill_slug: skill.slug,
        slot_id: slot.slotId,
        env_key: slot.envKey,
        description: slot.description,
        required: slot.required,
        candidates,
        prefill_secret_id: candidateIds.has(prefill.get(`${skill.skill_id}:${slot.slotId}`) ?? "")
          ? prefill.get(`${skill.skill_id}:${slot.slotId}`) ?? null
          : null,
      } satisfies RunDeclaredSecret;
    })
    .filter((value): value is RunDeclaredSecret => value !== null)
    .sort(
      (a, b) =>
        (order.get(a.skill_id) ?? 0) - (order.get(b.skill_id) ?? 0) || a.env_key.localeCompare(b.env_key),
    );

  const variables: RunDeclaredVariable[] = [];
  for (const skill of input.closure) {
    const manifest = parseManifestEnvironment(skill.frontmatter);
    for (const [envKey, declaration] of Object.entries(manifest.env).sort(([a], [b]) => a.localeCompare(b))) {
      if (envKey.startsWith(RUN_RESERVED_ENV_PREFIX)) {
        throw new RunValidationError(
          `${skill.slug} declares reserved environment key ${envKey}`,
          "reserved_environment_key",
        );
      }
      variables.push({
        skill_id: skill.skill_id,
        skill_version_id: skill.skill_version_id,
        skill_slug: skill.slug,
        env_key: envKey,
        description: declaration.description,
        required: declaration.required,
      });
    }
  }
  return { secrets, variables };
}

function samePin(left: AccessibleSecretPin, right: AccessibleSecretPin): boolean {
  return left.secretId === right.secretId && left.version === right.version;
}

/** Validate explicit selections and resolve immutable pins. No binding is ever added implicitly. */
export async function validateRunInputSelection(input: {
  actor: ActorContext;
  orgId: string;
  model: string;
  modelEnvKeys: string[];
  selection: RunInputSelection;
  declarations: ResolvedRunDeclarations;
  database: Db;
  allowMissingRequired?: boolean;
  providerRequired?: boolean;
  /** Unit-test/domain seam; production callers use the vault service above. */
  pinSecret?: (secretId: string) => Promise<AccessibleSecretPin>;
  /** Unit-test/domain seam; production callers resolve personal-then-workspace bindings. */
  providerPin?: { keyName: string; secret: AccessibleSecretPin } | null;
}): Promise<ResolvedRunInputs> {
  const secretDeclarations = new Map(
    input.declarations.secrets.map((declaration) => [
      `${declaration.skill_id}:${declaration.slot_id}`,
      declaration,
    ]),
  );
  const variableDeclarations = new Map(
    input.declarations.variables.map((declaration) => [
      `${declaration.skill_id}:${declaration.env_key}`,
      declaration,
    ]),
  );
  const selectedSecrets = new Map(
    input.selection.secrets.map((selection) => [`${selection.skill_id}:${selection.slot_id}`, selection]),
  );
  const selectedVariables = new Map(
    input.selection.variables.map((selection) => [`${selection.skill_id}:${selection.env_key}`, selection]),
  );
  if (selectedSecrets.size !== input.selection.secrets.length) {
    throw new RunValidationError("a secret slot was selected more than once", "duplicate_secret_slot");
  }
  if (selectedVariables.size !== input.selection.variables.length) {
    throw new RunValidationError("a variable was supplied more than once", "duplicate_variable");
  }

  for (const key of selectedSecrets.keys()) {
    if (!secretDeclarations.has(key)) {
      throw new RunValidationError("an unknown or obsolete secret slot was selected", "unknown_secret_slot");
    }
  }
  for (const key of selectedVariables.keys()) {
    if (!variableDeclarations.has(key)) {
      throw new RunValidationError("an unknown or obsolete variable was supplied", "unknown_variable");
    }
  }
  if (!input.allowMissingRequired) {
    for (const [key, declaration] of secretDeclarations) {
      if (declaration.required && !selectedSecrets.has(key)) {
        throw new RunValidationError(`${declaration.env_key} is required`, "required_secret_missing");
      }
    }
    for (const [key, declaration] of variableDeclarations) {
      if (declaration.required && !selectedVariables.has(key)) {
        throw new RunValidationError(`${declaration.env_key} is required`, "required_variable_missing");
      }
    }
  }

  const resolvedSecrets: ResolvedSkillSecretInput[] = [];
  for (const [key, selection] of selectedSecrets) {
    const declaration = secretDeclarations.get(key)!;
    let pin: AccessibleSecretPin;
    try {
      pin = input.pinSecret
        ? await input.pinSecret(selection.secret_id)
        : await pinAccessibleSecret({
            actor: input.actor,
            orgId: input.orgId,
            secretId: selection.secret_id,
            database: input.database,
          });
    } catch {
      throw new RunValidationError("secret unavailable", "secret_unavailable");
    }
    resolvedSecrets.push({
      provenance: "skill",
      skillId: declaration.skill_id,
      skillSlug: declaration.skill_slug,
      slotId: declaration.slot_id,
      envKey: declaration.env_key,
      required: declaration.required,
      pin,
      sourceKey: `${declaration.skill_id}:${declaration.slot_id}`,
    });
  }

  const variables: ResolvedVariableInput[] = input.selection.variables.map((selection) => {
    const declaration = variableDeclarations.get(`${selection.skill_id}:${selection.env_key}`)!;
    if (
      selection.value.includes("\0") ||
      Buffer.byteLength(selection.value, "utf8") > RUN_VARIABLE_VALUE_MAX_BYTES
    ) {
      throw new RunValidationError(`${declaration.env_key} has an invalid value`, "invalid_variable_value");
    }
    return {
      skillId: declaration.skill_id,
      skillSlug: declaration.skill_slug,
      envKey: declaration.env_key,
      value: selection.value,
    };
  });

  const provider = input.model.split("/", 1)[0] ?? "";
  if (!provider) throw new RunValidationError("the model provider is invalid", "model_unavailable");
  let providerBinding = input.providerPin;
  if (providerBinding === undefined) {
    try {
      providerBinding = await resolveProviderSecretPin({
        actor: input.actor,
        orgId: input.orgId,
        provider,
        database: input.database,
      });
    } catch {
      providerBinding = null;
    }
  }
  if (!providerBinding || !input.modelEnvKeys.includes(providerBinding.keyName)) {
    if (input.providerRequired !== false || providerBinding) {
      throw new RunValidationError("the model provider is not connected", "provider_disconnected");
    }
  } else {
    resolvedSecrets.push({
      provenance: "model_provider",
      skillId: null,
      skillSlug: null,
      slotId: null,
      envKey: providerBinding.keyName,
      required: true,
      pin: providerBinding.secret,
      sourceKey: `${provider}:${providerBinding.keyName}`,
    });
  }

  const byEnv = new Map<string, { kind: "secret"; pin: AccessibleSecretPin } | { kind: "variable"; value: string }>();
  for (const secret of resolvedSecrets) {
    if (secret.envKey.startsWith(RUN_RESERVED_ENV_PREFIX)) {
      throw new RunValidationError(`${secret.envKey} is reserved by the runtime`, "reserved_environment_key");
    }
    const existing = byEnv.get(secret.envKey);
    if (existing && (existing.kind !== "secret" || !samePin(existing.pin, secret.pin))) {
      throw new RunValidationError(`environment key ${secret.envKey} has conflicting inputs`, "input_collision");
    }
    byEnv.set(secret.envKey, { kind: "secret", pin: secret.pin });
  }
  for (const variable of variables) {
    if (variable.envKey.startsWith(RUN_RESERVED_ENV_PREFIX)) {
      throw new RunValidationError(`${variable.envKey} is reserved by the runtime`, "reserved_environment_key");
    }
    const existing = byEnv.get(variable.envKey);
    if (existing && (existing.kind !== "variable" || existing.value !== variable.value)) {
      throw new RunValidationError(`environment key ${variable.envKey} has conflicting inputs`, "input_collision");
    }
    byEnv.set(variable.envKey, { kind: "variable", value: variable.value });
  }
  return { secrets: resolvedSecrets, variables };
}

function serializeOpaque(ciphertext: OpaqueCiphertext): string {
  return JSON.stringify(ciphertext);
}

function parseOpaque(serialized: string): OpaqueCiphertext {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new RunRuntimeError("run server password is malformed");
  }
  const record = value as Partial<OpaqueCiphertext> | null;
  const keys: Array<keyof OpaqueCiphertext> = [
    "ciphertext",
    "iv",
    "authTag",
    "wrappedDek",
    "wrapIv",
    "wrapAuthTag",
    "keyId",
  ];
  if (!record || keys.some((key) => typeof record[key] !== "string" || record[key] === "")) {
    throw new RunRuntimeError("run server password is malformed");
  }
  return record as OpaqueCiphertext;
}

export function decryptRunServerPassword(input: {
  orgId: string;
  runId: string;
  encrypted: string;
  masterKey: Buffer;
}): string {
  return decryptOpaqueValue(
    {
      orgId: input.orgId,
      purpose: "opencode-server-password",
      subjectId: input.runId,
      ...parseOpaque(input.encrypted),
    },
    input.masterKey,
  );
}

async function loadRunRow(database: Db, orgId: string, runId: string): Promise<RunRow | null> {
  const rows = await database
    .select()
    .from(schema.skillRuns)
    .where(and(eq(schema.skillRuns.orgId, orgId), eq(schema.skillRuns.id, runId)));
  return rows[0] ?? null;
}

async function loadAttachments(database: Db, orgId: string, runId: string): Promise<AttachmentRow[]> {
  return database
    .select()
    .from(schema.skillRunAttachments)
    .where(and(eq(schema.skillRunAttachments.orgId, orgId), eq(schema.skillRunAttachments.runId, runId)));
}

async function loadArtifacts(database: Db, orgId: string, runId: string): Promise<ArtifactRow[]> {
  return database
    .select()
    .from(schema.skillRunArtifacts)
    .where(and(eq(schema.skillRunArtifacts.orgId, orgId), eq(schema.skillRunArtifacts.runId, runId)))
    .orderBy(asc(schema.skillRunArtifacts.path));
}

async function loadSkillSlug(database: Db, orgId: string, skillId: string): Promise<string> {
  const rows = await database
    .select({ id: schema.skills.id, slug: schema.skills.slug })
    .from(schema.skills)
    .where(and(eq(schema.skills.orgId, orgId), eq(schema.skills.id, skillId)));
  return rows.find((row) => row.id === skillId)?.slug ?? "?";
}

function toAttachmentRow(row: AttachmentRow): SkillRunAttachmentRow {
  return { id: row.id, file_name: row.fileName, content_type: row.contentType, byte_size: row.byteSize };
}

function toArtifactRow(row: ArtifactRow): SkillRunArtifactRow {
  return {
    id: row.id,
    file_name: row.fileName,
    path: row.path,
    content_type: row.contentType,
    byte_size: row.byteSize,
    url: row.url,
    expires_at: row.expiresAt?.toISOString() ?? null,
    published_at: row.publishedAt.toISOString(),
  };
}

function toRunRow(row: RunRow, skillSlug: string, artifactsCount: number): SkillRunRow {
  return {
    id: row.id,
    skill_slug: skillSlug,
    skill_version: row.skillVersion,
    model: row.model,
    prompt_excerpt: promptExcerpt(row.prompt),
    status: row.status as SkillRunStatus,
    status_detail: row.userMessage,
    phase: row.phase,
    error_code: row.errorCode,
    error_message: row.userMessage,
    run_config_id: row.runConfigId,
    run_config_name_snapshot: row.runConfigNameSnapshot,
    artifacts_count: artifactsCount,
    created_at: row.createdAt.toISOString(),
    last_active_at: row.lastActiveAt?.toISOString() ?? null,
  };
}

async function loadInputSnapshot(database: Db, row: RunRow): Promise<RunInputSnapshot> {
  const [skillRows, secretRows, variableRows] = await Promise.all([
    database
      .select({
        skillId: schema.skillRunSkills.skillId,
        skillVersionId: schema.skillRunSkills.skillVersionId,
        isRoot: schema.skillRunSkills.isRoot,
        mountOrder: schema.skillRunSkills.mountOrder,
        slug: schema.skills.slug,
        version: schema.skillVersions.version,
      })
      .from(schema.skillRunSkills)
      .innerJoin(
        schema.skills,
        and(
          eq(schema.skills.orgId, schema.skillRunSkills.orgId),
          eq(schema.skills.id, schema.skillRunSkills.skillId),
        ),
      )
      .innerJoin(
        schema.skillVersions,
        and(
          eq(schema.skillVersions.orgId, schema.skillRunSkills.orgId),
          eq(schema.skillVersions.id, schema.skillRunSkills.skillVersionId),
        ),
      )
      .where(
        and(eq(schema.skillRunSkills.orgId, row.orgId), eq(schema.skillRunSkills.runId, row.id)),
      )
      .orderBy(asc(schema.skillRunSkills.mountOrder)),
    database
      .select()
      .from(schema.skillRunSecretInputs)
      .where(
        and(eq(schema.skillRunSecretInputs.orgId, row.orgId), eq(schema.skillRunSecretInputs.runId, row.id)),
      ),
    database
      .select()
      .from(schema.skillRunVariableInputs)
      .where(
        and(eq(schema.skillRunVariableInputs.orgId, row.orgId), eq(schema.skillRunVariableInputs.runId, row.id)),
      ),
  ]);
  const dependencyRows = skillRows.length
    ? await database
        .select({
          skillVersionId: schema.skillVersionDependencies.skillVersionId,
          dependsOnSkillId: schema.skillVersionDependencies.dependsOnSkillId,
          dependsOnSlug: schema.skillVersionDependencies.dependsOnSlug,
        })
        .from(schema.skillVersionDependencies)
        .where(
          and(
            eq(schema.skillVersionDependencies.orgId, row.orgId),
            inArray(
              schema.skillVersionDependencies.skillVersionId,
              skillRows.map((skill) => skill.skillVersionId),
            ),
          ),
        )
    : [];
  const slugBySkill = new Map(skillRows.map((skill) => [skill.skillId, skill.slug]));
  const skillById = new Map(skillRows.map((skill) => [skill.skillId, skill]));
  const edgesByVersion = new Map<string, typeof dependencyRows>();
  for (const edge of dependencyRows) {
    const edges = edgesByVersion.get(edge.skillVersionId) ?? [];
    edges.push(edge);
    edgesByVersion.set(edge.skillVersionId, edges);
  }
  for (const edges of edgesByVersion.values()) {
    edges.sort((left, right) => left.dependsOnSlug.localeCompare(right.dependsOnSlug));
  }
  const topology = new Map<string, { depth: number; via: string | null }>();
  const visited = new Set<string>();
  const visit = (skillId: string, depth: number, via: string | null): void => {
    if (visited.has(skillId)) return;
    const skill = skillById.get(skillId);
    if (!skill) return;
    visited.add(skillId);
    topology.set(skillId, { depth, via });
    for (const edge of edgesByVersion.get(skill.skillVersionId) ?? []) {
      if (edge.dependsOnSkillId) visit(edge.dependsOnSkillId, depth + 1, skill.slug);
    }
  };
  const rootSkill = skillRows.find((skill) => skill.isRoot);
  if (rootSkill) visit(rootSkill.skillId, 0, null);
  const skills: RunDependency[] = skillRows.map((skill) => {
    const relation = topology.get(skill.skillId);
    return {
      skill_id: skill.skillId,
      skill_version_id: skill.skillVersionId,
      slug: skill.slug,
      version: skill.version,
      root: skill.isRoot,
      depth: relation?.depth ?? (skill.isRoot ? 0 : 1),
      via: relation?.via ?? (skill.isRoot ? null : rootSkill?.slug ?? null),
    };
  });
  const secrets: RunSecretInputSnapshot[] = secretRows.map((secret) => ({
    provenance: secret.provenance,
    skill_id: secret.skillId,
    skill_slug: secret.skillId ? slugBySkill.get(secret.skillId) ?? null : null,
    slot_id: secret.slotId,
    env_key: secret.envKey,
    required: secret.required,
    secret_id: secret.secretId,
    secret_version: secret.secretVersion,
    secret_name: secret.secretNameSnapshot,
  }));
  const variables: RunVariableInputSnapshot[] = variableRows.map((variable) => ({
    skill_id: variable.skillId,
    skill_slug: slugBySkill.get(variable.skillId) ?? "unknown",
    env_key: variable.envKey,
    value: variable.value,
  }));
  return { skills, secrets, variables };
}

async function toDetail(
  database: Db,
  row: RunRow,
  skillSlug: string,
  attachments: AttachmentRow[],
  artifacts: ArtifactRow[],
): Promise<SkillRunDetail> {
  return {
    ...toRunRow(row, skillSlug, artifacts.length),
    prompt: row.prompt,
    transcript: (row.transcript ?? []) as RunChatHistoryItem[],
    warnings: row.warnings ?? [],
    transcript_event_sequence: row.transcriptEventSequence,
    attachments: attachments.map(toAttachmentRow),
    artifacts: artifacts.map(toArtifactRow),
    input_snapshot: await loadInputSnapshot(database, row),
  };
}

async function createRunInTransaction(input: {
  actor: ActorContext;
  orgId: string;
  slug: string;
  skillVersionId: string;
  prompt: string;
  model: string;
  inputs: RunInputSelection;
  runConfigId?: string | null;
  idempotencyKey: string;
  attachments: CreateRunAttachment[];
  modelEnvKeys: string[];
  ctx: RunControlContext;
  database: Db;
}): Promise<SkillRunDetail> {
  const rootRows = await input.database
    .select({ id: schema.skills.id })
    .from(schema.skills)
    .where(and(eq(schema.skills.orgId, input.orgId), eq(schema.skills.slug, input.slug)));
  const rootSkillId = rootRows[0]?.id;
  if (!rootSkillId) throw new RunValidationError("skill not found", "skill_not_found");
  const existingRows = await input.database
    .select()
    .from(schema.skillRuns)
    .where(
      and(
        eq(schema.skillRuns.orgId, input.orgId),
        eq(schema.skillRuns.creatorId, input.actor.id),
        eq(schema.skillRuns.skillId, rootSkillId),
        eq(schema.skillRuns.idempotencyKey, input.idempotencyKey),
      ),
    );
  const payloadHash = hashRunPayload({
    slug: input.slug,
    skillVersionId: input.skillVersionId,
    prompt: input.prompt,
    model: input.model,
    inputs: {
      secrets: [...input.inputs.secrets].sort((a, b) =>
        `${a.skill_id}:${a.slot_id}`.localeCompare(`${b.skill_id}:${b.slot_id}`),
      ),
      variables: [...input.inputs.variables].sort((a, b) =>
        `${a.skill_id}:${a.env_key}`.localeCompare(`${b.skill_id}:${b.env_key}`),
      ),
    },
    runConfigId: input.runConfigId ?? null,
    attachments: [...input.attachments]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map(({ id, fileName, contentType, byteSize }) => ({ id, fileName, contentType, byteSize })),
  });
  const existing = existingRows[0];
  if (existing) {
    if (existing.payloadHash !== payloadHash) {
      throw new RunBusyError("this idempotency key was already used with a different payload", "idempotency_conflict");
    }
    const [attachments, artifacts, slug] = await Promise.all([
      loadAttachments(input.database, input.orgId, existing.id),
      loadArtifacts(input.database, input.orgId, existing.id),
      loadSkillSlug(input.database, input.orgId, existing.skillId),
    ]);
    return toDetail(input.database, existing, slug, attachments, artifacts);
  }

  const closure = await resolveRunDependencyClosure({
    actor: input.actor,
    orgId: input.orgId,
    slug: input.slug,
    skillVersionId: input.skillVersionId,
    database: input.database,
  });
  const root = closure[0]!;
  const lockedSkills = await input.database
    .select({ id: schema.skills.id, currentVersionId: schema.skills.currentVersionId, archivedAt: schema.skills.archivedAt })
    .from(schema.skills)
    .where(
      and(
        eq(schema.skills.orgId, input.orgId),
        inArray(schema.skills.id, closure.map((skill) => skill.skill_id)),
      ),
    )
    .for("share");
  const lockedById = new Map(lockedSkills.map((skill) => [skill.id, skill]));
  if (
    closure.some((skill) => {
      const locked = lockedById.get(skill.skill_id);
      return !locked || locked.archivedAt !== null || locked.currentVersionId !== skill.skill_version_id;
    })
  ) {
    throw new RunValidationError("the skill dependency graph changed during launch", "stale_skill_version");
  }
  const declarations = await loadRunDeclarations({
    actor: input.actor,
    orgId: input.orgId,
    closure,
    database: input.database,
  });
  const activated = await getActivatedModelSets({
    database: input.database,
    orgId: input.orgId,
    userId: input.actor.id,
  });
  if (!activated.personal.includes(input.model) && !activated.org.includes(input.model)) {
    throw new RunValidationError("the selected model is not activated", "model_not_activated");
  }
  const resolvedInputs = await validateRunInputSelection({
    actor: input.actor,
    orgId: input.orgId,
    model: input.model,
    modelEnvKeys: input.modelEnvKeys,
    selection: input.inputs,
    declarations,
    database: input.database,
  });

  let configNameSnapshot: string | null = null;
  if (input.runConfigId) {
    const configs = await input.database
      .select()
      .from(schema.skillRunConfigs)
      .where(
        and(
          eq(schema.skillRunConfigs.orgId, input.orgId),
          eq(schema.skillRunConfigs.id, input.runConfigId),
          eq(schema.skillRunConfigs.creatorId, input.actor.id),
          eq(schema.skillRunConfigs.skillId, root.skill_id),
        ),
      );
    const config = configs[0];
    if (!config) throw new RunValidationError("run configuration not found", "configuration_not_found");
    configNameSnapshot = config.name;
  }

  let artifactsEnabled = false;
  try {
    artifactsEnabled =
      (await resolveProviderSecretPin({
        actor: input.actor,
        orgId: input.orgId,
        provider: "vanish",
        database: input.database,
      })) !== null;
  } catch {
    artifactsEnabled = false;
  }

  const runId = randomUUID();
  const serverPassword = randomBytes(32).toString("base64url");
  const serverPasswordEnc = serializeOpaque(
    encryptOpaqueValue(
      {
        orgId: input.orgId,
        purpose: "opencode-server-password",
        subjectId: runId,
        value: serverPassword,
      },
      input.ctx.masterKey,
    ),
  );
  const inserted = await input.database
    .insert(schema.skillRuns)
    .values({
      id: runId,
      orgId: input.orgId,
      skillId: root.skill_id,
      creatorId: input.actor.id,
      skillVersionId: root.skill_version_id,
      skillVersion: root.version,
      runConfigId: input.runConfigId ?? null,
      runConfigNameSnapshot: configNameSnapshot,
      idempotencyKey: input.idempotencyKey,
      payloadHash,
      model: input.model,
      prompt: input.prompt,
      status: "queued",
      phase: "queued",
      sandboxName: sandboxNameForRun(input.orgId, runId),
      goldenSnapshotId: input.ctx.goldenSnapshotId,
      opencodeVersion: input.ctx.opencodeVersion,
      serverPasswordEnc,
      timeoutMs: input.ctx.timeoutMs,
    })
    .returning();
  const row = inserted[0];
  if (!row) throw new Error("run insert returned no row");

  await input.database.insert(schema.skillRunSkills).values(
    closure.map((skill) => ({
      orgId: input.orgId,
      runId,
      skillId: skill.skill_id,
      skillVersionId: skill.skill_version_id,
      isRoot: skill.root,
      mountOrder: skill.mountOrder,
    })),
  );
  await input.database.insert(schema.skillRunSecretInputs).values([
    ...resolvedInputs.secrets.map((secret) => ({
        orgId: input.orgId,
        runId,
        skillId: secret.skillId,
        slotId: secret.slotId,
        sourceKey: secret.sourceKey,
        envKey: secret.envKey,
        secretId: secret.pin.secretId,
        secretVersion: secret.pin.version,
        secretNameSnapshot: secret.pin.name,
        provenance: secret.provenance,
        required: secret.required,
      })),
    {
      orgId: input.orgId,
      runId,
      skillId: null,
      slotId: null,
      sourceKey: "opencode-server-password",
      envKey: "OPENCODE_SERVER_PASSWORD",
      secretId: null,
      secretVersion: null,
      secretNameSnapshot: null,
      provenance: "runtime" as const,
      required: true,
    },
  ]);
  if (resolvedInputs.variables.length > 0) {
    await input.database.insert(schema.skillRunVariableInputs).values(
      resolvedInputs.variables.map((variable) => ({
        orgId: input.orgId,
        runId,
        skillId: variable.skillId,
        envKey: variable.envKey,
        value: variable.value,
      })),
    );
  }
  if (input.attachments.length > 0) {
    await input.database.insert(schema.skillRunAttachments).values(
      input.attachments.map((attachment) => ({
        id: attachment.id,
        orgId: input.orgId,
        runId,
        fileName: attachment.fileName,
        contentType: attachment.contentType,
        byteSize: attachment.byteSize,
        storageKey: attachment.storageKey,
      })),
    );
  }

  const composedPrompt = composeRunPrompt({
    prompt: input.prompt,
    skillSlug: root.slug,
    attachmentNames: input.attachments.map((attachment) => attachment.fileName),
    artifactsEnabled,
  });
  await input.database.insert(schema.skillRunPrompts).values({
    orgId: input.orgId,
    runId,
    ordinal: 0,
    kind: "initial",
    idempotencyKey: `initial:${input.idempotencyKey}`,
    payloadHash: hashRunPayload({ prompt: composedPrompt }),
    messageId: deterministicRunMessageId(runId, 0),
    prompt: composedPrompt,
    status: "queued",
  });
  await input.database.insert(schema.skillRunJobs).values({
    orgId: input.orgId,
    runId,
    creatorId: input.actor.id,
    status: "queued",
    phase: "queued",
  });
  if (input.runConfigId) {
    await input.database
      .update(schema.skillRunConfigs)
      .set({ lastUsedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(schema.skillRunConfigs.orgId, input.orgId),
          eq(schema.skillRunConfigs.id, input.runConfigId),
          eq(schema.skillRunConfigs.creatorId, input.actor.id),
        ),
      );
  }
  await input.database.insert(schema.auditLog).values({
    orgId: input.orgId,
    actorId: input.actor.id,
    action: "skill.run.queued",
    targetType: "skill",
    targetId: root.skill_id,
    metadata: {
      slug: root.slug,
      run_id: runId,
      model: input.model,
      version: root.version,
      dependency_count: closure.length - 1,
      secret_count: resolvedInputs.secrets.length,
      variable_count: resolvedInputs.variables.length,
    },
  });
  const attachments = await loadAttachments(input.database, input.orgId, runId);
  return toDetail(input.database, row, root.slug, attachments, []);
}

/**
 * Create one immutable run snapshot and enqueue both its orchestration job and initial prompt.
 * Catalog lookup occurs before the transaction; every operation inside the transaction is DB-only.
 */
export async function createRun(input: {
  actor: ActorContext;
  orgId: string;
  slug: string;
  skillVersionId: string;
  prompt: string;
  model: string;
  inputs: RunInputSelection;
  runConfigId?: string | null;
  idempotencyKey: string;
  attachments: CreateRunAttachment[];
  ctx: RunControlContext;
  database?: Db;
}): Promise<SkillRunDetail> {
  const database = input.database ?? db;
  await assertMember(database, input.actor, input.orgId);
  if (input.ctx.runtimeAvailable === false || !input.ctx.goldenSnapshotId) {
    throw new RunValidationError(
      input.ctx.runtimeMessage ?? "RunSkill is not configured for this workspace",
      "runtime_unavailable",
    );
  }
  const model = await input.ctx.resolveModelKeys(input.model);
  if (!model || model.envKeys.length === 0) {
    throw new RunValidationError("the selected model is unavailable", "model_unavailable");
  }
  const execute = (transaction: Db) =>
    createRunInTransaction({ ...input, modelEnvKeys: model.envKeys, database: transaction });
  try {
    return await database.transaction(async (transaction) => execute(transaction as unknown as Db));
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    // A concurrent retry may have won the idempotency unique constraint. Re-run the normal lookup
    // path in a fresh transaction; it verifies the payload hash before returning the existing run.
    return database.transaction(async (transaction) => execute(transaction as unknown as Db));
  }
}

export async function listRuns(input: {
  actor: ActorContext;
  orgId: string;
  slug: string;
  database?: Db;
}): Promise<SkillRunRow[]> {
  const database = input.database ?? db;
  await assertMember(database, input.actor, input.orgId);
  const skills = await database
    .select({ id: schema.skills.id, scope: schema.skills.scope, creatorId: schema.skills.creatorId })
    .from(schema.skills)
    .where(and(eq(schema.skills.orgId, input.orgId), eq(schema.skills.slug, input.slug)));
  const skill = skills[0];
  if (!skill || !canAccessSkill(input.actor.id, skill)) throw new RunValidationError("skill not found", "skill_not_found");
  const rows = await database
    .select()
    .from(schema.skillRuns)
    .where(
      and(
        eq(schema.skillRuns.orgId, input.orgId),
        eq(schema.skillRuns.skillId, skill.id),
        eq(schema.skillRuns.creatorId, input.actor.id),
      ),
    )
    .orderBy(desc(schema.skillRuns.createdAt));
  const artifacts = rows.length
    ? await database
        .select({ runId: schema.skillRunArtifacts.runId })
        .from(schema.skillRunArtifacts)
        .where(
          and(
            eq(schema.skillRunArtifacts.orgId, input.orgId),
            inArray(schema.skillRunArtifacts.runId, rows.map((row) => row.id)),
          ),
        )
    : [];
  const counts = new Map<string, number>();
  for (const artifact of artifacts) counts.set(artifact.runId, (counts.get(artifact.runId) ?? 0) + 1);
  return rows.map((row) => toRunRow(row, input.slug, counts.get(row.id) ?? 0));
}

export async function getRun(input: {
  actor: ActorContext;
  orgId: string;
  runId: string;
  database?: Db;
}): Promise<SkillRunDetail> {
  const database = input.database ?? db;
  await assertMember(database, input.actor, input.orgId);
  const row = await loadRunRow(database, input.orgId, input.runId);
  if (!row || !canAccessRun(input.actor.id, row)) {
    throw new RunValidationError("run not found", "run_not_found");
  }
  const [slug, attachments, artifacts] = await Promise.all([
    loadSkillSlug(database, input.orgId, row.skillId),
    loadAttachments(database, input.orgId, row.id),
    loadArtifacts(database, input.orgId, row.id),
  ]);
  return toDetail(database, row, slug, attachments, artifacts);
}

export async function getRunAttachment(input: {
  actor: ActorContext;
  orgId: string;
  runId: string;
  attachmentId: string;
  database?: Db;
}): Promise<{ fileName: string; contentType: string; storageKey: string }> {
  const database = input.database ?? db;
  await assertMember(database, input.actor, input.orgId);
  const row = await loadRunRow(database, input.orgId, input.runId);
  if (!row || !canAccessRun(input.actor.id, row)) {
    throw new RunValidationError("run not found", "run_not_found");
  }
  const attachments = await loadAttachments(database, input.orgId, row.id);
  const attachment = attachments.find((candidate) => candidate.id === input.attachmentId);
  if (!attachment) throw new RunValidationError("attachment not found", "attachment_not_found");
  return { fileName: attachment.fileName, contentType: attachment.contentType, storageKey: attachment.storageKey };
}

function safeAttachmentName(fileName: string): string {
  const basename = fileName.split(/[\\/]/).at(-1) ?? "";
  const normalized = basename
    .normalize("NFKC")
    .replace(/[\\/\0-\x1f\x7f]+/g, "-")
    .replace(/^\.+/, "")
    .trim();
  return normalized || "attachment";
}

export function attachmentWorkspacePath(attachment: Pick<CreateRunAttachment, "id" | "fileName">): string {
  return `${attachment.id}-${safeAttachmentName(attachment.fileName)}`;
}

export async function buildSkillBundle(
  slug: string,
  version: string,
  storagePath: string,
  fetchArchive: SkillArchiveFetcher,
): Promise<SkillBundle> {
  const { toTar, inspectTar, extractArchiveEntryBuffers } = await import("@companion/skills");
  const archive = await fetchArchive(storagePath);
  const tar = toTar(archive);
  const finding = await inspectTar(tar);
  if (finding.violations.length > 0 || finding.oversize) {
    throw new RunRuntimeError(`${slug}@${version}: archive failed safety checks`, {
      detail: finding.violations.slice(0, 3).join("\n") || "size limits exceeded",
    });
  }
  const extracted = await extractArchiveEntryBuffers(tar);
  if (extracted.violations.length > 0 || extracted.oversize) {
    throw new RunRuntimeError(`${slug}@${version}: archive failed safety checks`, {
      detail: extracted.violations.slice(0, 3).join("\n") || "size limits exceeded",
    });
  }
  const skillMdPath = extracted.files.find((file) => file.path.split("/").pop() === "SKILL.md")?.path ?? "SKILL.md";
  const root = skillMdPath.includes("/") ? skillMdPath.slice(0, skillMdPath.lastIndexOf("/") + 1) : "";
  return {
    slug,
    version,
    files: extracted.files
      .filter((file) => (root ? file.path.startsWith(root) : true))
      .map((file) => ({
        path: root ? file.path.slice(root.length) : file.path,
        data: file.data,
        executable: file.executable,
      })),
  };
}

export interface RunExecutionPlan {
  row: RunRow;
  creator: ActorContext;
  skills: Array<{ slug: string; version: string; storagePath: string }>;
  attachments: CreateRunAttachment[];
  env: Record<string, string>;
  injectedLiterals: string[];
  serverPassword: string;
}

/**
 * Revalidate every pinned vault reference immediately before sandbox injection, then decrypt into
 * an ephemeral map. The caller must clear `env` and `injectedLiterals` after creating its redactor.
 */
export async function loadRunExecutionPlan(input: {
  actor: ActorContext;
  orgId: string;
  runId: string;
  masterKey: Buffer;
  database?: Db;
}): Promise<RunExecutionPlan> {
  const database = input.database ?? db;
  await assertMember(database, input.actor, input.orgId);
  const row = await loadRunRow(database, input.orgId, input.runId);
  if (!row || row.creatorId !== input.actor.id) {
    throw new RunValidationError("run not found", "run_not_found");
  }
  if (["frozen", "error", "canceled"].includes(row.status)) {
    throw new RunBusyError("this run is terminal", "run_terminal");
  }
  const [skills, attachments, secretInputs, variables] = await Promise.all([
    database
      .select({
        slug: schema.skills.slug,
        version: schema.skillVersions.version,
        storagePath: schema.skillVersions.storagePath,
        mountOrder: schema.skillRunSkills.mountOrder,
      })
      .from(schema.skillRunSkills)
      .innerJoin(
        schema.skills,
        and(eq(schema.skills.orgId, schema.skillRunSkills.orgId), eq(schema.skills.id, schema.skillRunSkills.skillId)),
      )
      .innerJoin(
        schema.skillVersions,
        and(
          eq(schema.skillVersions.orgId, schema.skillRunSkills.orgId),
          eq(schema.skillVersions.id, schema.skillRunSkills.skillVersionId),
        ),
      )
      .where(and(eq(schema.skillRunSkills.orgId, input.orgId), eq(schema.skillRunSkills.runId, input.runId)))
      .orderBy(asc(schema.skillRunSkills.mountOrder)),
    loadAttachments(database, input.orgId, input.runId),
    database
      .select()
      .from(schema.skillRunSecretInputs)
      .where(
        and(
          eq(schema.skillRunSecretInputs.orgId, input.orgId),
          eq(schema.skillRunSecretInputs.runId, input.runId),
        ),
      ),
    database
      .select()
      .from(schema.skillRunVariableInputs)
      .where(
        and(
          eq(schema.skillRunVariableInputs.orgId, input.orgId),
          eq(schema.skillRunVariableInputs.runId, input.runId),
        ),
      ),
  ]);

  const env: Record<string, string> = {};
  const envSources = new Map<
    string,
    { kind: "variable"; value: string } | { kind: "secret"; secretId: string; version: number }
  >();
  for (const variable of variables) {
    if (variable.envKey.startsWith(RUN_RESERVED_ENV_PREFIX)) {
      throw new RunRuntimeError("run variable snapshot contains a reserved environment key");
    }
    const existing = envSources.get(variable.envKey);
    if (existing && (existing.kind !== "variable" || existing.value !== variable.value)) {
      throw new RunRuntimeError(`run input snapshot has a collision for ${variable.envKey}`);
    }
    envSources.set(variable.envKey, { kind: "variable", value: variable.value });
    env[variable.envKey] = variable.value;
  }
  const injectedLiterals: string[] = [];
  for (const secret of secretInputs) {
    if (secret.provenance === "runtime") continue;
    if (!secret.secretId || !secret.secretVersion) {
      throw new RunRuntimeError("run secret snapshot is malformed");
    }
    if (secret.envKey.startsWith(RUN_RESERVED_ENV_PREFIX)) {
      throw new RunRuntimeError("run secret snapshot contains a reserved environment key");
    }
    const existing = envSources.get(secret.envKey);
    if (
      existing &&
      (existing.kind !== "secret" ||
        existing.secretId !== secret.secretId ||
        existing.version !== secret.secretVersion)
    ) {
      throw new RunRuntimeError(`run input snapshot has a collision for ${secret.envKey}`);
    }
    if (existing) continue;
    try {
      const opened = await decryptPinnedSecret({
        actor: input.actor,
        orgId: input.orgId,
        secretId: secret.secretId,
        version: secret.secretVersion,
        masterKey: input.masterKey,
        database,
      });
      env[secret.envKey] = opened.value;
      envSources.set(secret.envKey, {
        kind: "secret",
        secretId: secret.secretId,
        version: secret.secretVersion,
      });
      injectedLiterals.push(opened.value);
    } catch {
      throw new RunValidationError("secret unavailable", "secret_unavailable");
    }
  }
  if (!row.serverPasswordEnc) throw new RunRuntimeError("run has no server password");
  const serverPassword = decryptRunServerPassword({
    orgId: input.orgId,
    runId: row.id,
    encrypted: row.serverPasswordEnc,
    masterKey: input.masterKey,
  });
  env.OPENCODE_SERVER_USERNAME = OPENCODE_SERVER_USERNAME;
  env.OPENCODE_SERVER_PASSWORD = serverPassword;
  injectedLiterals.push(serverPassword);
  return {
    row,
    creator: input.actor,
    skills,
    attachments: attachments.map((attachment) => ({
      id: attachment.id,
      fileName: attachment.fileName,
      contentType: attachment.contentType,
      byteSize: attachment.byteSize,
      storageKey: attachment.storageKey,
    })),
    env,
    injectedLiterals,
    serverPassword,
  };
}

/** Fetch archive and attachment bytes outside any DB transaction. */
export async function materializeRunWorkspace(input: {
  plan: RunExecutionPlan;
  fetchArchive: SkillArchiveFetcher;
  fetchObject: (storageKey: string) => Promise<Buffer>;
}): Promise<RunWorkspaceFiles> {
  const skills: SkillBundle[] = [];
  for (const skill of input.plan.skills) {
    skills.push(await buildSkillBundle(skill.slug, skill.version, skill.storagePath, input.fetchArchive));
  }
  const attachments: RunWorkspaceFiles["attachments"] = [];
  for (const attachment of input.plan.attachments) {
    attachments.push({
      path: attachmentWorkspacePath(attachment),
      data: await input.fetchObject(attachment.storageKey),
    });
  }
  return { opencodeJson: buildOpencodeJson({ model: input.plan.row.model }), skills, attachments };
}

/** Best-effort, idempotent teardown shared by the worker and terminal sweeper. */
export async function teardownSandbox(
  runtime: RunSandboxRuntime,
  ref: Parameters<RunSandboxRuntime["stop"]>[0],
): Promise<boolean> {
  try {
    await runtime.stop(ref);
  } catch {
    // A stop failure does not excuse the destroy attempt.
  }
  try {
    await runtime.destroy(ref);
    return true;
  } catch {
    return false;
  }
}
