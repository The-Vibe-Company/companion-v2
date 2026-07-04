import { randomBytes } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { db, schema, withTenantContext, type Db } from "@companion/db";
import type {
  AgentDetail,
  AgentLifecycle,
  AgentListRow,
  AgentPendingOp,
  AgentSecretState,
  AgentSessionSummary,
  AgentStatus,
  AgentsListResponse,
  AgentsSummary,
  AgentsUpdateNotice,
  AffectedAgentsResponse,
  CreateAgentInput,
  ProvisionError,
  ProvisionProgress,
  ProvisionStep,
  ProvisionStepKey,
  SkillRequirement,
} from "@companion/contracts";
import { companionManifestSchema, parseStoredSkillFrontmatter, RESERVED_AGENT_SECRET_KEYS } from "@companion/contracts";
import { canAccessAgent, canManageAgent } from "./authz";
import { agentSecretAad, openSecret, sealSecret } from "./secretbox";
import {
  AgentRuntimeError,
  OPENCODE_SERVER_USERNAME,
  type AgentRuntime,
  type SandboxRef,
  type ServeEnv,
  type SkillArchiveFetcher,
  type SkillBundle,
} from "./agentRuntime";
import { assertMember, type ActorContext } from "./services";
import { getDecryptedProviderKey } from "./providerConnections";

/**
 * Companion Agents services. Every function keeps the house shape
 * `fn({ actor, orgId, ..., database? })` and its OWN queries (never shared with the skill list
 * paths — the hand-rolled fakeDbs in the test suites depend on that isolation).
 *
 * TRANSACTION RULE: `withTenantContext` opens a Postgres transaction, so no sandbox/network call
 * ever runs inside one. The provisioning executor interleaves short tenant transactions (step
 * persistence) with long, un-transacted runtime calls.
 */

/* ------------------------------------ control context ----------------------------------- */

/** Opens a short tenant transaction (`withTenantContext` in production; a passthrough in tests). */
export type TenantRunner = <T>(input: { orgId: string; userId: string }, fn: (database: Db) => Promise<T>) => Promise<T>;

/** Everything the runtime-facing services need beyond the DB; composed once in apps/api. */
export interface AgentControlContext {
  runtime: AgentRuntime;
  /** Usually `withTenantContext`; injectable so unit tests can run against a fake database. */
  runTenant: TenantRunner;
  fetchArchive: SkillArchiveFetcher;
  /** Parsed COMPANION_SECRETS_KEY (see secretbox). */
  secretsKey: Buffer;
  goldenSnapshotId: string | null;
  opencodeVersion: string | null;
  region: string;
  timeoutMs: number;
  /**
   * Resolve a `provider/model` ref to the provider's API-key env var NAME(s). The control plane
   * never supplies key VALUES — the user stores their own key as a write-only agent secret under
   * one of these names, and it reaches the sandbox with the rest of the secrets.
   */
  resolveModelKeys: (model: string) => Promise<{ envKeys: string[] } | null>;
}

/* ------------------------------------ derivations --------------------------------------- */

interface StatusSource {
  lifecycle: AgentLifecycle;
  lastActiveAt: Date | null;
  pausedAt: Date | null;
  timeoutMs: number;
}

/**
 * The user-facing status, derived at read time (never stored) so rendering a list cannot wake a
 * sandbox: provisioning/error come from the lifecycle; otherwise the sandbox is considered running
 * while inside its activity window and not explicitly paused.
 */
export function computeAgentStatus(row: StatusSource, now: number = Date.now()): AgentStatus {
  if (row.lifecycle === "provisioning") return "provisioning";
  if (row.lifecycle === "error") return "error";
  if (row.pausedAt) return "sleeping";
  if (!row.lastActiveAt) return "sleeping";
  return now - row.lastActiveAt.getTime() < row.timeoutMs ? "running" : "sleeping";
}

/** Deterministic per-attempt sandbox name — retries fork a FRESH sandbox, never reuse a dirty one. */
export function sandboxNameFor(orgId: string, slug: string, attempt: number): string {
  const org8 = orgId.replace(/-/g, "").slice(0, 8);
  return `cmp-${org8}-${slug}-a${attempt}`;
}

/** `.opencode/agents/<slug>.md` — a business agent: operator instructions, coding tools denied. */
export function buildAgentMarkdown(input: { slug: string; description: string; instructions: string; model: string }): string {
  const description = (input.description || `Companion agent ${input.slug}`).replace(/\n/g, " ").slice(0, 200);
  return [
    "---",
    `description: ${JSON.stringify(description)}`,
    "mode: primary",
    `model: ${JSON.stringify(input.model)}`,
    "---",
    "",
    input.instructions.trim() || `You are ${input.slug}, a focused business agent. Use your installed skills to answer requests; decline work outside them.`,
    "",
  ].join("\n");
}

/** `opencode.json` — model pin + business-agent permissions (no code edits; bash for skill scripts). */
export function buildOpencodeJson(input: { model: string }): string {
  return `${JSON.stringify(
    {
      $schema: "https://opencode.ai/config.json",
      model: input.model,
      permission: { edit: "deny", bash: "allow", webfetch: "allow" },
    },
    null,
    2,
  )}\n`;
}

/** Requirements (secret/env declarations) from a stored skill-version frontmatter JSON. */
export function skillRequirementsFromFrontmatter(frontmatter: string): SkillRequirement[] {
  try {
    const raw = JSON.parse(frontmatter) as { companion?: unknown };
    if (raw.companion) {
      const parsed = companionManifestSchema.safeParse(raw.companion);
      if (parsed.success) return parsed.data.requirements;
    }
  } catch {
    // fall through to the legacy path
  }
  const legacy = parseStoredSkillFrontmatter(frontmatter);
  return legacy?.requirements ?? [];
}

/* ------------------------------------ internal loads ------------------------------------- */

type AgentRow = typeof schema.agents.$inferSelect;
type AgentSkillRow = typeof schema.agentSkills.$inferSelect;

interface PinJoin {
  pin: AgentSkillRow;
  slug: string;
  currentVersion: string | null;
  /** Stored frontmatter of the PINNED version (for secret requirements); null when missing. */
  pinnedFrontmatter: string | null;
}

async function loadAgentRow(database: Db, orgId: string, slug: string): Promise<AgentRow | null> {
  const rows = await database
    .select()
    .from(schema.agents)
    .where(and(eq(schema.agents.orgId, orgId), eq(schema.agents.slug, slug)));
  return rows[0] ?? null;
}

/** Pins for a set of agents, joined with the skill slug + its current published version. */
async function loadPins(database: Db, orgId: string, agentIds: string[]): Promise<Map<string, PinJoin[]>> {
  const out = new Map<string, PinJoin[]>();
  if (agentIds.length === 0) return out;
  const rows = await database
    .select({
      pin: schema.agentSkills,
      slug: schema.skills.slug,
      currentVersion: schema.skillVersions.version,
    })
    .from(schema.agentSkills)
    .innerJoin(schema.skills, eq(schema.agentSkills.skillId, schema.skills.id))
    .leftJoin(schema.skillVersions, eq(schema.skills.currentVersionId, schema.skillVersions.id))
    .where(and(eq(schema.agentSkills.orgId, orgId), inArray(schema.agentSkills.agentId, agentIds)));
  for (const row of rows) {
    const list = out.get(row.pin.agentId) ?? [];
    list.push({ pin: row.pin, slug: row.slug, currentVersion: row.currentVersion ?? null, pinnedFrontmatter: null });
    out.set(row.pin.agentId, list);
  }
  for (const list of out.values()) list.sort((a, b) => a.pin.position - b.pin.position || a.slug.localeCompare(b.slug));
  return out;
}

/** Frontmatter of the exact pinned versions (secret requirements come from what actually runs). */
async function loadPinnedFrontmatter(database: Db, orgId: string, pins: PinJoin[]): Promise<void> {
  if (pins.length === 0) return;
  const skillIds = pins.map((p) => p.pin.skillId);
  const versions = await database
    .select({
      skillId: schema.skillVersions.skillId,
      version: schema.skillVersions.version,
      frontmatter: schema.skillVersions.frontmatter,
    })
    .from(schema.skillVersions)
    .where(and(eq(schema.skillVersions.orgId, orgId), inArray(schema.skillVersions.skillId, skillIds)));
  for (const pin of pins) {
    pin.pinnedFrontmatter =
      versions.find((v) => v.skillId === pin.pin.skillId && v.version === pin.pin.version)?.frontmatter ?? null;
  }
}

function toListRow(row: AgentRow, pins: PinJoin[], now: number): AgentListRow {
  const skills = pins.map((p) => ({
    skill_id: p.pin.skillId,
    slug: p.slug,
    version: p.pin.version,
    latest_version: p.currentVersion,
    outdated: p.currentVersion !== null && p.currentVersion !== p.pin.version,
    position: p.pin.position,
  }));
  return {
    id: row.id,
    org_id: row.orgId,
    slug: row.slug,
    scope: row.scope,
    creator_id: row.creatorId,
    client_label: row.clientLabel,
    group_label: row.groupLabel,
    description: firstLine(row.instructions),
    model: row.model,
    region: row.region,
    lifecycle: row.lifecycle,
    status: computeAgentStatus(row, now),
    sandbox_name: row.sandboxName,
    skills,
    outdated_count: skills.filter((s) => s.outdated).length,
    sessions_count: row.sessionsCache.length,
    pending_op: (row.pendingOp as AgentPendingOp | null) ?? null,
    last_active_at: row.lastActiveAt?.toISOString() ?? null,
    created_at: row.createdAt.toISOString(),
  };
}

function firstLine(instructions: string): string {
  const line = instructions.split("\n").find((l) => l.trim() !== "")?.trim() ?? "";
  return line.replace(/^#+\s*/, "").slice(0, 120) || "Newly provisioned agent.";
}

function secretStates(pins: PinJoin[], setKeys: Set<string>): AgentSecretState[] {
  const byKey = new Map<string, AgentSecretState>();
  for (const pin of pins) {
    const requirements = pin.pinnedFrontmatter ? skillRequirementsFromFrontmatter(pin.pinnedFrontmatter) : [];
    for (const req of requirements) {
      const existing = byKey.get(req.key);
      if (existing) {
        if (!existing.required_by.includes(pin.slug)) existing.required_by.push(pin.slug);
        existing.required = existing.required || req.required;
        if (!existing.note && req.note) existing.note = req.note;
      } else {
        byKey.set(req.key, {
          key: req.key,
          set: setKeys.has(req.key),
          required_by: [pin.slug],
          required: req.required,
          kind: req.type === "env" ? "env" : "secret",
          note: req.note || null,
        });
      }
    }
  }
  // Keys the operator set that no current pin declares still show (they exist and will be injected).
  for (const key of setKeys) {
    if (!byKey.has(key)) byKey.set(key, { key, set: true, required_by: [], required: false, kind: "secret", note: null });
  }
  return [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key));
}

function toDetail(row: AgentRow, pins: PinJoin[], setKeys: Set<string>, now: number): AgentDetail {
  return {
    ...toListRow(row, pins, now),
    instructions: row.instructions,
    sandbox_id: row.sandboxId,
    golden_snapshot_id: row.goldenSnapshotId,
    opencode_version: row.opencodeVersion,
    last_resume_ms: row.lastResumeMs,
    provision: {
      attempt: row.provisionAttempt,
      steps: row.provisionSteps as ProvisionStep[],
      error: (row.provisionError as ProvisionError | null) ?? null,
    },
    secrets: secretStates(pins, setKeys),
    sessions: row.sessionsCache as AgentSessionSummary[],
  };
}

/** Library filter: `mine` = the actor's personal agents; `org` = the flat org fleet. */
function inLibrary(row: AgentRow, library: "mine" | "org", actorId: string): boolean {
  return library === "org" ? row.scope === "org" : row.scope === "personal" && row.creatorId === actorId;
}

/* ------------------------------------ reads ---------------------------------------------- */

export async function listAgents(input: {
  actor: ActorContext;
  orgId: string;
  library?: "mine" | "org";
  database?: Db;
}): Promise<AgentsListResponse> {
  const database = input.database ?? db;
  await assertMember(database, input.actor, input.orgId);
  const library = input.library ?? "mine";
  const now = Date.now();

  const all = await database.select().from(schema.agents).where(eq(schema.agents.orgId, input.orgId));
  const visible = all.filter((row) => inLibrary(row, library, input.actor.id) && canAccessAgent(input.actor.id, row));
  const pinsByAgent = await loadPins(database, input.orgId, visible.map((row) => row.id));

  const agents = visible
    .map((row) => toListRow(row, pinsByAgent.get(row.id) ?? [], now))
    .sort((a, b) => (b.last_active_at ?? "").localeCompare(a.last_active_at ?? "") || a.slug.localeCompare(b.slug));

  const summary: AgentsSummary = {
    total: agents.length,
    running: agents.filter((a) => a.status === "running").length,
    sleeping: agents.filter((a) => a.status === "sleeping").length,
    provisioning: agents.filter((a) => a.status === "provisioning").length,
    error: agents.filter((a) => a.status === "error").length,
    outdated: agents.filter((a) => a.outdated_count > 0).length,
  };

  const noticeMap = new Map<string, AgentsUpdateNotice>();
  for (const agent of agents) {
    for (const pin of agent.skills) {
      if (!pin.outdated || !pin.latest_version) continue;
      const existing = noticeMap.get(pin.skill_id);
      if (existing) existing.affected_count += 1;
      else
        noticeMap.set(pin.skill_id, {
          skill_id: pin.skill_id,
          slug: pin.slug,
          latest_version: pin.latest_version,
          affected_count: 1,
          released_at: null,
        });
    }
  }

  return { agents, summary, updates: [...noticeMap.values()].sort((a, b) => b.affected_count - a.affected_count) };
}

export async function getAgentBySlug(input: {
  actor: ActorContext;
  orgId: string;
  slug: string;
  database?: Db;
}): Promise<AgentDetail | null> {
  const database = input.database ?? db;
  await assertMember(database, input.actor, input.orgId);
  const row = await loadAgentRow(database, input.orgId, input.slug);
  if (!row || !canAccessAgent(input.actor.id, row)) return null;
  const pins = (await loadPins(database, input.orgId, [row.id])).get(row.id) ?? [];
  await loadPinnedFrontmatter(database, input.orgId, pins);
  const setKeys = await loadSecretKeys(database, input.orgId, row.id);
  return toDetail(row, pins, setKeys, Date.now());
}

async function loadSecretKeys(database: Db, orgId: string, agentId: string): Promise<Set<string>> {
  const rows = await database
    .select({ key: schema.agentSecrets.key })
    .from(schema.agentSecrets)
    .where(and(eq(schema.agentSecrets.orgId, orgId), eq(schema.agentSecrets.agentId, agentId)));
  return new Set(rows.map((r) => r.key));
}

/* ------------------------------------ create ---------------------------------------------- */

export async function createAgent(input: {
  actor: ActorContext;
  orgId: string;
  input: CreateAgentInput;
  ctx: AgentControlContext;
  database?: Db;
}): Promise<AgentDetail> {
  const database = input.database ?? db;
  await assertMember(database, input.actor, input.orgId);
  const spec = input.input;

  const modelKeys = await input.ctx.resolveModelKeys(spec.model);
  if (!modelKeys) {
    throw new AgentValidationError(`model ${spec.model} is not available (unknown or not tool-capable)`);
  }

  for (const key of Object.keys(spec.secrets)) {
    assertUnreservedSecretKey(key);
  }
  const existing = await loadAgentRow(database, input.orgId, spec.slug);
  if (existing) throw new AgentValidationError(`an agent named ${spec.slug} already exists`);

  const skillRows = await database
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
    .where(
      and(
        eq(schema.skills.orgId, input.orgId),
        inArray(
          schema.skills.slug,
          spec.skills.map((s) => s.slug),
        ),
      ),
    );
  for (const wanted of spec.skills) {
    const found = skillRows.find((s) => s.slug === wanted.slug);
    if (!found || found.archivedAt) throw new AgentValidationError(`skill ${wanted.slug} is not available in this workspace`);
    if (!canAccessAgent(input.actor.id, { scope: found.scope, creatorId: found.creatorId })) {
      throw new AgentValidationError(`skill ${wanted.slug} is not available in this workspace`);
    }
    if (!found.currentVersion) throw new AgentValidationError(`skill ${wanted.slug} has no published version`);
  }

  const agentId = crypto.randomUUID();
  const serverPassword = randomBytes(24).toString("base64url");
  const sealedPassword = sealSecret({
    kek: input.ctx.secretsKey,
    plaintext: serverPassword,
    aad: agentSecretAad(input.orgId, agentId, "OPENCODE_SERVER_PASSWORD"),
  });

  const inserted = await database
    .insert(schema.agents)
    .values({
      id: agentId,
      orgId: input.orgId,
      slug: spec.slug,
      scope: spec.scope,
      creatorId: input.actor.id,
      clientLabel: spec.client_label?.trim() || null,
      groupLabel: spec.group_label?.trim() || null,
      instructions: spec.instructions,
      model: spec.model,
      region: input.ctx.region,
      lifecycle: "provisioning",
      sandboxName: sandboxNameFor(input.orgId, spec.slug, 1),
      goldenSnapshotId: input.ctx.goldenSnapshotId,
      opencodeVersion: input.ctx.opencodeVersion,
      provisionAttempt: 1,
      provisionSteps: initialSteps(spec.skills.map((s) => s.slug)),
      serverPasswordEnc: `${sealedPassword.wrappedDek}|${sealedPassword.ciphertext}`,
      timeoutMs: input.ctx.timeoutMs,
    })
    .returning();
  const row = inserted[0];
  if (!row) throw new Error("agent insert returned no row");

  await database.insert(schema.agentSkills).values(
    spec.skills.map((wanted, index) => {
      const found = skillRows.find((s) => s.slug === wanted.slug);
      return {
        orgId: input.orgId,
        agentId,
        skillId: found?.id ?? "",
        version: found?.currentVersion ?? "0.0.0",
        position: index,
      };
    }),
  );

  // Only the skill-required variables the user typed are stored on the agent. The model provider
  // key is NOT copied here — it is referenced LIVE from the owner's saved connection at serve time
  // (see injectProviderConnectionKey), so rotating it in Settings propagates to every agent and it
  // never shows up as an agent variable. Reserved keys are already rejected by the contract schema.
  const secretEntries = Object.entries(spec.secrets).filter(([, value]) => value.trim() !== "");
  if (secretEntries.length > 0) {
    await database.insert(schema.agentSecrets).values(
      secretEntries.map(([key, value]) => {
        const sealed = sealSecret({
          kek: input.ctx.secretsKey,
          plaintext: value,
          aad: agentSecretAad(input.orgId, agentId, key),
        });
        return {
          orgId: input.orgId,
          agentId,
          key,
          wrappedDek: sealed.wrappedDek,
          ciphertext: sealed.ciphertext,
          createdBy: input.actor.id,
        };
      }),
    );
  }

  await database.insert(schema.auditLog).values({
    orgId: input.orgId,
    actorId: input.actor.id,
    action: "agent.create",
    targetType: "agent",
    targetId: agentId,
    metadata: { slug: spec.slug, scope: spec.scope, model: spec.model, skills: spec.skills.map((s) => s.slug) },
  });

  const pins = (await loadPins(database, input.orgId, [agentId])).get(agentId) ?? [];
  await loadPinnedFrontmatter(database, input.orgId, pins);
  return toDetail(row, pins, new Set(secretEntries.map(([key]) => key)), Date.now());
}

/** Validation failures the routes surface as 422s. */
export class AgentValidationError extends Error {}
/** Concurrency guard failures the routes surface as 409s. */
export class AgentBusyError extends Error {}

function initialSteps(skillSlugs: string[]): ProvisionStep[] {
  const count = skillSlugs.length;
  return [
    { key: "fork", label: "Fork snapshot", detail: "", state: "pending", duration_ms: null },
    {
      key: "push",
      label: `Push ${count} ${count === 1 ? "skill" : "skills"}`,
      detail: skillSlugs.join(", "),
      state: "pending",
      duration_ms: null,
    },
    { key: "serve", label: "Start server", detail: "opencode serve --port 4096", state: "pending", duration_ms: null },
    { key: "health", label: "Health check", detail: "GET /doc → 200", state: "pending", duration_ms: null },
  ];
}

/* ------------------------------------ provisioning pipeline ------------------------------- */

/**
 * The 4-step executor. Runs OUTSIDE any request transaction: every DB touch opens its own short
 * tenant transaction; runtime calls happen in between. Fire-and-forget callers must catch — this
 * function itself never throws for step failures (they are persisted onto the row).
 */
export async function provisionAgent(input: {
  orgId: string;
  actorId: string;
  agentId: string;
  ctx: AgentControlContext;
}): Promise<void> {
  const { orgId, actorId, agentId, ctx } = input;

  // The prelude decrypts secrets + the server password OUTSIDE the step wrappers. A decryption
  // failure (rotated/corrupt KEK) must not leave the row stuck in `provisioning` — persist a
  // designed error so the UI can offer a fresh-fork retry.
  let loaded: { row: AgentRow; pins: PinJoin[]; storagePaths: Map<string, string>; secrets: Map<string, string>; serverPassword: string } | null;
  try {
    loaded = await ctx.runTenant({ orgId, userId: actorId }, async (database) => {
      const rows = await database.select().from(schema.agents).where(eq(schema.agents.id, agentId));
      const row = rows[0];
      if (!row) return null;
      const pins = (await loadPins(database, orgId, [row.id])).get(row.id) ?? [];
      await loadPinnedFrontmatter(database, orgId, pins);
      const storagePaths = await loadPinStoragePaths(database, orgId, pins);
      const secrets = await loadDecryptedSecrets(database, orgId, row, ctx);
      const serverPassword = decryptServerPassword(orgId, row, ctx);
      return { row, pins, storagePaths, secrets, serverPassword };
    });
  } catch (error) {
    await ctx.runTenant({ orgId, userId: actorId }, async (database) => {
      await database
        .update(schema.agents)
        .set({
          lifecycle: "error",
          provisionError: {
            message: `Error: prepare: ${error instanceof Error ? error.message : String(error)}`,
            sandbox_name: null,
            region: ctx.region,
            step: "fork",
            exit_code: null,
            detail: "Could not decrypt this agent's secrets. Retry provisions a fresh fork.",
          },
          updatedAt: new Date(),
        })
        .where(eq(schema.agents.id, agentId));
    });
    return;
  }
  if (!loaded) return;
  const { row, pins, storagePaths, secrets, serverPassword } = loaded;

  const ref: SandboxRef = {
    sandboxName: row.sandboxName ?? sandboxNameFor(orgId, row.slug, row.provisionAttempt),
    sandboxId: row.sandboxId,
    region: row.region,
    timeoutMs: row.timeoutMs,
  };

  let steps = row.provisionSteps as ProvisionStep[];
  let domain: string | null = row.sandboxDomain;

  const persistSteps = async (patch: Partial<typeof schema.agents.$inferInsert>) => {
    await ctx.runTenant({ orgId, userId: actorId }, async (database) => {
      await database
        .update(schema.agents)
        .set({ provisionSteps: steps, updatedAt: new Date(), ...patch })
        .where(eq(schema.agents.id, agentId));
    });
  };

  const setStep = (key: ProvisionStepKey, state: ProvisionStep["state"], patch: Partial<ProvisionStep> = {}) => {
    steps = steps.map((step) => (step.key === key ? { ...step, ...patch, state } : step));
  };

  const fail = async (key: ProvisionStepKey, error: unknown, startedAt: number) => {
    const message = error instanceof Error ? error.message : String(error);
    const exitCode = error instanceof AgentRuntimeError ? error.exitCode : null;
    const detail = error instanceof AgentRuntimeError ? error.detail : null;
    setStep(key, "failed", { duration_ms: Date.now() - startedAt });
    const provisionError: ProvisionError = {
      message: `Error: ${stepLabel(key)}: ${message}`,
      sandbox_name: ref.sandboxName,
      region: ref.region,
      step: key,
      exit_code: exitCode,
      detail: detail ?? "The sandbox was stopped. Fix the cause, then retry with a fresh fork.",
    };
    await persistSteps({ lifecycle: "error", provisionError });
    // Best-effort teardown so a broken sandbox never lingers half-alive.
    try {
      await ctx.runtime.stop(ref);
    } catch {
      /* idempotent */
    }
  };

  const run = async <T>(key: ProvisionStepKey, fn: () => Promise<T>, detail?: string): Promise<T | null> => {
    const startedAt = Date.now();
    setStep(key, "running", detail !== undefined ? { detail } : {});
    await persistSteps({});
    try {
      const result = await fn();
      setStep(key, "done", { duration_ms: Date.now() - startedAt });
      await persistSteps({});
      return result;
    } catch (error) {
      await fail(key, error, startedAt);
      return null;
    }
  };

  // Step 1 — fork.
  if (!ctx.goldenSnapshotId) {
    await fail("fork", new AgentRuntimeError("COMPANION_GOLDEN_SNAPSHOT_ID is not configured"), Date.now());
    return;
  }
  const forked = await run(
    "fork",
    () => ctx.runtime.forkFromGolden({ ref, goldenSnapshotId: ctx.goldenSnapshotId! }),
    `${ctx.goldenSnapshotId} → ${ref.sandboxName}`,
  );
  if (!forked) return;
  ref.sandboxId = forked.sandboxId;
  domain = forked.domain;
  await persistSteps({ sandboxId: forked.sandboxId, sandboxDomain: forked.domain });

  // Step 2 — push skills (bundle extraction included; a missing required secret fails HERE, by design).
  const pushed = await run("push", async () => {
    const modelKeys = await modelKeysOrThrow(ctx, row.model);
    if (!modelKeys.some((key) => secrets.has(key))) {
      const wanted = modelKeys[0] ?? "the provider API key";
      throw new AgentRuntimeError(`model ${row.model} requires ${wanted}`, {
        detail: `No API key is available for this model's provider. Connect it in Settings → Model providers (or set ${wanted} as a variable), then retry.\nThe sandbox was stopped.`,
      });
    }
    const missing = missingRequiredSecrets(pins, new Set(secrets.keys()));
    if (missing.length > 0) {
      const [firstKey, firstSlug] = missing[0]!;
      throw new AgentRuntimeError(`${firstSlug}@${pinVersion(pins, firstSlug)} requires ${firstKey}`, {
        detail: `No secret named ${firstKey} is set on this agent.\nThe sandbox was stopped. Set the secret, then retry.`,
      });
    }
    const bundles = await buildSkillBundles(pins, storagePaths, ctx.fetchArchive);
    await ctx.runtime.pushSkills({
      ref,
      files: {
        agentSlug: row.slug,
        agentMarkdown: buildAgentMarkdown({
          slug: row.slug,
          description: firstLine(row.instructions),
          instructions: row.instructions,
          model: row.model,
        }),
        opencodeJson: buildOpencodeJson({ model: row.model }),
        skills: bundles,
      },
    });
  });
  if (pushed === null) return;

  // Step 3 — start server with the injected env (never persisted, never logged). The model
  // provider key is one of the agent's own secrets — nothing comes from the control plane env.
  const env = buildServeEnv(serverPassword, secrets);
  const served = await run("serve", () => ctx.runtime.startServer({ ref, env }));
  if (served === null) return;

  // Step 4 — health check through the public domain.
  const healthy = await run("health", () => ctx.runtime.healthCheck({ ref, domain: domain!, password: serverPassword }));
  if (healthy === null) return;

  await persistSteps({ lifecycle: "ready", provisionError: null, lastActiveAt: new Date(), pausedAt: null });
  await ctx.runTenant({ orgId, userId: actorId }, async (database) => {
    await database.insert(schema.auditLog).values({
      orgId,
      actorId,
      action: "agent.provision",
      targetType: "agent",
      targetId: agentId,
      metadata: { slug: row.slug, attempt: row.provisionAttempt, sandbox: ref.sandboxName },
    });
  });
}

function stepLabel(key: ProvisionStepKey): string {
  const labels: Record<ProvisionStepKey, string> = {
    fork: "fork snapshot",
    push: "push skills",
    serve: "start server",
    health: "health check",
  };
  return labels[key];
}

function pinVersion(pins: PinJoin[], slug: string): string {
  return pins.find((p) => p.slug === slug)?.pin.version ?? "?";
}

/** [key, requiredBySlug] pairs for required secret declarations with no stored value. */
function missingRequiredSecrets(pins: PinJoin[], setKeys: Set<string>): Array<[string, string]> {
  const missing: Array<[string, string]> = [];
  for (const pin of pins) {
    const requirements = pin.pinnedFrontmatter ? skillRequirementsFromFrontmatter(pin.pinnedFrontmatter) : [];
    for (const req of requirements) {
      if (req.type === "secret" && req.required && !setKeys.has(req.key)) missing.push([req.key, pin.slug]);
    }
  }
  return missing;
}

async function loadPinStoragePaths(database: Db, orgId: string, pins: PinJoin[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (pins.length === 0) return out;
  const rows = await database
    .select({
      skillId: schema.skillVersions.skillId,
      version: schema.skillVersions.version,
      storagePath: schema.skillVersions.storagePath,
    })
    .from(schema.skillVersions)
    .where(
      and(
        eq(schema.skillVersions.orgId, orgId),
        inArray(
          schema.skillVersions.skillId,
          pins.map((p) => p.pin.skillId),
        ),
      ),
    );
  for (const pin of pins) {
    const match = rows.find((r) => r.skillId === pin.pin.skillId && r.version === pin.pin.version);
    if (match) out.set(`${pin.pin.skillId}@${pin.pin.version}`, match.storagePath);
  }
  return out;
}

async function buildSkillBundles(
  pins: PinJoin[],
  storagePaths: Map<string, string>,
  fetchArchive: SkillArchiveFetcher,
): Promise<SkillBundle[]> {
  const { toTar, inspectTar, extractArchiveEntryBuffers } = await import("@companion/skills");
  const bundles: SkillBundle[] = [];
  for (const pin of pins) {
    const storagePath = storagePaths.get(`${pin.pin.skillId}@${pin.pin.version}`);
    if (!storagePath) {
      throw new AgentRuntimeError(`${pin.slug}@${pin.pin.version}: stored package not found`);
    }
    const archive = await fetchArchive(storagePath);
    const tar = toTar(archive);
    const finding = await inspectTar(tar);
    if (finding.violations.length > 0 || finding.oversize) {
      throw new AgentRuntimeError(`${pin.slug}@${pin.pin.version}: archive failed safety checks`, {
        detail: finding.violations.slice(0, 3).join("\n") || "size limits exceeded",
      });
    }
    const extracted = await extractArchiveEntryBuffers(tar);
    if (extracted.violations.length > 0 || extracted.oversize) {
      throw new AgentRuntimeError(`${pin.slug}@${pin.pin.version}: archive failed safety checks`, {
        detail: extracted.violations.slice(0, 3).join("\n"),
      });
    }
    // Strip the package root folder when present so SKILL.md lands at .claude/skills/<slug>/SKILL.md.
    const skillMdPath = extracted.files.find((f) => f.path.split("/").pop() === "SKILL.md")?.path ?? "SKILL.md";
    const root = skillMdPath.includes("/") ? skillMdPath.slice(0, skillMdPath.lastIndexOf("/") + 1) : "";
    bundles.push({
      slug: pin.slug,
      version: pin.pin.version,
      files: extracted.files
        .filter((f) => (root ? f.path.startsWith(root) : true))
        .map((f) => ({ path: root ? f.path.slice(root.length) : f.path, data: f.data, executable: f.executable })),
    });
  }
  return bundles;
}

function decryptServerPassword(orgId: string, row: AgentRow, ctx: AgentControlContext): string {
  const enc = row.serverPasswordEnc;
  if (!enc) throw new AgentRuntimeError("agent has no server password (corrupt row)");
  const [wrappedDek, ciphertext] = enc.split("|");
  if (!wrappedDek || !ciphertext) throw new AgentRuntimeError("agent server password is malformed");
  return openSecret({
    kek: ctx.secretsKey,
    sealed: { wrappedDek, ciphertext },
    aad: agentSecretAad(orgId, row.id, "OPENCODE_SERVER_PASSWORD"),
  });
}

async function loadDecryptedSecrets(
  database: Db,
  orgId: string,
  row: AgentRow,
  ctx: AgentControlContext,
): Promise<Map<string, string>> {
  const rows = await database
    .select()
    .from(schema.agentSecrets)
    .where(and(eq(schema.agentSecrets.orgId, orgId), eq(schema.agentSecrets.agentId, row.id)));
  const out = new Map<string, string>();
  for (const secret of rows) {
    out.set(
      secret.key,
      openSecret({
        kek: ctx.secretsKey,
        sealed: { wrappedDek: secret.wrappedDek, ciphertext: secret.ciphertext },
        aad: agentSecretAad(orgId, row.id, secret.key),
      }),
    );
  }
  await injectProviderConnectionKey(database, orgId, row, ctx, out);
  return out;
}

/**
 * Reference the owner's model-provider connection LIVE (it is never copied into the agent's secrets):
 * resolve the provider API key at serve time so rotating it in Settings propagates to every agent,
 * and so it never surfaces as an agent variable. A manually-set secret of the same name still wins.
 */
async function injectProviderConnectionKey(
  database: Db,
  orgId: string,
  row: AgentRow,
  ctx: AgentControlContext,
  out: Map<string, string>,
): Promise<void> {
  const slash = row.model.indexOf("/");
  const provider = slash > 0 ? row.model.slice(0, slash) : "";
  if (!provider) return;
  const resolved = await ctx.resolveModelKeys(row.model);
  if (!resolved || resolved.envKeys.some((key) => out.has(key))) return;
  const connection = await getDecryptedProviderKey({
    database,
    orgId,
    userId: row.creatorId,
    provider,
    secretsKey: ctx.secretsKey,
  });
  if (connection && resolved.envKeys.includes(connection.keyName)) {
    out.set(connection.keyName, connection.value);
  }
}

async function modelKeysOrThrow(ctx: AgentControlContext, model: string): Promise<string[]> {
  const resolved = await ctx.resolveModelKeys(model);
  if (!resolved) throw new AgentRuntimeError(`model ${model} is no longer available in the catalog`);
  return resolved.envKeys;
}

function buildServeEnv(serverPassword: string, secrets: Map<string, string>): ServeEnv {
  return {
    OPENCODE_SERVER_PASSWORD: serverPassword,
    OPENCODE_SERVER_USERNAME,
    ...Object.fromEntries(secrets),
  };
}

/* ------------------------------------ retry / lifecycle ----------------------------------- */

export async function retryProvision(input: {
  actor: ActorContext;
  orgId: string;
  slug: string;
  ctx: AgentControlContext;
  database?: Db;
}): Promise<{ agentId: string; attempt: number }> {
  const database = input.database ?? db;
  await assertMember(database, input.actor, input.orgId);
  const row = await loadAgentRow(database, input.orgId, input.slug);
  if (!row || !canManageAgent(input.actor.id, row)) throw new AgentValidationError("agent not found");
  if (row.lifecycle === "provisioning") throw new AgentBusyError("provisioning is already in progress");

  const previousRef: SandboxRef = {
    sandboxName: row.sandboxName ?? sandboxNameFor(input.orgId, row.slug, row.provisionAttempt),
    sandboxId: row.sandboxId,
    region: row.region,
    timeoutMs: row.timeoutMs,
  };

  const attempt = row.provisionAttempt + 1;
  const pins = (await loadPins(database, input.orgId, [row.id])).get(row.id) ?? [];
  await database
    .update(schema.agents)
    .set({
      lifecycle: "provisioning",
      provisionAttempt: attempt,
      sandboxName: sandboxNameFor(input.orgId, row.slug, attempt),
      sandboxId: null,
      sandboxDomain: null,
      provisionSteps: initialSteps(pins.map((p) => p.slug)),
      provisionError: null,
      updatedAt: new Date(),
    })
    .where(eq(schema.agents.id, row.id));

  await database.insert(schema.auditLog).values({
    orgId: input.orgId,
    actorId: input.actor.id,
    action: "agent.provision.retry",
    targetType: "agent",
    targetId: row.id,
    metadata: { slug: row.slug, attempt },
  });

  // Best-effort destroy of the previous fork happens OUTSIDE the caller's transaction, in the
  // fire-and-forget pipeline kick — return what it needs.
  void previousRef;
  return { agentId: row.id, attempt };
}

/** The sandbox ref of the CURRENT row state (used to destroy a previous fork before re-running). */
export function sandboxRefOf(row: {
  sandboxName: string | null;
  sandboxId: string | null;
  region: string;
  timeoutMs: number;
  orgId: string;
  slug: string;
  provisionAttempt: number;
}): SandboxRef {
  return {
    sandboxName: row.sandboxName ?? sandboxNameFor(row.orgId, row.slug, row.provisionAttempt),
    sandboxId: row.sandboxId,
    region: row.region,
    timeoutMs: row.timeoutMs,
  };
}

export async function setAgentSecrets(input: {
  actor: ActorContext;
  orgId: string;
  slug: string;
  secrets: Record<string, string | null>;
  ctx: AgentControlContext;
  database?: Db;
}): Promise<{ secrets: AgentSecretState[]; shouldRestart: boolean }> {
  const database = input.database ?? db;
  await assertMember(database, input.actor, input.orgId);
  const row = await loadAgentRow(database, input.orgId, input.slug);
  if (!row || !canManageAgent(input.actor.id, row)) throw new AgentValidationError("agent not found");

  for (const key of Object.keys(input.secrets)) {
    assertUnreservedSecretKey(key);
  }
  const deletions = Object.entries(input.secrets)
    .filter(([, value]) => value === null)
    .map(([key]) => key);
  const upserts = Object.entries(input.secrets).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].trim() !== "",
  );

  if (deletions.length > 0) {
    await database
      .delete(schema.agentSecrets)
      .where(
        and(
          eq(schema.agentSecrets.orgId, input.orgId),
          eq(schema.agentSecrets.agentId, row.id),
          inArray(schema.agentSecrets.key, deletions),
        ),
      );
  }
  for (const [key, value] of upserts) {
    const sealed = sealSecret({
      kek: input.ctx.secretsKey,
      plaintext: value,
      aad: agentSecretAad(input.orgId, row.id, key),
    });
    await database
      .insert(schema.agentSecrets)
      .values({
        orgId: input.orgId,
        agentId: row.id,
        key,
        wrappedDek: sealed.wrappedDek,
        ciphertext: sealed.ciphertext,
        createdBy: input.actor.id,
      })
      .onConflictDoUpdate({
        target: [schema.agentSecrets.agentId, schema.agentSecrets.key],
        set: { wrappedDek: sealed.wrappedDek, ciphertext: sealed.ciphertext, updatedAt: new Date() },
      });
  }

  await database.insert(schema.auditLog).values({
    orgId: input.orgId,
    actorId: input.actor.id,
    action: "agent.secrets.set",
    targetType: "agent",
    targetId: row.id,
    // Keys only — never values.
    metadata: { slug: row.slug, set: upserts.map(([key]) => key), removed: deletions },
  });

  const pins = (await loadPins(database, input.orgId, [row.id])).get(row.id) ?? [];
  await loadPinnedFrontmatter(database, input.orgId, pins);
  const setKeys = await loadSecretKeys(database, input.orgId, row.id);
  // A running agent already has its env baked into the serve process — the caller relaunches serve
  // (via the wake path) so the changed variables take effect.
  const shouldRestart = row.lifecycle === "ready" && !!row.sandboxDomain;
  return { secrets: secretStates(pins, setKeys), shouldRestart };
}

/**
 * Edit an existing agent's model and/or instructions after creation. Persists the change, then — if
 * the agent has a live sandbox — re-pushes the two config files (`.opencode/agents/<slug>.md` +
 * `opencode.json`, no skills) and relaunches serve so it takes effect, waking a sleeping agent to
 * apply. Runtime calls run OUTSIDE any transaction; call from a route without wrapping in withTenant.
 */
export async function updateAgentConfig(input: {
  actor: ActorContext;
  orgId: string;
  slug: string;
  patch: { model?: string; instructions?: string };
  ctx: AgentControlContext;
}): Promise<AgentDetail> {
  const { orgId, actor, ctx } = input;

  // Phase 1 (tx): validate + persist, and capture what a live re-push needs.
  const loaded = await ctx.runTenant({ orgId, userId: actor.id }, async (database) => {
    await assertMember(database, actor, orgId);
    const row = await loadAgentRow(database, orgId, input.slug);
    if (!row || !canManageAgent(actor.id, row)) throw new AgentValidationError("agent not found");

    const nextModel = input.patch.model ?? row.model;
    if (input.patch.model && input.patch.model !== row.model) {
      const keys = await ctx.resolveModelKeys(input.patch.model);
      if (!keys) throw new AgentValidationError(`model ${input.patch.model} is not available (unknown or not tool-capable)`);
    }
    const nextInstructions =
      input.patch.instructions !== undefined ? input.patch.instructions : row.instructions;

    await database
      .update(schema.agents)
      .set({ model: nextModel, instructions: nextInstructions, updatedAt: new Date() })
      .where(eq(schema.agents.id, row.id));
    await database.insert(schema.auditLog).values({
      orgId,
      actorId: actor.id,
      action: "agent.update",
      targetType: "agent",
      targetId: row.id,
      metadata: {
        slug: row.slug,
        model: input.patch.model && input.patch.model !== row.model ? nextModel : undefined,
        instructions: input.patch.instructions !== undefined ? true : undefined,
      },
    });

    const updated: AgentRow = { ...row, model: nextModel, instructions: nextInstructions };
    const secrets = await loadDecryptedSecrets(database, orgId, updated, ctx);
    return { row: updated, secrets };
  });

  // Phase 2 (no tx): push the fresh config + relaunch serve when the agent is provisioned.
  const { row, secrets } = loaded;
  if (row.lifecycle === "ready" && row.sandboxName) {
    const ref = sandboxRefOf({ ...row, orgId });
    const serverPassword = decryptServerPassword(orgId, row, ctx);
    const env = buildServeEnv(serverPassword, secrets);
    let domain = row.sandboxDomain;
    if (computeAgentStatus(row) === "sleeping" || !domain) {
      const woke = await ctx.runtime.wake({ ref, env });
      domain = woke.domain;
    }
    await ctx.runtime.pushSkills({
      ref,
      files: {
        agentSlug: row.slug,
        agentMarkdown: buildAgentMarkdown({
          slug: row.slug,
          description: firstLine(row.instructions),
          instructions: row.instructions,
          model: row.model,
        }),
        opencodeJson: buildOpencodeJson({ model: row.model }),
        skills: [],
      },
    });
    await ctx.runtime.restartServer({ ref, env, domain: domain!, password: serverPassword });
    await ctx.runTenant({ orgId, userId: actor.id }, async (database) => {
      await database
        .update(schema.agents)
        .set({ lastActiveAt: new Date(), pausedAt: null, updatedAt: new Date() })
        .where(eq(schema.agents.id, row.id));
    });
  }

  // Return the fresh detail via the injected tenant db (so tests see the fake store).
  return ctx.runTenant({ orgId, userId: actor.id }, async (database) => {
    const fresh = await loadAgentRow(database, orgId, input.slug);
    if (!fresh) throw new AgentValidationError("agent not found");
    const pins = (await loadPins(database, orgId, [fresh.id])).get(fresh.id) ?? [];
    await loadPinnedFrontmatter(database, orgId, pins);
    const setKeys = await loadSecretKeys(database, orgId, fresh.id);
    return toDetail(fresh, pins, setKeys, Date.now());
  });
}

/** Guard the runtime's own env keys — a user secret must never shadow the server password/username. */
function assertUnreservedSecretKey(key: string): void {
  if (RESERVED_AGENT_SECRET_KEYS.includes(key)) {
    throw new AgentValidationError(`the secret name ${key} is reserved by the runtime`);
  }
}

export async function destroyAgent(input: {
  actor: ActorContext;
  orgId: string;
  slug: string;
  confirm: string;
  ctx: AgentControlContext;
  database?: Db;
}): Promise<{ sandbox: SandboxRef | null }> {
  const database = input.database ?? db;
  await assertMember(database, input.actor, input.orgId);
  const row = await loadAgentRow(database, input.orgId, input.slug);
  if (!row || !canManageAgent(input.actor.id, row)) throw new AgentValidationError("agent not found");
  if (input.confirm.trim() !== row.slug) {
    throw new AgentValidationError("confirmation does not match the agent name");
  }

  await database.delete(schema.agents).where(eq(schema.agents.id, row.id)); // cascades pins + secrets
  await database.insert(schema.auditLog).values({
    orgId: input.orgId,
    actorId: input.actor.id,
    action: "agent.destroy",
    targetType: "agent",
    targetId: row.id,
    metadata: { slug: row.slug },
  });

  // The route destroys the sandbox best-effort AFTER the transaction commits.
  return { sandbox: row.sandboxName ? sandboxRefOf({ ...row, orgId: input.orgId }) : null };
}

export async function pauseAgent(input: {
  actor: ActorContext;
  orgId: string;
  slug: string;
  database?: Db;
}): Promise<{ sandbox: SandboxRef | null }> {
  const database = input.database ?? db;
  await assertMember(database, input.actor, input.orgId);
  const row = await loadAgentRow(database, input.orgId, input.slug);
  if (!row || !canManageAgent(input.actor.id, row)) throw new AgentValidationError("agent not found");
  if (row.lifecycle !== "ready") throw new AgentValidationError("agent is not ready");

  await database
    .update(schema.agents)
    .set({ pausedAt: new Date(), updatedAt: new Date() })
    .where(eq(schema.agents.id, row.id));
  await database.insert(schema.auditLog).values({
    orgId: input.orgId,
    actorId: input.actor.id,
    action: "agent.pause",
    targetType: "agent",
    targetId: row.id,
    metadata: { slug: row.slug },
  });
  return { sandbox: row.sandboxName ? sandboxRefOf({ ...row, orgId: input.orgId }) : null };
}

/**
 * Wake: resume the sandbox + relaunch serve with a freshly decrypted env, measure the latency.
 * Runs runtime calls OUTSIDE any transaction; call from routes without wrapping in withTenant.
 */
export async function wakeAgent(input: {
  actor: ActorContext;
  orgId: string;
  slug: string;
  ctx: AgentControlContext;
}): Promise<{ resumeMs: number; status: AgentStatus }> {
  const loaded = await input.ctx.runTenant({ orgId: input.orgId, userId: input.actor.id }, async (database) => {
    await assertMember(database, input.actor, input.orgId);
    const row = await loadAgentRow(database, input.orgId, input.slug);
    if (!row || !canManageAgent(input.actor.id, row)) throw new AgentValidationError("agent not found");
    if (row.lifecycle !== "ready") throw new AgentValidationError("agent is not ready");
    const secrets = await loadDecryptedSecrets(database, input.orgId, row, input.ctx);
    return { row, secrets };
  });

  const { row, secrets } = loaded;
  const serverPassword = decryptServerPassword(input.orgId, row, input.ctx);
  const env = buildServeEnv(serverPassword, secrets);
  const woke = await input.ctx.runtime.wake({ ref: sandboxRefOf({ ...row, orgId: input.orgId }), env });
  await input.ctx.runtime.healthCheck({
    ref: sandboxRefOf({ ...row, orgId: input.orgId }),
    domain: woke.domain,
    password: serverPassword,
  });

  await input.ctx.runTenant({ orgId: input.orgId, userId: input.actor.id }, async (database) => {
    await database
      .update(schema.agents)
      .set({
        lastActiveAt: new Date(),
        pausedAt: null,
        sandboxDomain: woke.domain,
        lastResumeMs: woke.resumeMs,
        updatedAt: new Date(),
      })
      .where(eq(schema.agents.id, row.id));
  });

  return { resumeMs: woke.resumeMs, status: "running" };
}

/* ------------------------------------ skill updates --------------------------------------- */

export async function listAffectedAgents(input: {
  actor: ActorContext;
  orgId: string;
  skillSlug: string;
  database?: Db;
}): Promise<AffectedAgentsResponse | null> {
  const database = input.database ?? db;
  await assertMember(database, input.actor, input.orgId);

  const skillRows = await database
    .select({
      id: schema.skills.id,
      slug: schema.skills.slug,
      currentVersion: schema.skillVersions.version,
      frontmatter: schema.skillVersions.frontmatter,
      releasedAt: schema.skillVersions.createdAt,
    })
    .from(schema.skills)
    .leftJoin(schema.skillVersions, eq(schema.skills.currentVersionId, schema.skillVersions.id))
    .where(and(eq(schema.skills.orgId, input.orgId), eq(schema.skills.slug, input.skillSlug)));
  const skill = skillRows[0];
  if (!skill || !skill.currentVersion) return null;

  const pinRows = await database
    .select({ pin: schema.agentSkills })
    .from(schema.agentSkills)
    .where(and(eq(schema.agentSkills.orgId, input.orgId), eq(schema.agentSkills.skillId, skill.id)));
  const agentIds = pinRows.map((r) => r.pin.agentId);
  const agents =
    agentIds.length === 0
      ? []
      : await database
          .select()
          .from(schema.agents)
          .where(and(eq(schema.agents.orgId, input.orgId), inArray(schema.agents.id, agentIds)));

  const now = Date.now();
  const affected = agents
    .filter((row) => canAccessAgent(input.actor.id, row))
    .map((row) => ({
      row,
      pinned: pinRows.find((r) => r.pin.agentId === row.id)?.pin.version ?? "?",
    }))
    .filter(({ pinned }) => pinned !== skill.currentVersion)
    .map(({ row, pinned }) => ({
      id: row.id,
      slug: row.slug,
      scope: row.scope,
      status: computeAgentStatus(row, now),
      pinned_version: pinned,
    }))
    .sort((a, b) => a.slug.localeCompare(b.slug));

  return {
    skill: {
      id: skill.id,
      slug: skill.slug,
      latest_version: skill.currentVersion,
      released_at: skill.releasedAt?.toISOString() ?? null,
      description: descriptionFromFrontmatter(skill.frontmatter),
      changelog: changelogFromFrontmatter(skill.frontmatter),
    },
    agents: affected,
  };
}

function descriptionFromFrontmatter(frontmatter: string | null): string {
  if (!frontmatter) return "";
  return parseStoredSkillFrontmatter(frontmatter)?.description ?? "";
}

/** Best-effort "What changed" bullets from the version's companion.json changelog. */
function changelogFromFrontmatter(frontmatter: string | null): string[] {
  if (!frontmatter) return [];
  try {
    const raw = JSON.parse(frontmatter) as { companion?: unknown };
    if (!raw.companion) return [];
    const parsed = companionManifestSchema.safeParse(raw.companion);
    if (!parsed.success) return [];
    const top = parsed.data.metadata.changelog?.[0];
    return (top?.changes ?? []).slice(0, 6);
  } catch {
    return [];
  }
}

/**
 * Push one skill's current (or given) version to one agent. Sets `pending_op` (the 409 concurrency
 * guard) and returns immediately-persistable state; the actual runtime work runs in
 * {@link runSkillPush}, kicked fire-and-forget by the route.
 */
export async function pushSkillUpdate(input: {
  actor: ActorContext;
  orgId: string;
  slug: string;
  skillSlug: string;
  toVersion?: string;
  database?: Db;
}): Promise<{ agentId: string; op: AgentPendingOp }> {
  const database = input.database ?? db;
  await assertMember(database, input.actor, input.orgId);
  const row = await loadAgentRow(database, input.orgId, input.slug);
  if (!row || !canManageAgent(input.actor.id, row)) throw new AgentValidationError("agent not found");
  if (row.lifecycle !== "ready") throw new AgentValidationError("agent is not ready");
  if (row.pendingOp && (row.pendingOp as AgentPendingOp).phase !== "updated" && (row.pendingOp as AgentPendingOp).phase !== "failed") {
    throw new AgentBusyError("another operation is in flight for this agent");
  }

  const pins = (await loadPins(database, input.orgId, [row.id])).get(row.id) ?? [];
  const pin = pins.find((p) => p.slug === input.skillSlug);
  if (!pin) throw new AgentValidationError(`agent does not run ${input.skillSlug}`);
  const target = input.toVersion ?? pin.currentVersion;
  if (!target) throw new AgentValidationError(`${input.skillSlug} has no published version`);

  const op: AgentPendingOp = {
    kind: "skill-push",
    skill_slug: input.skillSlug,
    from_version: pin.pin.version,
    to_version: target,
    phase: "pushing",
    error: null,
    started_at: new Date().toISOString(),
  };
  await database
    .update(schema.agents)
    .set({ pendingOp: op, updatedAt: new Date() })
    .where(eq(schema.agents.id, row.id));
  await database.insert(schema.auditLog).values({
    orgId: input.orgId,
    actorId: input.actor.id,
    action: "agent.skill.push",
    targetType: "agent",
    targetId: row.id,
    metadata: { slug: row.slug, skill: input.skillSlug, from: pin.pin.version, to: target },
  });
  return { agentId: row.id, op };
}

/**
 * The runtime half of a skill push (fire-and-forget): wake if sleeping, replace the folder,
 * restart the server, then persist the new pin. Phases land in `pending_op` for the UI to poll.
 */
export async function runSkillPush(input: {
  orgId: string;
  actorId: string;
  agentId: string;
  skillSlug: string;
  toVersion: string;
  ctx: AgentControlContext;
}): Promise<void> {
  const { orgId, actorId, agentId, ctx } = input;

  const setPhase = async (phase: AgentPendingOp["phase"], error: string | null = null, alsoPin = false) => {
    await ctx.runTenant({ orgId, userId: actorId }, async (database) => {
      const rows = await database.select().from(schema.agents).where(eq(schema.agents.id, agentId));
      const current = rows[0];
      if (!current?.pendingOp) return;
      const op = { ...(current.pendingOp as AgentPendingOp), phase, error };
      await database
        .update(schema.agents)
        .set({ pendingOp: op, updatedAt: new Date() })
        .where(eq(schema.agents.id, agentId));
      if (alsoPin) {
        await database
          .update(schema.agentSkills)
          .set({ version: input.toVersion, pushedAt: new Date() })
          .where(
            and(
              eq(schema.agentSkills.orgId, orgId),
              eq(schema.agentSkills.agentId, agentId),
              inArray(
                schema.agentSkills.skillId,
                (
                  await database
                    .select({ id: schema.skills.id })
                    .from(schema.skills)
                    .where(and(eq(schema.skills.orgId, orgId), eq(schema.skills.slug, input.skillSlug)))
                ).map((r) => r.id),
              ),
            ),
          );
      }
    });
  };

  try {
    const loaded = await ctx.runTenant({ orgId, userId: actorId }, async (database) => {
      const rows = await database.select().from(schema.agents).where(eq(schema.agents.id, agentId));
      const row = rows[0];
      if (!row) throw new AgentValidationError("agent not found");
      const pins = (await loadPins(database, orgId, [row.id])).get(row.id) ?? [];
      const targetPin = pins.find((p) => p.slug === input.skillSlug);
      if (!targetPin) throw new AgentValidationError(`agent does not run ${input.skillSlug}`);
      // Load the TARGET version's storage path (not the pinned one).
      const versionRows = await database
        .select({
          version: schema.skillVersions.version,
          storagePath: schema.skillVersions.storagePath,
        })
        .from(schema.skillVersions)
        .where(and(eq(schema.skillVersions.orgId, orgId), eq(schema.skillVersions.skillId, targetPin.pin.skillId)));
      const target = versionRows.find((v) => v.version === input.toVersion);
      if (!target) throw new AgentValidationError(`${input.skillSlug}@${input.toVersion} is not published`);
      const secrets = await loadDecryptedSecrets(database, orgId, row, ctx);
      return { row, secrets, storagePath: target.storagePath };
    });

    const { row, secrets, storagePath } = loaded;
    const ref = sandboxRefOf({ ...row, orgId });
    const serverPassword = decryptServerPassword(orgId, row, ctx);
    const env = buildServeEnv(serverPassword, secrets);

    // Sleeping agents wake to update (the design's "sleeping · wakes to update").
    let domain = row.sandboxDomain;
    if (computeAgentStatus(row) === "sleeping") {
      const woke = await ctx.runtime.wake({ ref, env });
      domain = woke.domain;
    }
    if (!domain) throw new AgentRuntimeError("agent has no sandbox domain");

    const archive = await ctx.fetchArchive(storagePath);
    const { toTar, extractArchiveEntryBuffers, inspectTar } = await import("@companion/skills");
    const tar = toTar(archive);
    const finding = await inspectTar(tar);
    if (finding.violations.length > 0 || finding.oversize) {
      throw new AgentRuntimeError(`${input.skillSlug}@${input.toVersion}: archive failed safety checks`);
    }
    const extracted = await extractArchiveEntryBuffers(tar);
    // Same post-extraction gate the provisioning path enforces — never ship a violating/oversized
    // archive into a sandbox, even one that slipped past inspectTar.
    if (extracted.violations.length > 0 || extracted.oversize) {
      throw new AgentRuntimeError(`${input.skillSlug}@${input.toVersion}: archive failed safety checks`);
    }
    const skillMdPath = extracted.files.find((f) => f.path.split("/").pop() === "SKILL.md")?.path ?? "SKILL.md";
    const root = skillMdPath.includes("/") ? skillMdPath.slice(0, skillMdPath.lastIndexOf("/") + 1) : "";
    await ctx.runtime.replaceSkill({
      ref,
      skill: {
        slug: input.skillSlug,
        version: input.toVersion,
        files: extracted.files
          .filter((f) => (root ? f.path.startsWith(root) : true))
          .map((f) => ({ path: root ? f.path.slice(root.length) : f.path, data: f.data, executable: f.executable })),
      },
    });

    await setPhase("restarting");
    await ctx.runtime.restartServer({ ref, env, domain, password: serverPassword });
    await setPhase("updated", null, true);
    await ctx.runTenant({ orgId, userId: actorId }, async (database) => {
      await database
        .update(schema.agents)
        .set({ lastActiveAt: new Date(), pausedAt: null, updatedAt: new Date() })
        .where(eq(schema.agents.id, agentId));
    });
  } catch (error) {
    await setPhase("failed", error instanceof Error ? error.message : String(error));
  }
}

/* ------------------------------------ chat support ----------------------------------------- */

export async function touchAgentActivity(input: {
  orgId: string;
  actorId: string;
  agentId: string;
  runTenant?: TenantRunner;
}): Promise<void> {
  const runTenant = input.runTenant ?? withTenantContext;
  await runTenant({ orgId: input.orgId, userId: input.actorId }, async (database) => {
    await database
      .update(schema.agents)
      .set({ lastActiveAt: new Date(), pausedAt: null, updatedAt: new Date() })
      .where(eq(schema.agents.id, input.agentId));
  });
}

const SESSIONS_CACHE_CAP = 10;

export async function updateAgentSessionsCache(input: {
  orgId: string;
  actorId: string;
  agentId: string;
  session: AgentSessionSummary;
  runTenant?: TenantRunner;
}): Promise<void> {
  const runTenant = input.runTenant ?? withTenantContext;
  await runTenant({ orgId: input.orgId, userId: input.actorId }, async (database) => {
    const rows = await database.select().from(schema.agents).where(eq(schema.agents.id, input.agentId));
    const row = rows[0];
    if (!row) return;
    const cache = (row.sessionsCache as AgentSessionSummary[]).filter((s) => s.id !== input.session.id);
    cache.unshift(input.session);
    await database
      .update(schema.agents)
      .set({ sessionsCache: cache.slice(0, SESSIONS_CACHE_CAP), updatedAt: new Date() })
      .where(eq(schema.agents.id, input.agentId));
  });
}

/** Chat proxy target: domain + decrypted basic-auth password. NEVER serialize into a response. */
export async function getAgentChatTarget(input: {
  actor: ActorContext;
  orgId: string;
  slug: string;
  ctx: AgentControlContext;
  database?: Db;
}): Promise<{ agentId: string; slug: string; domain: string; password: string; status: AgentStatus; sandbox: SandboxRef }> {
  const database = input.database ?? db;
  await assertMember(database, input.actor, input.orgId);
  const row = await loadAgentRow(database, input.orgId, input.slug);
  if (!row || !canAccessAgent(input.actor.id, row)) throw new AgentValidationError("agent not found");
  if (row.lifecycle !== "ready") throw new AgentValidationError("agent is not ready");
  if (!row.sandboxDomain) throw new AgentValidationError("agent has no sandbox domain");
  return {
    agentId: row.id,
    slug: row.slug,
    domain: row.sandboxDomain,
    password: decryptServerPassword(input.orgId, row, input.ctx),
    status: computeAgentStatus(row),
    sandbox: sandboxRefOf({ ...row, orgId: input.orgId }),
  };
}

/** Slim provisioning progress for the polling screen. */
export async function getProvisionProgress(input: {
  actor: ActorContext;
  orgId: string;
  slug: string;
  database?: Db;
}): Promise<ProvisionProgress | null> {
  const database = input.database ?? db;
  await assertMember(database, input.actor, input.orgId);
  const row = await loadAgentRow(database, input.orgId, input.slug);
  if (!row || !canAccessAgent(input.actor.id, row)) return null;
  return {
    lifecycle: row.lifecycle,
    status: computeAgentStatus(row),
    attempt: row.provisionAttempt,
    steps: row.provisionSteps as ProvisionStep[],
    error: (row.provisionError as ProvisionError | null) ?? null,
  };
}

/**
 * Crash recovery: a row still `provisioning` with NO live in-process job means the control plane
 * restarted (or the job died) mid-pipeline. Flip it to the designed error state so the UI offers
 * the normal fresh-fork retry (safe by construction — attempt-keyed sandbox names).
 */
export async function markProvisionInterrupted(input: {
  actor: ActorContext;
  orgId: string;
  slug: string;
  database?: Db;
}): Promise<void> {
  const database = input.database ?? db;
  await assertMember(database, input.actor, input.orgId);
  const row = await loadAgentRow(database, input.orgId, input.slug);
  if (!row || row.lifecycle !== "provisioning") return;
  const steps = (row.provisionSteps as ProvisionStep[]).map((step) =>
    step.state === "running" ? { ...step, state: "failed" as const } : step,
  );
  await database
    .update(schema.agents)
    .set({
      lifecycle: "error",
      provisionSteps: steps,
      provisionError: {
        message: "Error: provisioning was interrupted (control plane restarted)",
        sandbox_name: row.sandboxName,
        region: row.region,
        step: steps.find((s) => s.state === "failed")?.key ?? null,
        exit_code: null,
        detail: "No provisioning job is running for this agent. Retry provisions a fresh fork.",
      },
      updatedAt: new Date(),
    })
    .where(eq(schema.agents.id, row.id));
}
