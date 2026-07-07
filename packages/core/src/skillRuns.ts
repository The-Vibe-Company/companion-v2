import { randomBytes } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import { db, schema, type Db } from "@companion/db";
import type {
  RunChatEvent,
  RunChatHistoryItem,
  SkillRunArtifactRow,
  SkillRunAttachmentRow,
  SkillRunDetail,
  SkillRunRow,
  SkillRunStatus,
} from "@companion/contracts";
import { canAccessRun, canAccessSkill } from "./authz";
import { openSecret, sealSecret, secretAad } from "./secretbox";
import {
  RunRuntimeError,
  OPENCODE_SERVER_USERNAME,
  type RunSandboxRuntime,
  type SandboxRef,
  type ServeEnv,
  type SkillArchiveFetcher,
  type SkillBundle,
} from "./runRuntime";
import { assertMember, type ActorContext } from "./services";
import { getDecryptedProviderKey } from "./providerConnections";
import { publishRunArtifact, vanishBlockedExtension, VanishError } from "./vanish";

/**
 * Skill run services: one-shot sandboxed sessions launched from a skill's page. Every function
 * keeps the house shape `fn({ actor, orgId, ..., database? })` and its OWN queries (never shared
 * with the skill list paths — the hand-rolled fakeDbs in the test suites depend on that isolation).
 *
 * TRANSACTION RULE: `withTenantContext` opens a Postgres transaction, so no sandbox/network call
 * ever runs inside one. The launch job interleaves short tenant transactions (status persistence)
 * with long, un-transacted runtime calls.
 *
 * LIFECYCLE (no state machine): `starting → running → frozen | error`, with `status_detail` as a
 * free-text launch step / error message. A FRESH sandbox is forked per run; there is no wake —
 * retry means a new run. The recorder (same in-process job) snapshots the transcript on every
 * `session.idle` and freezes the run after `timeoutMs` of inactivity.
 */

/* ------------------------------------ control context ----------------------------------- */

/** Opens a short tenant transaction (`withTenantContext` in production; a passthrough in tests). */
export type TenantRunner = <T>(input: { orgId: string; userId: string }, fn: (database: Db) => Promise<T>) => Promise<T>;

/** The chat target the seam functions operate on (sandbox domain + basic-auth password). */
export interface RunChatTarget {
  domain: string;
  password: string;
}

/** Everything the runtime-facing services need beyond the DB; composed once in apps/api. */
export interface RunControlContext {
  runtime: RunSandboxRuntime;
  /** Usually `withTenantContext`; injectable so unit tests can run against a fake database. */
  runTenant: TenantRunner;
  /** Fetches a stored skill archive by its storage path (S3 in production). */
  fetchArchive: SkillArchiveFetcher;
  /** Fetches an arbitrary stored object by key (run attachments). */
  fetchObject: (key: string) => Promise<Buffer>;
  /** Parsed COMPANION_SECRETS_KEY (see secretbox). */
  secretsKey: Buffer;
  goldenSnapshotId: string | null;
  opencodeVersion: string | null;
  region: string;
  /** Sandbox lifetime AND the recorder's inactivity freeze window (COMPANION_SANDBOX_TIMEOUT_MS). */
  timeoutMs: number;
  /** How often the recorder checks for inactivity; tests shrink it. Default 15s. */
  activityPollMs?: number;
  /** Resolve a `provider/model` ref to the provider's API-key env var NAME(s); null = unknown model. */
  resolveModelKeys: (model: string) => Promise<{ envKeys: string[] } | null>;
  /** Vanish upload seam (stubbed in tests). */
  publishArtifact: typeof publishRunArtifact;
  /** OpenCode chat seam (stubbed in tests; wraps @companion/sandbox in production). */
  chat: {
    createSession(target: RunChatTarget, title?: string): Promise<{ id: string; title: string }>;
    sendPrompt(target: RunChatTarget, sessionId: string, text: string): Promise<void>;
    loadItems(target: RunChatTarget, sessionId: string): Promise<RunChatHistoryItem[]>;
    streamEvents(target: RunChatTarget, sessionId: string, signal: AbortSignal): AsyncIterable<RunChatEvent>;
  };
}

/** Validation failures the routes surface as 404/422s. */
export class RunValidationError extends Error {}
/** Wrong-state failures the routes surface as 409s (e.g. prompting a frozen run). */
export class RunBusyError extends Error {}

/* ------------------------------------ derivations --------------------------------------- */

type RunRow = typeof schema.skillRuns.$inferSelect;
type AttachmentRow = typeof schema.skillRunAttachments.$inferSelect;
type ArtifactRow = typeof schema.skillRunArtifacts.$inferSelect;

/** Deterministic per-run sandbox name (fresh sandbox per run — never reused). */
export function sandboxNameForRun(orgId: string, runId: string): string {
  const org8 = orgId.replace(/-/g, "").slice(0, 8);
  const run8 = runId.replace(/-/g, "").slice(0, 8);
  return `run-${org8}-${run8}`;
}

/** `opencode.json` — model pin + run permissions (file edits allowed: deliverables land in artifacts/). */
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

/**
 * The composed first prompt: the user's text plus a skill-usage nudge, the attachment listing, and
 * (when the launcher can publish artifacts) the artifacts instruction. No persona markdown — the
 * skill is auto-discovered from `.claude/skills/<slug>/`.
 */
export function composeRunPrompt(input: {
  prompt: string;
  skillSlug: string;
  attachmentNames: string[];
  artifactsEnabled: boolean;
}): string {
  const parts = [input.prompt.trim()];
  const notes = [`Use your installed "${input.skillSlug}" skill to handle this request.`];
  if (input.attachmentNames.length > 0) {
    notes.push(
      `The user attached ${input.attachmentNames.length === 1 ? "a file" : "files"} under ./attachments/: ${input.attachmentNames.join(", ")}.`,
    );
  }
  if (input.artifactsEnabled) {
    notes.push("Save any deliverable files into ./artifacts/ — they will be shared with the user as links.");
  }
  return `${parts.join("\n\n")}\n\n---\n${notes.join("\n")}\n`;
}

const PROMPT_EXCERPT_MAX = 140;

function promptExcerpt(prompt: string): string {
  const flat = prompt.replace(/\s+/g, " ").trim();
  return flat.length > PROMPT_EXCERPT_MAX ? `${flat.slice(0, PROMPT_EXCERPT_MAX)}…` : flat;
}

/** Cap the stored transcript at ~512 KB: blank the oldest tool outputs first, then drop oldest items. */
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

/* ------------------------------------ in-process activity + side events -------------------- */

/** Per-run activity bump hooks, registered by the live recorder (mono-process API assumption). */
const activityRegistry = new Map<string, () => void>();

/** Runs whose launch+record job is alive in THIS process (covers the whole `starting` phase too). */
const liveRunJobs = new Set<string>();

/** Refresh the recorder's inactivity clock for a run (called by the prompt route). No-op when dead. */
export function noteRunActivity(runId: string): void {
  activityRegistry.get(runId)?.();
}

/** True when the launch/record job for this run is alive in THIS process. */
export function runJobAlive(runId: string): boolean {
  return liveRunJobs.has(runId);
}

type SideEventListener = (event: RunChatEvent) => void;
const sideEventListeners = new Map<string, Set<SideEventListener>>();

/**
 * Recorder-side events (artifact publish failures) surfaced onto the live SSE stream. The recorder
 * and the SSE proxy are independent consumers of the sandbox stream, so this tiny in-process bus is
 * how recorder-only errors reach the browser.
 */
export function subscribeRunSideEvents(runId: string, listener: SideEventListener): () => void {
  const set = sideEventListeners.get(runId) ?? new Set();
  set.add(listener);
  sideEventListeners.set(runId, set);
  return () => {
    set.delete(listener);
    if (set.size === 0) sideEventListeners.delete(runId);
  };
}

function emitRunSideEvent(runId: string, event: RunChatEvent): void {
  for (const listener of sideEventListeners.get(runId) ?? []) {
    try {
      listener(event);
    } catch {
      /* listener errors never reach the recorder */
    }
  }
}

/* ------------------------------------ row mapping ----------------------------------------- */

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
    expires_at: row.expiresAt ? row.expiresAt.toISOString() : null,
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
    status_detail: row.statusDetail,
    artifacts_count: artifactsCount,
    created_at: row.createdAt.toISOString(),
    last_active_at: row.lastActiveAt ? row.lastActiveAt.toISOString() : null,
  };
}

function toDetail(
  row: RunRow,
  skillSlug: string,
  attachments: AttachmentRow[],
  artifacts: ArtifactRow[],
): SkillRunDetail {
  return {
    ...toRunRow(row, skillSlug, artifacts.length),
    prompt: row.prompt,
    transcript: (row.transcript ?? []) as RunChatHistoryItem[],
    attachments: attachments.map(toAttachmentRow),
    artifacts: artifacts.map(toArtifactRow),
  };
}

/* ------------------------------------ internal loads --------------------------------------- */

async function loadRunRow(database: Db, orgId: string, runId: string): Promise<RunRow | null> {
  const rows = await database
    .select()
    .from(schema.skillRuns)
    .where(and(eq(schema.skillRuns.orgId, orgId), eq(schema.skillRuns.id, runId)));
  return (Array.isArray(rows) ? (rows as RunRow[]) : [])[0] ?? null;
}

async function loadAttachments(database: Db, orgId: string, runId: string): Promise<AttachmentRow[]> {
  const rows = await database
    .select()
    .from(schema.skillRunAttachments)
    .where(and(eq(schema.skillRunAttachments.orgId, orgId), eq(schema.skillRunAttachments.runId, runId)));
  return Array.isArray(rows) ? (rows as AttachmentRow[]) : [];
}

async function loadArtifacts(database: Db, orgId: string, runId: string): Promise<ArtifactRow[]> {
  const rows = await database
    .select()
    .from(schema.skillRunArtifacts)
    .where(and(eq(schema.skillRunArtifacts.orgId, orgId), eq(schema.skillRunArtifacts.runId, runId)));
  const list = Array.isArray(rows) ? (rows as ArtifactRow[]) : [];
  return list.sort((a, b) => a.path.localeCompare(b.path));
}

interface RunSkillRow {
  id: string;
  slug: string;
  scope: "personal" | "org";
  creatorId: string;
  archivedAt: Date | null;
  currentVersion: string | null;
}

/**
 * Direct skill lookup (its OWN query, per the house rule — never shared with the skill list paths).
 * Visibility is re-applied post-query via `canAccessSkill`, matching the accessible-library
 * predicate: org skills for anyone, personal skills only for their owner.
 */
async function loadSkillBySlug(database: Db, orgId: string, slug: string): Promise<RunSkillRow | null> {
  const rows = await database
    .select({
      id: schema.skills.id,
      slug: schema.skills.slug,
      scope: schema.skills.scope,
      creatorId: schema.skills.creatorId,
      archivedAt: schema.skills.archivedAt,
      currentVersion: schema.skillVersions.version,
    })
    .from(schema.skills)
    .leftJoin(schema.skillVersions, eq(schema.skills.currentVersionId, schema.skillVersions.id))
    .where(and(eq(schema.skills.orgId, orgId), eq(schema.skills.slug, slug)));
  const list = Array.isArray(rows) ? (rows as RunSkillRow[]) : [];
  return list.find((r) => r.slug === slug) ?? list[0] ?? null;
}

async function loadSkillSlug(database: Db, orgId: string, skillId: string): Promise<string> {
  const rows = await database
    .select({ id: schema.skills.id, slug: schema.skills.slug })
    .from(schema.skills)
    .where(and(eq(schema.skills.orgId, orgId), eq(schema.skills.id, skillId)));
  const list = Array.isArray(rows) ? rows : [];
  return (list.find((r) => r.id === skillId)?.slug as string | undefined) ?? list[0]?.slug ?? "?";
}

function decryptServerPassword(orgId: string, row: RunRow, ctx: RunControlContext): string {
  const enc = row.serverPasswordEnc;
  if (!enc) throw new RunRuntimeError("run has no server password (corrupt row)");
  const [wrappedDek, ciphertext] = enc.split("|");
  if (!wrappedDek || !ciphertext) throw new RunRuntimeError("run server password is malformed");
  return openSecret({
    kek: ctx.secretsKey,
    sealed: { wrappedDek, ciphertext },
    aad: secretAad(orgId, row.id, "OPENCODE_SERVER_PASSWORD"),
  });
}

function buildServeEnv(serverPassword: string, secrets: Map<string, string>): ServeEnv {
  return {
    OPENCODE_SERVER_PASSWORD: serverPassword,
    OPENCODE_SERVER_USERNAME,
    ...Object.fromEntries(secrets),
  };
}

/**
 * Resolve the model provider's API key LIVE (never copied onto the run): the launcher's personal
 * connection wins, else the workspace-shared one (`getDecryptedProviderKey` implements the
 * fallback). Returns the env map to inject, or throws the designed error when no key exists.
 */
async function resolveProviderEnv(
  database: Db,
  orgId: string,
  creatorId: string,
  model: string,
  ctx: RunControlContext,
): Promise<Map<string, string>> {
  const resolved = await ctx.resolveModelKeys(model);
  if (!resolved) throw new RunValidationError(`model ${model} is not available (unknown or not tool-capable)`);
  const slash = model.indexOf("/");
  const provider = slash > 0 ? model.slice(0, slash) : "";
  const connection = provider
    ? await getDecryptedProviderKey({ database, orgId, userId: creatorId, provider, secretsKey: ctx.secretsKey })
    : null;
  if (!connection || !resolved.envKeys.includes(connection.keyName)) {
    const wanted = resolved.envKeys[0] ?? "the provider API key";
    throw new RunValidationError(
      `no API key is available for this model's provider — connect ${provider || "it"} in Settings → Model providers (${wanted})`,
    );
  }
  return new Map([[connection.keyName, connection.value]]);
}

/** Extract the single skill bundle from its stored archive, refusing unsafe archives. */
async function buildSkillBundle(
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
      detail: extracted.violations.slice(0, 3).join("\n"),
    });
  }
  // Strip the package root folder when present so SKILL.md lands at .claude/skills/<slug>/SKILL.md.
  const skillMdPath = extracted.files.find((f) => f.path.split("/").pop() === "SKILL.md")?.path ?? "SKILL.md";
  const root = skillMdPath.includes("/") ? skillMdPath.slice(0, skillMdPath.lastIndexOf("/") + 1) : "";
  return {
    slug,
    version,
    files: extracted.files
      .filter((f) => (root ? f.path.startsWith(root) : true))
      .map((f) => ({ path: root ? f.path.slice(root.length) : f.path, data: f.data, executable: f.executable })),
  };
}

/* ------------------------------------ createRun -------------------------------------------- */

export interface CreateRunAttachment {
  id: string;
  fileName: string;
  contentType: string;
  byteSize: number;
  storageKey: string;
}

/**
 * Validate + persist a new run (status `starting`). Any member may run any skill they can SEE
 * (personal-skill privacy re-applied via `canAccessSkill`). Fails at submit —
 * not 30 seconds later — when the skill has no published version or no provider key is available
 * for the chosen model. The caller kicks `launchAndRecordRun` after this returns.
 */
export async function createRun(input: {
  actor: ActorContext;
  orgId: string;
  slug: string;
  prompt: string;
  model: string;
  attachments: CreateRunAttachment[];
  ctx: RunControlContext;
  database?: Db;
}): Promise<SkillRunDetail> {
  const database = input.database ?? db;
  await assertMember(database, input.actor, input.orgId);

  const skill = await loadSkillBySlug(database, input.orgId, input.slug);
  if (!skill || skill.archivedAt) throw new RunValidationError("skill not found");
  if (!canAccessSkill(input.actor.id, { scope: skill.scope, creatorId: skill.creatorId })) {
    throw new RunValidationError("skill not found");
  }
  if (!skill.currentVersion) throw new RunValidationError(`skill ${input.slug} has no published version`);

  // Both validations up front: model exists in the catalog AND a decryptable key reaches it.
  await resolveProviderEnv(database, input.orgId, input.actor.id, input.model, input.ctx);

  const runId = crypto.randomUUID();
  const serverPassword = randomBytes(24).toString("base64url");
  const sealed = sealSecret({
    kek: input.ctx.secretsKey,
    plaintext: serverPassword,
    aad: secretAad(input.orgId, runId, "OPENCODE_SERVER_PASSWORD"),
  });

  const inserted = await database
    .insert(schema.skillRuns)
    .values({
      id: runId,
      orgId: input.orgId,
      skillId: skill.id,
      creatorId: input.actor.id,
      skillVersion: skill.currentVersion,
      model: input.model,
      prompt: input.prompt,
      status: "starting",
      statusDetail: "Queued",
      sandboxName: sandboxNameForRun(input.orgId, runId),
      goldenSnapshotId: input.ctx.goldenSnapshotId,
      opencodeVersion: input.ctx.opencodeVersion,
      serverPasswordEnc: `${sealed.wrappedDek}|${sealed.ciphertext}`,
      timeoutMs: input.ctx.timeoutMs,
    })
    .returning();
  const row = (Array.isArray(inserted) ? (inserted as RunRow[]) : [])[0];
  if (!row) throw new Error("run insert returned no row");

  if (input.attachments.length > 0) {
    await database.insert(schema.skillRunAttachments).values(
      input.attachments.map((a) => ({
        id: a.id,
        orgId: input.orgId,
        runId,
        fileName: a.fileName,
        contentType: a.contentType,
        byteSize: a.byteSize,
        storageKey: a.storageKey,
      })),
    );
  }

  await database.insert(schema.auditLog).values({
    orgId: input.orgId,
    actorId: input.actor.id,
    action: "skill.run",
    targetType: "skill",
    targetId: skill.id,
    metadata: { slug: input.slug, run_id: runId, model: input.model, version: skill.currentVersion },
  });

  const attachments = await loadAttachments(database, input.orgId, runId);
  return toDetail(row, input.slug, attachments, []);
}

/* ------------------------------------ launch + record --------------------------------------- */

/**
 * The background job: launch the sandbox, start the session, then record until freeze. Runs OUTSIDE
 * any request transaction: every DB touch opens its own short tenant transaction; runtime calls
 * happen in between. Fire-and-forget callers must catch — this function itself persists failures
 * onto the row instead of throwing (a crash mid-way is recovered lazily by `markRunInterrupted`).
 */
export async function launchAndRecordRun(input: {
  orgId: string;
  actorId: string;
  runId: string;
  ctx: RunControlContext;
}): Promise<void> {
  const { orgId, actorId, runId, ctx } = input;
  liveRunJobs.add(runId);
  try {
    await launchAndRecordRunInner(input);
  } finally {
    liveRunJobs.delete(runId);
  }
}

async function launchAndRecordRunInner(input: {
  orgId: string;
  actorId: string;
  runId: string;
  ctx: RunControlContext;
}): Promise<void> {
  const { orgId, actorId, runId, ctx } = input;

  const setRun = async (patch: Partial<typeof schema.skillRuns.$inferInsert>) => {
    await ctx.runTenant({ orgId, userId: actorId }, async (database) => {
      await database
        .update(schema.skillRuns)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(schema.skillRuns.id, runId));
    });
  };

  const failRun = async (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    const detail = error instanceof RunRuntimeError && error.detail ? `\n${error.detail}` : "";
    await setRun({ status: "error", statusDetail: `${message}${detail}` });
  };

  // Prelude — load everything and decrypt OUTSIDE the step flow. Any failure here (rotated KEK,
  // missing version, S3 outage) must never leave the row stuck in `starting`.
  let loaded: {
    row: RunRow;
    skillSlug: string;
    storagePath: string;
    attachments: Array<{ path: string; data: Buffer }>;
    attachmentNames: string[];
    serverPassword: string;
    providerEnv: Map<string, string>;
    artifactsEnabled: boolean;
  };
  try {
    loaded = await ctx.runTenant({ orgId, userId: actorId }, async (database) => {
      const row = await loadRunRow(database, orgId, runId);
      if (!row) throw new RunValidationError("run not found");
      const skillSlug = await loadSkillSlug(database, orgId, row.skillId);
      const versions = await database
        .select({
          skillId: schema.skillVersions.skillId,
          version: schema.skillVersions.version,
          storagePath: schema.skillVersions.storagePath,
        })
        .from(schema.skillVersions)
        .where(and(eq(schema.skillVersions.orgId, orgId), eq(schema.skillVersions.skillId, row.skillId)));
      const version = (Array.isArray(versions) ? versions : []).find(
        (v) => v.skillId === row.skillId && v.version === row.skillVersion,
      );
      if (!version) throw new RunValidationError(`stored package for version ${row.skillVersion ?? "?"} not found`);
      const attachmentRows = await loadAttachments(database, orgId, runId);
      const serverPassword = decryptServerPassword(orgId, row, ctx);
      const providerEnv = await resolveProviderEnv(database, orgId, row.creatorId, row.model, ctx);
      const vanishKey = await getDecryptedProviderKey({
        database,
        orgId,
        userId: row.creatorId,
        provider: "vanish",
        secretsKey: ctx.secretsKey,
      });
      return {
        row,
        skillSlug,
        storagePath: version.storagePath as string,
        // Attachment bytes are fetched below, outside the transaction.
        attachments: attachmentRows.map((a) => ({ path: a.fileName, data: Buffer.alloc(0), storageKey: a.storageKey })),
        attachmentNames: attachmentRows.map((a) => a.fileName),
        serverPassword,
        providerEnv,
        artifactsEnabled: vanishKey !== null,
      };
    });
  } catch (error) {
    await failRun(error);
    return;
  }
  const { row, skillSlug } = loaded;

  const ref: SandboxRef = {
    sandboxName: row.sandboxName ?? sandboxNameForRun(orgId, runId),
    sandboxId: row.sandboxId,
    region: ctx.region,
    timeoutMs: row.timeoutMs,
  };

  let domain: string;
  let sessionId: string;
  try {
    // Fetch attachment bytes from object storage (never inside a transaction).
    const attachments: Array<{ path: string; data: Buffer }> = [];
    for (const a of loaded.attachments as Array<{ path: string; data: Buffer; storageKey: string }>) {
      attachments.push({ path: a.path, data: await ctx.fetchObject(a.storageKey) });
    }

    // Step 1 — fork.
    await setRun({ statusDetail: "Preparing sandbox" });
    if (!ctx.goldenSnapshotId) {
      throw new RunRuntimeError("COMPANION_GOLDEN_SNAPSHOT_ID is not configured");
    }
    const forked = await ctx.runtime.forkFromGolden({ ref, goldenSnapshotId: ctx.goldenSnapshotId });
    ref.sandboxId = forked.sandboxId;
    domain = forked.domain;
    await setRun({ sandboxId: forked.sandboxId, sandboxDomain: forked.domain });

    // Step 2 — push the skill + attachments.
    await setRun({ statusDetail: "Installing skill" });
    const bundle = await buildSkillBundle(skillSlug, row.skillVersion ?? "?", loaded.storagePath, ctx.fetchArchive);
    await ctx.runtime.pushWorkspace({
      ref,
      files: {
        opencodeJson: buildOpencodeJson({ model: row.model }),
        skill: bundle,
        attachments,
      },
    });

    // Step 3 — start the server with the injected env (never persisted, never logged).
    await setRun({ statusDetail: "Starting agent" });
    await ctx.runtime.startServer({ ref, env: buildServeEnv(loaded.serverPassword, loaded.providerEnv) });
    await ctx.runtime.healthCheck({ ref, domain, password: loaded.serverPassword });

    // Step 4 — create the session and fire the composed prompt.
    const target: RunChatTarget = { domain, password: loaded.serverPassword };
    const session = await ctx.chat.createSession(target, promptExcerpt(row.prompt));
    sessionId = session.id;
    await ctx.chat.sendPrompt(
      target,
      sessionId,
      composeRunPrompt({
        prompt: row.prompt,
        skillSlug,
        attachmentNames: loaded.attachmentNames,
        artifactsEnabled: loaded.artifactsEnabled,
      }),
    );
    await setRun({
      opencodeSessionId: sessionId,
      status: "running",
      statusDetail: null,
      lastActiveAt: new Date(),
    });
  } catch (error) {
    await failRun(error);
    // Best-effort teardown so a broken sandbox never lingers half-alive.
    try {
      await ctx.runtime.stop(ref);
    } catch {
      /* idempotent */
    }
    return;
  }

  // Recorder — same job, independent consumer of the sandbox event stream. Everything is wrapped
  // so an unexpected crash FREEZES the run instead of leaking a live row.
  await recordRun({ orgId, actorId, runId, ctx, ref, target: { domain, password: loaded.serverPassword }, sessionId });
}

async function recordRun(input: {
  orgId: string;
  actorId: string;
  runId: string;
  ctx: RunControlContext;
  ref: SandboxRef;
  target: RunChatTarget;
  sessionId: string;
}): Promise<void> {
  const { orgId, actorId, runId, ctx, ref, target, sessionId } = input;
  const abort = new AbortController();
  let lastActivity = Date.now();
  activityRegistry.set(runId, () => {
    lastActivity = Date.now();
  });
  const poll = setInterval(() => {
    if (Date.now() - lastActivity > ctx.timeoutMs) abort.abort();
  }, ctx.activityPollMs ?? 15_000);

  const setRun = async (patch: Partial<typeof schema.skillRuns.$inferInsert>) => {
    await ctx.runTenant({ orgId, userId: actorId }, async (database) => {
      await database
        .update(schema.skillRuns)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(schema.skillRuns.id, runId));
    });
  };

  const snapshot = async () => {
    try {
      const items = capTranscript(await ctx.chat.loadItems(target, sessionId));
      await setRun({ transcript: items, transcriptUpdatedAt: new Date(), lastActiveAt: new Date() });
    } catch {
      // Snapshot is best-effort: the sandbox may already be gone.
    }
    try {
      await collectAndPublishArtifacts({ orgId, actorId, runId, ctx, ref });
    } catch (error) {
      console.error(`[runs] artifact collection for ${runId} failed:`, error instanceof Error ? error.message : error);
    }
  };

  try {
    for await (const event of ctx.chat.streamEvents(target, sessionId, abort.signal)) {
      lastActivity = Date.now();
      if (event.type === "session.idle") await snapshot();
    }
  } catch {
    // Stream died (sandbox timeout / network) — freeze below.
  } finally {
    clearInterval(poll);
    activityRegistry.delete(runId);
    // Freeze: final snapshot + final artifact collection, then stop the sandbox.
    await snapshot();
    await setRun({ status: "frozen", statusDetail: null, frozenAt: new Date() });
    try {
      await ctx.runtime.stop(ref);
    } catch {
      /* idempotent */
    }
  }
}

/* ------------------------------------ artifacts --------------------------------------------- */

const ARTIFACTS_DIR = "/vercel/sandbox/artifacts";
const ARTIFACT_MAX_FILES = 20;
const ARTIFACT_MAX_BYTES = 10 * 1024 * 1024;

const ARTIFACT_CONTENT_TYPES: Record<string, string> = {
  html: "text/html",
  htm: "text/html",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  csv: "text/csv",
  json: "application/json",
  md: "text/markdown",
  txt: "text/plain",
};

function artifactContentType(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  return ARTIFACT_CONTENT_TYPES[ext] ?? "application/octet-stream";
}

/**
 * Collect `artifacts/` from the sandbox and publish new files to Vanish with the LAUNCHER's key.
 * Fully skipped when no key is connected. The decrypted key lives only in this scope — it is never
 * injected into the sandbox env and never persisted. Publish failures insert nothing; they surface
 * on the live SSE stream as normalized `error` events (and in the server log).
 */
async function collectAndPublishArtifacts(input: {
  orgId: string;
  actorId: string;
  runId: string;
  ctx: RunControlContext;
  ref: SandboxRef;
}): Promise<void> {
  const { orgId, actorId, runId, ctx, ref } = input;

  const prelude = await ctx.runTenant({ orgId, userId: actorId }, async (database) => {
    const row = await loadRunRow(database, orgId, runId);
    if (!row) return null;
    const key = await getDecryptedProviderKey({
      database,
      orgId,
      userId: row.creatorId,
      provider: "vanish",
      secretsKey: ctx.secretsKey,
    });
    if (!key) return null;
    const existing = await loadArtifacts(database, orgId, runId);
    return { apiKey: key.value, existingPaths: new Set(existing.map((a) => a.path)) };
  });
  if (!prelude) return;

  const files = await ctx.runtime.collectFiles({
    ref,
    dir: ARTIFACTS_DIR,
    maxFiles: ARTIFACT_MAX_FILES,
    maxFileBytes: ARTIFACT_MAX_BYTES,
  });

  for (const file of files) {
    if (prelude.existingPaths.has(file.path)) continue;
    if (vanishBlockedExtension(file.path)) continue;
    const fileName = file.path.split("/").pop() || file.path;
    try {
      const published = await ctx.publishArtifact({
        apiKey: prelude.apiKey,
        filename: fileName,
        bytes: file.data,
        idempotencyKey: `${runId}:${file.path}:${file.byteSize}`,
      });
      await ctx.runTenant({ orgId, userId: actorId }, async (database) => {
        await database.insert(schema.skillRunArtifacts).values({
          orgId,
          runId,
          path: file.path,
          fileName,
          contentType: artifactContentType(fileName),
          byteSize: file.byteSize,
          vanishId: published.id,
          url: published.url,
          expiresAt: published.expiresAt ? new Date(published.expiresAt) : null,
        });
      });
      prelude.existingPaths.add(file.path);
    } catch (error) {
      const message =
        error instanceof VanishError
          ? `Could not publish ${fileName}: ${error.message}${error.hint ? ` — ${error.hint}` : ""}`
          : `Could not publish ${fileName}`;
      console.error(`[runs] ${message}`);
      emitRunSideEvent(runId, { type: "error", message });
    }
  }
}

/* ------------------------------------ reads + prompt --------------------------------------- */

/**
 * Crash recovery, applied lazily at read time: a `starting`/`running` row with NO live in-process
 * job means the API restarted (or the job died). Freeze it (or error it, when it never left
 * `starting`) with the designed message so the UI renders the last snapshot.
 */
async function markRunInterrupted(database: Db, row: RunRow): Promise<RunRow> {
  const interrupted: Partial<typeof schema.skillRuns.$inferInsert> =
    row.status === "starting"
      ? { status: "error", statusDetail: "Interrupted — the server restarted during this run." }
      : { status: "frozen", statusDetail: "Interrupted — the server restarted during this run.", frozenAt: new Date() };
  await database
    .update(schema.skillRuns)
    .set({ ...interrupted, updatedAt: new Date() })
    .where(eq(schema.skillRuns.id, row.id));
  return { ...row, ...(interrupted as Partial<RunRow>) } as RunRow;
}

/** The caller's runs of one skill, newest first. NEVER returns another member's runs. */
export async function listRuns(input: {
  actor: ActorContext;
  orgId: string;
  slug: string;
  jobAlive?: (runId: string) => boolean;
  database?: Db;
}): Promise<SkillRunRow[]> {
  const database = input.database ?? db;
  await assertMember(database, input.actor, input.orgId);
  const skill = await loadSkillBySlug(database, input.orgId, input.slug);
  if (skill && !canAccessSkill(input.actor.id, { scope: skill.scope, creatorId: skill.creatorId })) {
    throw new RunValidationError("skill not found");
  }
  if (!skill) throw new RunValidationError("skill not found");

  const alive = input.jobAlive ?? runJobAlive;
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
  let list = (Array.isArray(rows) ? (rows as RunRow[]) : []).filter((r) => r.creatorId === input.actor.id);
  list = await Promise.all(
    list.map(async (row) =>
      (row.status === "starting" || row.status === "running") && !alive(row.id)
        ? markRunInterrupted(database, row)
        : row,
    ),
  );

  const artifactRows = list.length
    ? await database
        .select({ runId: schema.skillRunArtifacts.runId, id: schema.skillRunArtifacts.id })
        .from(schema.skillRunArtifacts)
        .where(
          and(
            eq(schema.skillRunArtifacts.orgId, input.orgId),
            inArray(
              schema.skillRunArtifacts.runId,
              list.map((r) => r.id),
            ),
          ),
        )
    : [];
  const counts = new Map<string, number>();
  for (const a of Array.isArray(artifactRows) ? artifactRows : []) {
    counts.set(a.runId as string, (counts.get(a.runId as string) ?? 0) + 1);
  }
  return list
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .map((row) => toRunRow(row, input.slug, counts.get(row.id) ?? 0));
}

/** Full run detail (transcript + attachments + artifacts). Creator-only; anyone else sees 404. */
export async function getRun(input: {
  actor: ActorContext;
  orgId: string;
  runId: string;
  jobAlive?: (runId: string) => boolean;
  database?: Db;
}): Promise<SkillRunDetail> {
  const database = input.database ?? db;
  await assertMember(database, input.actor, input.orgId);
  let row = await loadRunRow(database, input.orgId, input.runId);
  if (!row || !canAccessRun(input.actor.id, { creatorId: row.creatorId })) {
    throw new RunValidationError("run not found");
  }
  const alive = input.jobAlive ?? runJobAlive;
  if ((row.status === "starting" || row.status === "running") && !alive(row.id)) {
    row = await markRunInterrupted(database, row);
  }
  const skillSlug = await loadSkillSlug(database, input.orgId, row.skillId);
  const attachments = await loadAttachments(database, input.orgId, input.runId);
  const artifacts = await loadArtifacts(database, input.orgId, input.runId);
  return toDetail(row, skillSlug, attachments, artifacts);
}

/** One attachment row + its storage key, creator-only (the download route streams it from S3). */
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
  if (!row || !canAccessRun(input.actor.id, { creatorId: row.creatorId })) {
    throw new RunValidationError("run not found");
  }
  const attachments = await loadAttachments(database, input.orgId, input.runId);
  const attachment = attachments.find((a) => a.id === input.attachmentId);
  if (!attachment) throw new RunValidationError("attachment not found");
  return { fileName: attachment.fileName, contentType: attachment.contentType, storageKey: attachment.storageKey };
}

/**
 * The live chat target for a run (SSE proxy + prompt route). Creator-only. Throws `RunBusyError`
 * when the run is frozen (the client renders the persisted transcript instead) and
 * `RunValidationError` while it is still starting or errored.
 */
export async function getRunChatTarget(input: {
  actor: ActorContext;
  orgId: string;
  runId: string;
  ctx: RunControlContext;
  database?: Db;
}): Promise<{ domain: string; password: string; sessionId: string; status: SkillRunStatus }> {
  const database = input.database ?? db;
  await assertMember(database, input.actor, input.orgId);
  const row = await loadRunRow(database, input.orgId, input.runId);
  if (!row || !canAccessRun(input.actor.id, { creatorId: row.creatorId })) {
    throw new RunValidationError("run not found");
  }
  if (row.status === "frozen") throw new RunBusyError("This session has ended — start a new run.");
  if (row.status !== "running" || !row.sandboxDomain || !row.opencodeSessionId) {
    throw new RunValidationError("this run is not live yet");
  }
  return {
    domain: row.sandboxDomain,
    password: decryptServerPassword(input.orgId, row, input.ctx),
    sessionId: row.opencodeSessionId,
    status: row.status as SkillRunStatus,
  };
}

/**
 * A follow-up prompt on a live run: 409 when frozen, refreshes the recorder's inactivity clock and
 * best-effort extends the sandbox timeout so an active conversation doesn't die mid-stream.
 */
export async function promptRun(input: {
  actor: ActorContext;
  orgId: string;
  runId: string;
  text: string;
  ctx: RunControlContext;
  database?: Db;
}): Promise<void> {
  const database = input.database ?? db;
  const target = await getRunChatTarget(input);
  await input.ctx.chat.sendPrompt({ domain: target.domain, password: target.password }, target.sessionId, input.text);
  await database
    .update(schema.skillRuns)
    .set({ lastActiveAt: new Date(), updatedAt: new Date() })
    .where(eq(schema.skillRuns.id, input.runId));
  noteRunActivity(input.runId);
  const row = await loadRunRow(database, input.orgId, input.runId);
  if (row?.sandboxName && input.ctx.runtime.extendTimeout) {
    try {
      await input.ctx.runtime.extendTimeout(
        { sandboxName: row.sandboxName, sandboxId: row.sandboxId, region: input.ctx.region, timeoutMs: row.timeoutMs },
        row.timeoutMs,
      );
    } catch {
      /* best-effort */
    }
  }
}
