import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { Context, Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import {
  COMPANION_PLUGIN_OAUTH_SERVERS,
  CompanionNotFoundError,
  CompanionDeleteForbiddenError,
  CompanionDuplicateForbiddenError,
  CompanionPluginConflictError,
  CompanionPluginOAuthError,
  CompanionProviderOAuthError,
  COMPANION_PROVIDER_OAUTH_TTL_MS,
  beginAnthropicProviderOAuth,
  beginOpenAICodexProviderOAuth,
  beginCompanionPluginOAuth,
  completeAnthropicProviderOAuth,
  completeCompanionPluginOAuth,
  decryptOpaqueValue,
  encryptOpaqueValue,
  loadSecretsMasterKey,
  type OpaqueCiphertext,
  CompanionProviderError,
  CompanionProviderForbiddenError,
  CompanionRuntimeForbiddenError,
  CompanionRuntimeTransitionError,
  CompanionDecisionConflictError,
  CompanionDecisionNotFoundError,
  CompanionShareForbiddenError,
  CompanionSettingsForbiddenError,
  CompanionSkillSelectionError,
  CompanionPluginSelectionError,
  CompanionWriteSkillsForbiddenError,
  COMPANION_RUNTIME_START_BUDGET_MS,
  attachCompanionToolRunScreenshot,
  claimCompanionRuntimeStart,
  claimCompanionRuntimeStop,
  claimCompanionDeletion,
  companionsAvailableToUser,
  companionsEnabled,
  companionToolRunIsVisual,
  createCompanion,
  decideCompanionDecision,
  deleteCompanion,
  deleteCompanionPlugin,
  deleteCompanionProvider,
  duplicateCompanion,
  expireCompanionDecisions,
  expireCompanionToolRuns,
  getCompanion,
  getCompanionProviderCredentialGeneration,
  getCompanionForRuntime,
  getCompanionThread,
  listCompanionShares,
  listCompanionRuntimeSkillPackages,
  listCompanions,
  listCompanionProviders,
  listCompanionPlugins,
  listOnlineCompanionsForSkillSync,
  listPendingCompanionMessages,
  markCompanionThreadRead,
  projectCompanionPiEvents,
  pollOpenAICodexProviderOAuth,
  recordCompanionTimeoutRestart,
  recordCompanionPiProjectionWithEffects,
  resolveCompanionProviderAuth,
  resolveCompanionPluginInjection,
  saveCompanionProvider,
  saveCompanionPlugin,
  saveCompanionOAuthPlugin,
  sendCompanionMessage,
  setCompanionProvider,
  setCompanionWorkspaceShare,
  setDefaultCompanionProvider,
  updateCompanionObservation,
  updateCompanion,
  updateCompanionMemberState,
  updateCompanionRuntime,
} from "@companion/core";
import { issueApiToken } from "@companion/core/services";
import type {
  CompanionPiEntry,
  CompanionPiProjectionResult,
  CompanionPiToolCompletion,
  CompanionSettledToolRun,
} from "@companion/core";
import {
  createCompanionInputSchema,
  companionProviderIdSchema,
  companionProviderOAuthCompleteInputSchema,
  companionProviderOAuthStartInputSchema,
  companionPluginOAuthStartInputSchema,
  decideCompanionDecisionInputSchema,
  saveCompanionProviderInputSchema,
  sendCompanionMessageInputSchema,
  setCompanionProviderInputSchema,
  setCompanionWorkspaceShareInputSchema,
  setDefaultCompanionProviderInputSchema,
  startCompanionRuntimeInputSchema,
  saveCompanionPluginInputSchema,
  updateCompanionInputSchema,
  updateCompanionMemberStateInputSchema,
} from "@companion/contracts";
import { restartCompanionRuntimeInputSchema } from "@companion/contracts/companion-runtime";
import type {
  Companion,
  CompanionDesktop,
  CompanionThread,
  CompanionTranscriptEntry,
  StartCompanionRuntimeInput,
} from "@companion/contracts";
import { withTenantContext, schema, type Db } from "@companion/db";
import { packDir, skillChecksum, toTar } from "@companion/skills";
import { COMPANION_SKILL_KEY, companionSkillDir } from "@companion/companion-skill";
import { getSkillArchive } from "@companion/storage";
import { eq } from "drizzle-orm";
import { getCompanionSkillPackage } from "./companionSkillPackage";
import {
  actorFromContext,
  AuthenticationRequiredError,
  jsonError,
  orgIdFromContext,
  type ApiVariables,
} from "./context";
import {
  AsciiBoxCompanionRuntime,
  BoxRuntimeConfigurationError,
  BoxRuntimeProviderError,
  COMPANION_PI_DISK_LAYOUT_VERSION,
  type CompanionBoxRuntime,
} from "./boxCompanionRuntime";
import {
  CompanionRuntimeStartBudgetError,
  companionRuntimeErrorMessage,
  isBoxRuntimeFailure,
} from "./companionRuntimeError";

const companionIdSchema = z.string().uuid();
const COMPANION_PLUGIN_OAUTH_FLOW_PURPOSE = "companion-mcp-oauth-flow";
const COMPANION_PLUGIN_OAUTH_TTL_MS = 10 * 60_000;
const COMPANION_PROVIDER_OAUTH_FLOW_PURPOSE = "companion-provider-oauth-flow";
const COMPANION_PROVIDER_OAUTH_COOKIE = "companion_provider_oauth";

type CompanionPluginOAuthState = {
  orgId: string;
  userId: string;
  nonce: string;
  expiresAt: number;
};

function companionPluginOAuthRedirectUri(env: NodeJS.ProcessEnv): string {
  const base = env.COMPANION_WEB_URL ?? "http://127.0.0.1:3000";
  return new URL("/v1/companion-plugins/oauth/callback", base).toString();
}

function companionPluginOAuthCookieName(nonce: string): string {
  return `companion_mcp_oauth_${nonce.replaceAll("-", "")}`;
}

function signCompanionPluginOAuthState(
  payload: CompanionPluginOAuthState,
  masterKey: Buffer,
): string {
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = createHmac("sha256", masterKey).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
}

function verifyCompanionPluginOAuthState(
  value: string,
  masterKey: Buffer,
): CompanionPluginOAuthState {
  const [encoded, signature] = value.split(".");
  if (!encoded || !signature) throw new Error("invalid OAuth state");
  const expected = createHmac("sha256", masterKey).update(encoded).digest();
  const actual = Buffer.from(signature, "base64url");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new Error("invalid OAuth state");
  }
  const parsed = JSON.parse(
    Buffer.from(encoded, "base64url").toString("utf8"),
  ) as CompanionPluginOAuthState;
  if (
    !parsed.orgId
    || !parsed.userId
    || !parsed.nonce
    || parsed.expiresAt < Date.now()
  ) {
    throw new Error("expired OAuth state");
  }
  return parsed;
}

function encodeCompanionPluginOAuthFlow(input: {
  orgId: string;
  nonce: string;
  value: unknown;
  masterKey: Buffer;
}): string {
  const encrypted = encryptOpaqueValue({
    orgId: input.orgId,
    purpose: COMPANION_PLUGIN_OAUTH_FLOW_PURPOSE,
    subjectId: input.nonce,
    value: JSON.stringify(input.value),
  }, input.masterKey);
  return Buffer.from(JSON.stringify(encrypted), "utf8").toString("base64url");
}

function decodeCompanionPluginOAuthFlow(input: {
  orgId: string;
  nonce: string;
  value: string;
  masterKey: Buffer;
}): { label: string; flow: Awaited<ReturnType<typeof beginCompanionPluginOAuth>>["flow"] } {
  const encrypted = JSON.parse(
    Buffer.from(input.value, "base64url").toString("utf8"),
  ) as OpaqueCiphertext;
  const plaintext = decryptOpaqueValue({
    orgId: input.orgId,
    purpose: COMPANION_PLUGIN_OAUTH_FLOW_PURPOSE,
    subjectId: input.nonce,
    ...encrypted,
  }, input.masterKey);
  return JSON.parse(plaintext) as {
    label: string;
    flow: Awaited<ReturnType<typeof beginCompanionPluginOAuth>>["flow"];
  };
}

type CompanionProviderOAuthCookie = {
  orgId: string;
  nonce: string;
  encrypted: OpaqueCiphertext;
};

function encodeCompanionProviderOAuthFlow(input: {
  orgId: string;
  userId: string;
  flow:
    | ReturnType<typeof beginAnthropicProviderOAuth>["flow"]
    | Awaited<ReturnType<typeof beginOpenAICodexProviderOAuth>>["flow"];
  masterKey: Buffer;
}): string {
  const nonce = randomUUID();
  const encrypted = encryptOpaqueValue({
    orgId: input.orgId,
    purpose: COMPANION_PROVIDER_OAUTH_FLOW_PURPOSE,
    subjectId: nonce,
    value: JSON.stringify({ userId: input.userId, flow: input.flow }),
  }, input.masterKey);
  return Buffer.from(JSON.stringify({ orgId: input.orgId, nonce, encrypted }), "utf8")
    .toString("base64url");
}

function decodeCompanionProviderOAuthFlow(input: {
  value: string;
  masterKey: Buffer;
}): {
  orgId: string;
  userId: string;
  flow:
    | ReturnType<typeof beginAnthropicProviderOAuth>["flow"]
    | Awaited<ReturnType<typeof beginOpenAICodexProviderOAuth>>["flow"];
} {
  const cookie = JSON.parse(
    Buffer.from(input.value, "base64url").toString("utf8"),
  ) as CompanionProviderOAuthCookie;
  const plaintext = decryptOpaqueValue({
    orgId: cookie.orgId,
    purpose: COMPANION_PROVIDER_OAUTH_FLOW_PURPOSE,
    subjectId: cookie.nonce,
    ...cookie.encrypted,
  }, input.masterKey);
  const pending = JSON.parse(plaintext) as {
    userId: string;
    flow:
      | ReturnType<typeof beginAnthropicProviderOAuth>["flow"]
      | Awaited<ReturnType<typeof beginOpenAICodexProviderOAuth>>["flow"];
  };
  if (!pending.userId || !pending.flow || pending.flow.expiresAt < Date.now()) {
    throw new CompanionProviderOAuthError("oauth_expired", "Provider sign-in expired. Start again.");
  }
  return { orgId: cookie.orgId, ...pending };
}

type RuntimeFactory = () => CompanionBoxRuntime;

class CompanionAccessForbiddenError extends Error {
  constructor() {
    super("Companions access is not available for this user");
    this.name = "CompanionAccessForbiddenError";
  }
}

function errorStatus(error: unknown): number {
  if (error instanceof AuthenticationRequiredError) return 401;
  if (error instanceof CompanionAccessForbiddenError) return 403;
  if (error instanceof CompanionNotFoundError) return 404;
  if (error instanceof CompanionDecisionNotFoundError) return 404;
  if (error instanceof CompanionDecisionConflictError) return 409;
  if (error instanceof CompanionRuntimeForbiddenError) return 403;
  if (error instanceof CompanionSettingsForbiddenError) return 403;
  if (error instanceof CompanionSkillSelectionError) return 400;
  if (error instanceof CompanionPluginSelectionError) return 400;
  if (error instanceof CompanionWriteSkillsForbiddenError) return 403;
  if (error instanceof CompanionDeleteForbiddenError) return 403;
  if (error instanceof CompanionDuplicateForbiddenError) return 403;
  if (error instanceof CompanionProviderForbiddenError) return 403;
  if (error instanceof CompanionShareForbiddenError) return 403;
  if (error instanceof CompanionProviderError) return 422;
  if (error instanceof CompanionRuntimeTransitionError) return 409;
  if (error instanceof CompanionPluginConflictError) return 409;
  if (error instanceof CompanionPluginOAuthError) {
    if (error.code === "oauth_not_supported") return 400;
    if (error.code === "oauth_not_configured") return 503;
    return 502;
  }
  if (error instanceof CompanionProviderOAuthError) {
    return error.code === "oauth_unavailable" ? 502 : 400;
  }
  if (error instanceof CompanionRuntimeStartBudgetError) return 504;
  if (error instanceof BoxRuntimeConfigurationError) return 503;
  if (error instanceof BoxRuntimeProviderError) {
    if (error.status === 409) return 409;
    if (error.status === 504) return 504;
    return 502;
  }
  if (error instanceof z.ZodError) return 400;
  return 400;
}

/**
 * One wake's deadline. Each step of a start bounds itself, but their sum did not, so a step that
 * hung — an object-storage read with no timeout of its own, a Box call that never answered — kept the
 * `provisioning` claim it had already written and recorded no reason for it. This is the clock that
 * ends such a wake: the signal cancels whatever it is waiting on, and `aborted` is how a callback
 * that outlived it knows it no longer owns the lifecycle.
 *
 * The timer is an ordinary cleared one rather than `AbortSignal.timeout`, so a wake that finished in
 * a second does not leave a three-minute timer holding the process awake behind it.
 */
function startBudget(): { signal: AbortSignal; release: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new CompanionRuntimeStartBudgetError(COMPANION_RUNTIME_START_BUDGET_MS)),
    COMPANION_RUNTIME_START_BUDGET_MS,
  );
  timer.unref?.();
  return { signal: controller.signal, release: () => clearTimeout(timer) };
}

/**
 * Fail this step as soon as the wake's budget does, whatever the step is waiting on. `Promise.race`
 * subscribes to both sides, so an abort that arrives after the wake already settled rejects a
 * promise that is still handled rather than surfacing as an unhandled rejection.
 */
function withinBudget<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  const expiry = new Promise<never>((_resolve, reject) => {
    const fail = () => reject(signal.reason);
    if (signal.aborted) fail();
    else signal.addEventListener("abort", fail, { once: true });
  });
  return Promise.race([work, expiry]);
}

/** Thread sync observes the control-plane projection and never wakes an unreachable Pi. */
function piIsReachable(companion: Companion): boolean {
  return Boolean(companion.runtime.box_id)
    && companion.runtime.state === "running"
    && companion.runtime.daemon_state === "running";
}

function providerAuthIsCurrent(
  companion: Companion,
  current: { providerId: string | null; credentialGeneration: string | null } | null,
): boolean {
  return current !== null
    && current.credentialGeneration !== null
    && current.providerId === companion.runtime.provider_ids[0]
    && current.credentialGeneration === companion.runtime.provider_credential_generation;
}

function recordProjection(input: {
  actor: ReturnType<typeof actorFromContext>;
  orgId: string;
  companionId: string;
  entries: CompanionPiEntry[];
  toolCompletions?: CompanionPiToolCompletion[];
  piLogOffset?: number;
  piLogRewound?: boolean;
  deliveredOrdinal?: number;
  timeoutDeliveryOrdinal?: number;
}): Promise<CompanionPiProjectionResult> {
  return withTenantContext(
    { orgId: input.orgId, userId: input.actor.id },
    (database) => recordCompanionPiProjectionWithEffects({ ...input, database }),
  );
}

/**
 * Give the visual run this sync just finished one picture of the Box desktop.
 *
 * Only exact run ids whose settlement won in this sync are offered a frame. One desktop capture can
 * satisfy several visual calls projected from the same Pi chunk, while the database guard keeps
 * every run at one immutable frame. Everything here is best-effort — no desktop, no capture tool, a
 * Box that stopped answering, a frame too large — because the transcript this sync already stored is
 * the thing that mattered, and a run without a picture is still a run.
 */
async function attachDesktopFrames(input: {
  actor: ReturnType<typeof actorFromContext>;
  orgId: string;
  companionId: string;
  boxId: string;
  runtime: CompanionBoxRuntime;
  eventIds: string[];
  desktopAvailable: boolean;
}): Promise<CompanionThread | null> {
  if (!input.desktopAvailable || !input.eventIds.length) return null;
  const frame = await input.runtime.captureDesktopFrame({ boxId: input.boxId }).catch(() => null);
  if (!frame) return null;
  let thread: CompanionThread | null = null;
  for (const eventId of [...new Set(input.eventIds)]) {
    thread = await withTenantContext(
      { orgId: input.orgId, userId: input.actor.id },
      (database) => attachCompanionToolRunScreenshot({
        actor: input.actor,
        orgId: input.orgId,
        companionId: input.companionId,
        eventId,
        screenshot: frame,
        database,
      }),
    ).catch(() => thread);
  }
  return thread;
}

/**
 * Hand persisted messages to Pi in order and record how far delivery reached. A refusal is not an
 * error for the caller: the message is already durable, so the next sync retries it. The watermark
 * only ever advances to a message Pi accepted, so an undelivered tail stays pending.
 */
async function deliverCompanionMessages(input: {
  actor: ReturnType<typeof actorFromContext>;
  orgId: string;
  companionId: string;
  boxId: string;
  messages: CompanionTranscriptEntry[];
  runtime: CompanionBoxRuntime;
  /** This delivery is protected by an unanswered timeout until each accepted ordinal is recorded. */
  timeoutRecoveryPending?: boolean;
}): Promise<{ thread: CompanionThread; deliveredOrdinal: number } | null> {
  let deliveredOrdinal: number | undefined;
  try {
    for (const message of input.messages) {
      await input.runtime.prompt({
        boxId: input.boxId,
        message: message.content,
        requestId: message.event_id,
      });
      deliveredOrdinal = message.ordinal;
    }
  } catch {
    // Leave the undelivered tail pending instead of losing it or failing the persisted send.
  }
  if (deliveredOrdinal === undefined) return null;
  const { thread } = await recordProjection({
    actor: input.actor,
    orgId: input.orgId,
    companionId: input.companionId,
    entries: [],
    deliveredOrdinal,
    timeoutDeliveryOrdinal: input.timeoutRecoveryPending ? deliveredOrdinal : undefined,
  });
  // Move the Box idle clock only after Pi accepted at least one durable message. A failed prompt
  // remains pending and therefore cannot lengthen the machine's lifetime.
  await input.runtime.refreshTtl({ boxId: input.boxId }).catch(() => undefined);
  return { thread, deliveredOrdinal };
}

function routeError(c: Context, error: unknown): Response {
  if (error instanceof CompanionProviderError) {
    return c.json({
      ok: false,
      error: error.message,
      code: error.code,
      provider_id: error.providerId,
    }, errorStatus(error) as never);
  }
  return jsonError(c, error, errorStatus(error));
}

/**
 * A lifecycle failure the caller can act on. Configuration and Box/Pi failures answer with the same
 * sanitized line the Companion row keeps, so a red status always comes with its reason; anything
 * else stays on the generic error path rather than returning internal text.
 */
function runtimeRouteError(c: Context, error: unknown): Response {
  if (!isBoxRuntimeFailure(error)) return routeError(c, error);
  const code = error instanceof BoxRuntimeProviderError ? error.code : undefined;
  return c.json({
    ok: false,
    error: companionRuntimeErrorMessage(error),
    ...(code ? { code } : {}),
  }, errorStatus(error) as never);
}

export function registerCompanionRoutes(
  app: Hono<{ Variables: ApiVariables }>,
  env: NodeJS.ProcessEnv = process.env,
  runtimeFactory: RuntimeFactory = () => new AsciiBoxCompanionRuntime(env),
): void {
  if (!companionsEnabled(env)) return;

  async function tenant<T>(
    c: Context<{ Variables: ApiVariables }>,
    fn: (input: {
      actor: ReturnType<typeof actorFromContext>;
      orgId: string;
      database: Db;
    }) => Promise<T>,
  ): Promise<T> {
    const actor = actorFromContext(c);
    if (!companionsAvailableToUser(actor.email, env)) {
      throw new CompanionAccessForbiddenError();
    }
    const orgId = await orgIdFromContext(c);
    return withTenantContext({ orgId, userId: actor.id }, (database) =>
      fn({ actor, orgId, database }));
  }

  /**
   * Claim and start one Companion through the same lifecycle path for an explicit Wake or a
   * persisted message. The Box adapter owns the warm decision, so an already-active layout-6 Pi
   * returns before resource injection or any systemd start.
   *
   * The claim is written before any of that work, so every step after it runs under one budget: a
   * wake that hangs or that answers with something other than a running Pi records why and leaves a
   * retryable `error`, because the alternative — the bug this bounds — is a Companion that reports
   * Starting until somebody reads the Box's own state to find out nothing is happening.
   */
  async function startRuntime(
    c: Context<{ Variables: ApiVariables }>,
    companionId: string,
    body: StartCompanionRuntimeInput,
    options: {
      allowBoxWake?: boolean;
      restartPi?: boolean;
      timeoutRestartOrdinal?: number | null;
      allowArchiveResume?: boolean;
    } = {},
  ): Promise<{ companion: Companion; runtime: CompanionBoxRuntime; ready: boolean }> {
    let failureContext:
      | {
          actor: ReturnType<typeof actorFromContext>;
          orgId: string;
        }
      | undefined;
    let mutation:
      | {
          actor: ReturnType<typeof actorFromContext>;
          orgId: string;
          companion: Awaited<ReturnType<typeof getCompanionForRuntime>>;
          provider: Awaited<ReturnType<typeof resolveCompanionProviderAuth>>;
          plugins: Awaited<ReturnType<typeof resolveCompanionPluginInjection>>;
          skillPackages: Awaited<ReturnType<typeof listCompanionRuntimeSkillPackages>>;
          hubEnv: Record<string, string>;
          /** Revalidated after the lifecycle claim so a delayed request cannot recycle Pi twice. */
          timeoutRestartPending: boolean;
        }
      | undefined;
    /**
     * The Box-assignment write, while it is in flight. A start abandoned at its deadline can already
     * be inside this write, and what it writes is `provisioning`, so the failure path waits for it
     * before recording its own state: the reason a wake failed has to be the last word on the row.
     */
    let boxAssignment: Promise<unknown> | undefined;
    const budget = startBudget();
    try {
      mutation = await withinBudget(tenant(c, async ({ actor, orgId, database }) => {
        failureContext = { actor, orgId };
        const provider = await resolveCompanionProviderAuth({
          actor, orgId, companionId, database,
        });
        const plugins = body.client_surface === "native_mobile"
          ? { accounts: [], credentials: [] }
          : await resolveCompanionPluginInjection({
              actor, orgId, companionId, database,
            });
        const companion = await claimCompanionRuntimeStart({
          actor,
          orgId,
          companionId,
          allowArchiveResume: options.allowArchiveResume,
          database,
        });
        const timeoutRestartPending = options.timeoutRestartOrdinal !== null
          && options.timeoutRestartOrdinal !== undefined
          ? await listPendingCompanionMessages({ actor, orgId, companionId, database })
            .then((state) => state.timeoutRestartPending
              && state.timeoutRecoveryOrdinal === options.timeoutRestartOrdinal)
          : false;
        const skillPackages = body.client_surface === "native_mobile"
          ? []
          : await listCompanionRuntimeSkillPackages({ actor, orgId, companionId, database });
        const hubEnv: Record<string, string> = {};
        if (body.client_surface !== "native_mobile") {
          const apiUrl = (env.COMPANION_API_URL ?? "http://127.0.0.1:3001").replace(/\/+$/, "");
          hubEnv.COMPANION_API_URL = apiUrl;
          hubEnv.COMPANION_WORKSPACE_ID = orgId;
          let ownerActor = actor.id === companion.owner_id
            ? actor
            : null;
          if (!ownerActor) {
            const [owner] = await database
              .select({
                id: schema.user.id,
                email: schema.user.email,
                name: schema.user.name,
              })
              .from(schema.user)
              .where(eq(schema.user.id, companion.owner_id))
              .limit(1);
            if (owner) {
              ownerActor = {
                id: owner.id,
                email: owner.email,
                name: owner.name || owner.email,
              };
            }
          }
          if (ownerActor) {
            const scopes = companion.can_write_skills
              ? (["skills:read", "skills:write"] as const)
              : (["skills:read"] as const);
            const issued = await issueApiToken({
              actor: ownerActor,
              orgId,
              scopes: [...scopes],
              name: `Companion ${companionId} Skills Hub`,
              ttlMs: 6 * 60 * 60 * 1000,
              source: { type: "companion", companionId },
              database,
            });
            hubEnv.COMPANION_DELEGATION_TOKEN = issued.token;
          }
        }
        return {
          actor,
          orgId,
          companion,
          provider,
          plugins,
          skillPackages,
          hubEnv,
          timeoutRestartPending,
        };
      }), budget.signal);
      const modelId = mutation.companion.model_id;
      if (!modelId) {
        throw new CompanionProviderError(
          "provider_model_invalid",
          "Choose a model before starting this Companion.",
          mutation.provider.providerId,
        );
      }
      // A pending skill revision means the Box does not run the saved list yet (a save while it
      // slept, a failed publish push, an archived selection). A warm shortcut would keep it stale
      // forever while settings promise "reapplies on next start", so a pending start restages —
      // the same Pi recycle an online skills change already performs. Never for native_mobile,
      // which stages no library skills.
      const skillsPending = body.client_surface !== "native_mobile"
        && mutation.companion.runtime.skills_applied_revision
          < mutation.companion.runtime.skills_revision;
      const librarySkills = await withinBudget(
        // Object storage has no timeout of its own, so these reads are held to the wake's deadline
        // like every other step: a bucket that stops answering must not become a Companion that
        // reports Starting with a Box nobody has contacted yet.
        Promise.all(mutation.skillPackages.map(async (skill) => {
          const archive = await getSkillArchive({
            key: skill.storagePath,
            signal: budget.signal,
          });
          if (skillChecksum(toTar(archive)) !== skill.checksum) {
            throw new BoxRuntimeProviderError(
              `stored skill package no longer matches ${skill.slug}@${skill.version}`,
              502,
            );
          }
          return {
            slug: skill.slug,
            version: skill.version,
            checksum: skill.checksum,
            archive,
          };
        })),
        budget.signal,
      );
      // Bundled Companion agent skill is always staged on web/mobile-web so Pi can reach the Skills
      // Hub. selected_skill_ids are additional library packages; empty selection stages only this.
      const skills = body.client_surface === "native_mobile"
        ? []
        : await withinBudget((async () => {
          const bundled = await getCompanionSkillPackage();
          const packed = await packDir(companionSkillDir());
          const agentSkill = {
            slug: COMPANION_SKILL_KEY,
            version: bundled.version,
            checksum: packed.checksum,
            archive: packed.archive,
          };
          return [
            agentSkill,
            ...librarySkills.filter((skill) => skill.slug !== COMPANION_SKILL_KEY),
          ];
        })(), budget.signal);
      const runtime = runtimeFactory();
      const refreshRuntimeLayout =
        mutation.companion.runtime.disk_layout_version !== COMPANION_PI_DISK_LAYOUT_VERSION;
      const observed = await withinBudget(runtime.start({
        signal: budget.signal,
        companionId,
        orgId: mutation.orgId,
        boxId: mutation.companion.runtime.box_id,
        clientSurface: body.client_surface,
        providerAuth: {
          [mutation.provider.providerId]: mutation.provider.authEntry,
        },
        modelId,
        instructions: mutation.companion.persona,
        // Skipping the write preserves a subscription token Pi refreshed on disk. A layout refresh
        // remains a cold resource-injection path, but it does not replace current provider auth or
        // recycle a warm Pi; staged resources load on its next natural start.
        replaceProviderAuth:
          !mutation.companion.runtime.box_id
          || mutation.companion.runtime.provider_credential_generation
            !== mutation.provider.credentialGeneration,
        // Extensions are loaded when Pi starts. Refreshing files beneath an already-running layout
        // is not enough: recycle that daemon once so every live Box actually gains the new guard.
        // A pending skill revision recycles too — a warm shortcut would keep the Box's staged
        // skills stale while settings promise "reapplies on next start".
        restartPi: (
          options.restartPi === true
          && (options.timeoutRestartOrdinal == null || mutation.timeoutRestartPending)
        ) || refreshRuntimeLayout || skillsPending,
        refreshRuntimeLayout,
        allowBoxWake: options.allowBoxWake,
        mcpCredentials: body.client_surface === "native_mobile"
          ? []
          : [...mutation.plugins.credentials, ...body.mcp_credentials],
        mcpAccounts: body.client_surface === "native_mobile"
          ? []
          : [...mutation.plugins.accounts, ...body.mcp_accounts],
        skills,
        hubEnv: mutation.hubEnv,
        // `null` clears the recorded Box: the adapter found that the id this row carried names a
        // machine this Companion does not own, so no other path may reach it either.
        onBoxAssigned: async (boxId) => {
          // A start abandoned at the deadline may still reach this point, and the reason for that
          // failure is already on the row. Re-claiming `provisioning` here would erase it and put the
          // Companion back into the state this budget exists to end. Refusing rather than returning is
          // what says so: the adapter reads a rejected assignment as a Box no row points at and puts
          // that Box back to sleep, which returning as if the id were recorded would skip.
          if (budget.signal.aborted) throw budget.signal.reason;
          const write = withTenantContext(
            { orgId: mutation!.orgId, userId: mutation!.actor.id },
            (database) => updateCompanionRuntime({
              actor: mutation!.actor,
              orgId: mutation!.orgId,
              companionId,
              patch: { boxId, runtimeState: "provisioning", daemonState: "starting" },
              database,
            }),
          );
          boxAssignment = write.catch(() => undefined);
          await write;
        },
      }), budget.signal);
      // A graceful Box archive may still be snapshotting after the adapter's bounded poll. That is
      // a truthful waiting state, not a failed start: preserve it without last_error so the same
      // full-Box restart or a later wake can resume once the provider reports `archived`.
      const archiveInFlight = observed.runtimeState === "stopping"
        && observed.daemonState === "stopped";
      const noWakeArchiveCompleted = options.allowBoxWake === false
        && observed.runtimeState === "stopped"
        && observed.daemonState === "stopped";
      if (archiveInFlight || noWakeArchiveCompleted) {
        const companion = await withinBudget(
          withTenantContext(
            { orgId: mutation.orgId, userId: mutation.actor.id },
            (database) => updateCompanionRuntime({
              actor: mutation!.actor,
              orgId: mutation!.orgId,
              companionId,
              patch: {
                boxId: observed.boxId,
                runtimeState: observed.runtimeState,
                // `stopping` + `starting` is the durable archive-resume intent. It distinguishes an
                // accepted wake/restart from an explicit stop or the Owner's deletion lock, while the
                // runtime chip continues to project the truthful top-level Stopping state.
                // A no-wake settings apply or Pi-only restart must not inherit that intent merely
                // because Box began archiving during its observation race.
                daemonState: archiveInFlight && options.allowBoxWake !== false
                  ? "starting"
                  : "stopped",
                desktopAvailable: observed.desktopAvailable,
                observedAt: new Date(),
              },
              database,
            }),
          ),
          budget.signal,
        );
        return { companion, runtime, ready: false };
      }
      // A start that returns is otherwise a start that finished, so anything other than a running Pi
      // is a failure with an observation attached rather than a wake still in progress. Writing a
      // provisioning observation back verbatim would leave a Companion stuck on Starting.
      if (observed.runtimeState !== "running" || observed.daemonState !== "running") {
        throw new BoxRuntimeProviderError(
          `Box ${observed.boxId} answered this wake as ${observed.runtimeState}`
          + ` with Pi ${observed.daemonState} instead of running`,
          502,
        );
      }
      const companion = await withinBudget(
        withTenantContext(
          { orgId: mutation.orgId, userId: mutation.actor.id },
          async (database) => {
            const companion = await updateCompanionRuntime({
              actor: mutation!.actor,
              orgId: mutation!.orgId,
              companionId,
              patch: {
                boxId: observed.boxId,
                runtimeState: observed.runtimeState,
                daemonState: observed.daemonState,
                providerIds: [mutation!.provider.providerId],
                providerCredentialGeneration: mutation!.provider.credentialGeneration,
                diskLayoutVersion: COMPANION_PI_DISK_LAYOUT_VERSION,
                desktopAvailable: observed.desktopAvailable,
                // The staged set matches the revision read in the claim transaction. Recorded only
                // when this start actually staged: native_mobile stages no library skills, and a
                // warm shortcut (`staged: false`) left the Box running whatever was staged before —
                // writing "applied" for either would show "up to date" for packages the Box never
                // received.
                ...(body.client_surface !== "native_mobile" && observed.staged !== false
                  ? {
                      skillsAppliedRevision: mutation!.companion.runtime.skills_revision,
                      skillsLastError: null,
                    }
                  : {}),
                observedAt: new Date(),
                startedAt: new Date(),
              },
              database,
            });
            if (mutation!.timeoutRestartPending
              && options.timeoutRestartOrdinal !== null
              && options.timeoutRestartOrdinal !== undefined) {
              await recordCompanionTimeoutRestart({
                actor: mutation!.actor,
                orgId: mutation!.orgId,
                companionId,
                timeoutOrdinal: options.timeoutRestartOrdinal,
                database,
              });
            }
            return companion;
          },
        ),
        budget.signal,
      );
      return { companion, runtime, ready: true };
    } catch (raised) {
      // Cancellation surfaces as whatever call was in flight when the deadline landed, so the reason
      // this wake reports is the budget it spent rather than a bare abort from one Box request.
      const error = budget.signal.aborted ? budget.signal.reason : raised;
      // Cancellation does not wait for the call it interrupted, so a Box assignment still in flight
      // would otherwise write `provisioning` over the failure recorded here.
      await boxAssignment;
      // A pre-claim transition conflict means another request owns the wake. Preserve its
      // provisioning lock; all other authorized failures remain visible through last_error.
      const context = mutation
        ?? (error instanceof CompanionRuntimeTransitionError ? undefined : failureContext);
      if (context) {
        await withTenantContext(
          { orgId: context.orgId, userId: context.actor.id },
          (database) => updateCompanionRuntime({
            actor: context.actor,
            orgId: context.orgId,
            companionId,
            patch: {
              runtimeState: "error",
              daemonState: "error",
              // Keep the reason beside the durable message so a failed automatic wake remains
              // diagnosable and retrying that same message can claim the lifecycle again.
              lastError: companionRuntimeErrorMessage(error),
              observedAt: new Date(),
            },
            database,
          }),
        ).catch(() => undefined);
      }
      throw error;
    } finally {
      budget.release();
    }
  }

  /**
   * Stop and archive one Companion through the lifecycle claim used by the public stop route and by
   * a full-Box restart. Keeping the failure write here gives both callers the same retryable Error
   * state and prevents a restart from inventing a second, subtly different stop path.
   */
  async function stopRuntime(c: Context<{ Variables: ApiVariables }>, companionId: string): Promise<Companion> {
    let mutation:
      | {
          actor: ReturnType<typeof actorFromContext>;
          orgId: string;
          companion: Awaited<ReturnType<typeof claimCompanionRuntimeStop>>;
        }
      | undefined;
    try {
      mutation = await tenant(c, async ({ actor, orgId, database }) => {
        const companion = await claimCompanionRuntimeStop({
          actor, orgId, companionId, database,
        });
        return { actor, orgId, companion };
      });
      const claimed = mutation;
      const observed = await runtimeFactory().stop({ boxId: claimed.companion.runtime.box_id! });
      return withTenantContext(
        { orgId: claimed.orgId, userId: claimed.actor.id },
        (database) => updateCompanionRuntime({
          actor: claimed.actor,
          orgId: claimed.orgId,
          companionId,
          // A delete may claim this Companion while the Box archive is in flight. Do not let this
          // older stop completion clear the deletion lock after the archive succeeds.
          expectedUpdatedAt: new Date(claimed.companion.updated_at),
          patch: {
            runtimeState: observed.runtimeState,
            daemonState: observed.daemonState,
            desktopAvailable: observed.desktopAvailable,
            observedAt: new Date(),
            stoppedAt: new Date(),
          },
          database,
        }),
      );
    } catch (error) {
      if (mutation) {
        await withTenantContext(
          { orgId: mutation.orgId, userId: mutation.actor.id },
          (database) => updateCompanionRuntime({
            actor: mutation!.actor,
            orgId: mutation!.orgId,
            companionId,
            expectedUpdatedAt: new Date(mutation!.companion.updated_at),
            patch: {
              runtimeState: "error",
              daemonState: "error",
              lastError: companionRuntimeErrorMessage(error),
              observedAt: new Date(),
            },
            database,
          }),
        ).catch(() => undefined);
      }
      throw error;
    }
  }

  app.get("/v1/companions", async (c) => {
    try {
      // `preview=false` answers with the roster and nothing anyone said. It is for a caller that
      // needs names and attachments — the Skills page asking which Companions stage a skill — and
      // keeps chat text off a surface that displays none of it.
      const withLastMessage = c.req.query("preview") !== "false";
      const companions = await tenant(c, ({ actor, orgId, database }) =>
        listCompanions({ actor, orgId, withLastMessage, database }));
      // The list carries each thread's last line now, so it is chat text and must not sit in a disk
      // cache after the session that read it, the way every other sensitive read here is treated.
      c.header("Cache-Control", "private, no-store");
      return c.json({ companions });
    } catch (error) {
      return jsonError(c, error, errorStatus(error));
    }
  });

  app.post("/v1/companions", async (c) => {
    try {
      const body = createCompanionInputSchema.parse(await c.req.json());
      const companion = await tenant(c, ({ actor, orgId, database }) =>
        createCompanion({
          actor,
          orgId,
          name: body.name,
          persona: body.persona,
          providerId: body.provider_id,
          modelId: body.model_id,
          selectedSkillIds: body.selected_skill_ids,
          canWriteSkills: body.can_write_skills,
          selectedMcpAccountIds: body.selected_mcp_account_ids,
          database,
        }));
      return c.json({ companion }, 201);
    } catch (error) {
      return routeError(c, error);
    }
  });

  app.get("/v1/companion-providers", async (c) => {
    try {
      const providers = await tenant(c, ({ actor, orgId, database }) =>
        listCompanionProviders({ actor, orgId, database }));
      return c.json(providers);
    } catch (error) {
      return routeError(c, error);
    }
  });

  app.post("/v1/companion-providers/oauth/start", async (c) => {
    try {
      const body = companionProviderOAuthStartInputSchema.parse(await c.req.json());
      const context = await tenant(c, async ({ actor, orgId, database }) => {
        const providers = await listCompanionProviders({ actor, orgId, database });
        if (!providers.can_manage) throw new CompanionProviderForbiddenError();
        return { actor, orgId };
      });
      const masterKey = loadSecretsMasterKey(env.COMPANION_SECRETS_MASTER_KEY);
      const storePendingFlow = (
        flow: Parameters<typeof encodeCompanionProviderOAuthFlow>[0]["flow"],
      ) => {
        setCookie(c, COMPANION_PROVIDER_OAUTH_COOKIE, encodeCompanionProviderOAuthFlow({
          orgId: context.orgId,
          userId: context.actor.id,
          flow,
          masterKey,
        }), {
          path: "/v1/companion-providers/oauth",
          httpOnly: true,
          sameSite: "Lax",
          secure: env.NODE_ENV === "production",
          maxAge: COMPANION_PROVIDER_OAUTH_TTL_MS / 1000,
        });
      };
      if (body.provider_id === "anthropic") {
        const started = beginAnthropicProviderOAuth();
        storePendingFlow(started.flow);
        return c.json({
          flow: "authorization_code",
          provider_id: "anthropic",
          authorization_url: started.authorizationUrl,
        });
      }
      const started = await beginOpenAICodexProviderOAuth();
      storePendingFlow(started.flow);
      return c.json({
        flow: "device_code",
        provider_id: "openai-codex",
        verification_url: started.verificationUrl,
        user_code: started.userCode,
        poll_interval_seconds: started.pollIntervalSeconds,
        expires_at: new Date(started.flow.expiresAt).toISOString(),
      });
    } catch (error) {
      return routeError(c, error);
    }
  });

  app.post("/v1/companion-providers/oauth/complete", async (c) => {
    try {
      const body = companionProviderOAuthCompleteInputSchema.parse(await c.req.json());
      const context = await tenant(c, async ({ actor, orgId, database }) => {
        const providers = await listCompanionProviders({ actor, orgId, database });
        if (!providers.can_manage) throw new CompanionProviderForbiddenError();
        return { actor, orgId };
      });
      const masterKey = loadSecretsMasterKey(env.COMPANION_SECRETS_MASTER_KEY);
      const cookie = getCookie(c, COMPANION_PROVIDER_OAUTH_COOKIE);
      if (!cookie) {
        throw new CompanionProviderOAuthError("oauth_expired", "Provider sign-in expired. Start again.");
      }
      const pending = decodeCompanionProviderOAuthFlow({ value: cookie, masterKey });
      if (
        pending.userId !== context.actor.id
        || pending.orgId !== context.orgId
        || pending.flow.providerId !== "anthropic"
      ) {
        throw new CompanionProviderOAuthError("oauth_invalid", "Provider sign-in does not match this workspace.");
      }
      const credential = await completeAnthropicProviderOAuth({
        flow: pending.flow,
        authorizationInput: body.authorization_code,
      });
      const connection = await withTenantContext(
        { orgId: context.orgId, userId: context.actor.id },
        (database) => saveCompanionProvider({
          actor: context.actor,
          orgId: context.orgId,
          providerId: "anthropic",
          authMethod: "subscription",
          credential,
          masterKey,
          database,
        }),
      );
      setCookie(c, COMPANION_PROVIDER_OAUTH_COOKIE, "", {
        path: "/v1/companion-providers/oauth",
        maxAge: 0,
        httpOnly: true,
        sameSite: "Lax",
        secure: env.NODE_ENV === "production",
      });
      return c.json({ connection });
    } catch (error) {
      return routeError(c, error);
    }
  });

  app.post("/v1/companion-providers/oauth/poll", async (c) => {
    let clearCookieOnFailure = false;
    try {
      const context = await tenant(c, async ({ actor, orgId, database }) => {
        const providers = await listCompanionProviders({ actor, orgId, database });
        if (!providers.can_manage) throw new CompanionProviderForbiddenError();
        return { actor, orgId };
      });
      clearCookieOnFailure = true;
      const masterKey = loadSecretsMasterKey(env.COMPANION_SECRETS_MASTER_KEY);
      const cookie = getCookie(c, COMPANION_PROVIDER_OAUTH_COOKIE);
      if (!cookie) {
        throw new CompanionProviderOAuthError("oauth_expired", "Provider sign-in expired. Start again.");
      }
      const pending = decodeCompanionProviderOAuthFlow({ value: cookie, masterKey });
      if (
        pending.userId !== context.actor.id
        || pending.orgId !== context.orgId
        || pending.flow.providerId !== "openai-codex"
      ) {
        throw new CompanionProviderOAuthError("oauth_invalid", "Provider sign-in does not match this workspace.");
      }
      const result = await pollOpenAICodexProviderOAuth({ flow: pending.flow });
      if (result.status === "pending") return c.json({ status: "pending" }, 202);
      const connection = await withTenantContext(
        { orgId: context.orgId, userId: context.actor.id },
        (database) => saveCompanionProvider({
          actor: context.actor,
          orgId: context.orgId,
          providerId: "openai-codex",
          authMethod: "subscription",
          credential: result.credential,
          masterKey,
          database,
        }),
      );
      setCookie(c, COMPANION_PROVIDER_OAUTH_COOKIE, "", {
        path: "/v1/companion-providers/oauth",
        maxAge: 0,
        httpOnly: true,
        sameSite: "Lax",
        secure: env.NODE_ENV === "production",
      });
      return c.json({ status: "connected", connection });
    } catch (error) {
      if (
        clearCookieOnFailure
        && (!(error instanceof CompanionProviderOAuthError) || error.code !== "oauth_unavailable")
      ) {
        setCookie(c, COMPANION_PROVIDER_OAUTH_COOKIE, "", {
          path: "/v1/companion-providers/oauth",
          maxAge: 0,
          httpOnly: true,
          sameSite: "Lax",
          secure: env.NODE_ENV === "production",
        });
      }
      return routeError(c, error);
    }
  });

  app.get("/v1/companion-plugins", async (c) => {
    try {
      const accounts = await tenant(c, ({ actor, orgId, database }) =>
        listCompanionPlugins({ actor, orgId, database }));
      return c.json({ accounts });
    } catch (error) {
      return routeError(c, error);
    }
  });

  app.post("/v1/companion-plugins", async (c) => {
    try {
      const body = saveCompanionPluginInputSchema.parse(await c.req.json());
      const account = await tenant(c, ({ actor, orgId, database }) =>
        saveCompanionPlugin({ actor, orgId, plugin: body, database }));
      return c.json({ account }, 201);
    } catch (error) {
      return routeError(c, error);
    }
  });

  app.post("/v1/companion-plugins/oauth/start", async (c) => {
    try {
      const body = companionPluginOAuthStartInputSchema.parse(await c.req.json());
      const context = await tenant(c, async ({ actor, orgId, database }) => ({
        actor,
        orgId,
        accounts: await listCompanionPlugins({ actor, orgId, database }),
      }));
      const catalog = COMPANION_PLUGIN_OAUTH_SERVERS[body.server_name];
      if (context.accounts.some((account) =>
        account.provider === catalog.provider
        && account.label.toLocaleLowerCase("en-US") === body.label.toLocaleLowerCase("en-US"))) {
        throw new CompanionPluginConflictError();
      }
      const masterKey = loadSecretsMasterKey(env.COMPANION_SECRETS_MASTER_KEY);
      const nonce = randomUUID();
      const state = signCompanionPluginOAuthState({
        orgId: context.orgId,
        userId: context.actor.id,
        nonce,
        expiresAt: Date.now() + COMPANION_PLUGIN_OAUTH_TTL_MS,
      }, masterKey);
      const redirectUri = companionPluginOAuthRedirectUri(env);
      const started = await beginCompanionPluginOAuth({
        serverName: body.server_name,
        redirectUri,
        state,
        env,
      });
      setCookie(c, companionPluginOAuthCookieName(nonce), encodeCompanionPluginOAuthFlow({
        orgId: context.orgId,
        nonce,
        value: { label: body.label, flow: started.flow },
        masterKey,
      }), {
        path: "/v1/companion-plugins/oauth/callback",
        httpOnly: true,
        sameSite: "Lax",
        secure: env.NODE_ENV === "production",
        maxAge: COMPANION_PLUGIN_OAUTH_TTL_MS / 1000,
      });
      return c.json({ authorization_url: started.authorizationUrl });
    } catch (error) {
      return routeError(c, error);
    }
  });

  app.get("/v1/companion-plugins/oauth/callback", async (c) => {
    const web = env.COMPANION_WEB_URL ?? "http://127.0.0.1:3000";
    let cookieName: string | null = null;
    try {
      const actor = actorFromContext(c);
      if (!companionsAvailableToUser(actor.email, env)) {
        throw new CompanionAccessForbiddenError();
      }
      const masterKey = loadSecretsMasterKey(env.COMPANION_SECRETS_MASTER_KEY);
      const state = verifyCompanionPluginOAuthState(c.req.query("state") ?? "", masterKey);
      cookieName = companionPluginOAuthCookieName(state.nonce);
      if (actor.id !== state.userId) throw new Error("OAuth authorization session does not match");
      const cookie = getCookie(c, cookieName);
      if (!cookie) throw new Error("OAuth authorization session expired");
      if (c.req.query("error")) throw new Error("OAuth authorization was denied");
      const pending = decodeCompanionPluginOAuthFlow({
        orgId: state.orgId,
        nonce: state.nonce,
        value: cookie,
        masterKey,
      });
      const code = c.req.query("code");
      if (!code) throw new Error("OAuth provider did not return an authorization code");
      const credential = await completeCompanionPluginOAuth({
        flow: pending.flow,
        code,
        redirectUri: companionPluginOAuthRedirectUri(env),
      });
      await withTenantContext(
        { orgId: state.orgId, userId: actor.id },
        (database) => saveCompanionOAuthPlugin({
          actor,
          orgId: state.orgId,
          provider: pending.flow.provider,
          label: pending.label,
          remoteUrl: pending.flow.remoteUrl,
          credential,
          masterKey,
          database,
        }),
      );
      setCookie(c, "companion_org", state.orgId, {
        path: "/",
        sameSite: "Lax",
        secure: env.NODE_ENV === "production",
      });
      const target = new URL("/companions", web);
      target.searchParams.set("view", "plugins");
      target.searchParams.set("oauth", "connected");
      setCookie(c, cookieName, "", {
        path: "/v1/companion-plugins/oauth/callback",
        maxAge: 0,
        httpOnly: true,
        sameSite: "Lax",
        secure: env.NODE_ENV === "production",
      });
      return c.redirect(target.toString(), 303);
    } catch (error) {
      if (cookieName) {
        setCookie(c, cookieName, "", {
          path: "/v1/companion-plugins/oauth/callback",
          maxAge: 0,
          httpOnly: true,
          sameSite: "Lax",
          secure: env.NODE_ENV === "production",
        });
      }
      const target = new URL("/companions", web);
      target.searchParams.set("view", "plugins");
      target.searchParams.set(
        "oauth_error",
        error instanceof CompanionPluginConflictError ? "duplicate_label" : "authorization_failed",
      );
      return c.redirect(target.toString(), 303);
    }
  });

  app.delete("/v1/companion-plugins/:id", async (c) => {
    try {
      const accountId = companionIdSchema.parse(c.req.param("id"));
      await tenant(c, ({ actor, orgId, database }) =>
        deleteCompanionPlugin({ actor, orgId, accountId, database }));
      return c.json({ ok: true });
    } catch (error) {
      return routeError(c, error);
    }
  });

  app.put("/v1/companion-providers/default", async (c) => {
    try {
      const body = setDefaultCompanionProviderInputSchema.parse(await c.req.json());
      await tenant(c, ({ actor, orgId, database }) =>
        setDefaultCompanionProvider({
          actor,
          orgId,
          providerId: body.provider_id,
          database,
        }));
      return c.json({ ok: true });
    } catch (error) {
      return routeError(c, error);
    }
  });

  app.put("/v1/companion-providers/:provider", async (c) => {
    try {
      const providerId = companionProviderIdSchema.parse(c.req.param("provider"));
      const body = saveCompanionProviderInputSchema.parse(await c.req.json());
      const connection = await tenant(c, ({ actor, orgId, database }) =>
        saveCompanionProvider({
          actor,
          orgId,
          providerId,
          authMethod: body.auth_method,
          credential: body.credential,
          database,
        }));
      return c.json({ connection });
    } catch (error) {
      return routeError(c, error);
    }
  });

  app.delete("/v1/companion-providers/:provider", async (c) => {
    try {
      const providerId = companionProviderIdSchema.parse(c.req.param("provider"));
      await tenant(c, ({ actor, orgId, database }) =>
        deleteCompanionProvider({ actor, orgId, providerId, database }));
      return c.json({ ok: true });
    } catch (error) {
      return routeError(c, error);
    }
  });

  app.get("/v1/companions/:id", async (c) => {
    try {
      const companionId = companionIdSchema.parse(c.req.param("id"));
      const companion = await tenant(c, ({ actor, orgId, database }) =>
        // A single-Companion read answers the same row the list draws, so it carries the preview.
        getCompanion({ actor, orgId, companionId, withLastMessage: true, database }));
      c.header("Cache-Control", "private, no-store");
      return c.json({ companion });
    } catch (error) {
      return jsonError(c, error, errorStatus(error));
    }
  });

  /**
   * Pin / hide / mark-unread for the current member only (THE-351). Does not archive the Companion
   * or its Box, and never reintroduces individual share.
   */
  app.patch("/v1/companions/:id/member-state", async (c) => {
    try {
      const companionId = companionIdSchema.parse(c.req.param("id"));
      const body = updateCompanionMemberStateInputSchema.parse(await c.req.json());
      const companion = await tenant(c, ({ actor, orgId, database }) =>
        updateCompanionMemberState({
          actor,
          orgId,
          companionId,
          patch: body,
          database,
        }));
      return c.json({ companion });
    } catch (error) {
      return routeError(c, error);
    }
  });

  /**
   * Owner-only clone into a new Companion with a new Box. Copies name, instructions, model, skill
   * selection, and plugin selection; workspace share stays off.
   */
  app.post("/v1/companions/:id/duplicate", async (c) => {
    try {
      const companionId = companionIdSchema.parse(c.req.param("id"));
      const companion = await tenant(c, ({ actor, orgId, database }) =>
        duplicateCompanion({ actor, orgId, companionId, database }));
      return c.json({ companion }, 201);
    } catch (error) {
      return routeError(c, error);
    }
  });

  app.patch("/v1/companions/:id", async (c) => {
    try {
      const companionId = companionIdSchema.parse(c.req.param("id"));
      const body = updateCompanionInputSchema.parse(await c.req.json());
      const updated = await tenant(c, async ({ actor, orgId, database }) => {
        const previous = await getCompanion({ actor, orgId, companionId, database });
        const companion = await updateCompanion({
          actor,
          orgId,
          companionId,
          name: body.name,
          persona: body.persona,
          providerId: body.provider_id,
          modelId: body.model_id,
          selectedSkillIds: body.selected_skill_ids,
          canWriteSkills: body.can_write_skills,
          selectedMcpAccountIds: body.selected_mcp_account_ids,
          database,
        });
        const provider = body.provider_id !== undefined
          ? await getCompanionProviderCredentialGeneration({
              actor, orgId, companionId, database,
            })
          : null;
        const skillsChanged = body.selected_skill_ids !== undefined
          && (
            previous.selected_skill_ids.length !== companion.selected_skill_ids.length
            || previous.selected_skill_ids.some((id, index) => id !== companion.selected_skill_ids[index])
          );
        const writeChanged = body.can_write_skills !== undefined
          && previous.can_write_skills !== companion.can_write_skills;
        const pluginsChanged = body.selected_mcp_account_ids !== undefined
          && (
            previous.selected_mcp_account_ids.length !== companion.selected_mcp_account_ids.length
            || previous.selected_mcp_account_ids.some(
              (id, index) => id !== companion.selected_mcp_account_ids[index],
            )
          );
        return {
          companion,
          modelChanged: previous.model_id !== companion.model_id,
          skillsChanged,
          writeChanged,
          pluginsChanged,
          settingsApplyNeeded: previous.model_id !== companion.model_id
            || skillsChanged
            || writeChanged
            || pluginsChanged
            || body.provider_id !== undefined
            && (
              previous.runtime.provider_ids[0] !== companion.runtime.provider_ids[0]
              || !providerAuthIsCurrent(companion, provider)
            ),
        };
      });
      const canApplyWithoutWaking = updated.companion.runtime.box_id
        && (
          piIsReachable(updated.companion)
          || updated.companion.runtime.state === "error"
        );
      if (updated.settingsApplyNeeded && canApplyWithoutWaking) {
        // Settings must never wake a sleeping Box. Confirm the projected online state is still live
        // before routing the provider/skill/plugin change through startRuntime, which rewrites auth
        // and recycles Pi when needed.
        const observed = await runtimeFactory().status({
          boxId: updated.companion.runtime.box_id!,
        }).catch(() => null);
        if (observed?.runtimeState === "running" && observed.daemonState === "running") {
          const started = await startRuntime(
            c,
            companionId,
            startCompanionRuntimeInputSchema.parse({ client_surface: "web" }),
            {
              allowBoxWake: false,
              restartPi: updated.modelChanged
                || updated.skillsChanged
                || updated.writeChanged
                || updated.pluginsChanged,
            },
          );
          return c.json({ companion: started.companion });
        }
      }
      return c.json({ companion: updated.companion });
    } catch (error) {
      return routeError(c, error);
    }
  });

  app.delete("/v1/companions/:id", async (c) => {
    try {
      const companionId = companionIdSchema.parse(c.req.param("id"));
      const claimed = await tenant(c, async ({ actor, orgId, database }) => ({
        actor,
        orgId,
        companion: await claimCompanionDeletion({ actor, orgId, companionId, database }),
      }));
      if (claimed.companion.runtime.box_id) {
        await runtimeFactory().stop({ boxId: claimed.companion.runtime.box_id });
      }
      await withTenantContext(
        { orgId: claimed.orgId, userId: claimed.actor.id },
        (database) => deleteCompanion({
          actor: claimed.actor,
          orgId: claimed.orgId,
          companionId,
          database,
        }),
      );
      return c.body(null, 204);
    } catch (error) {
      return routeError(c, error);
    }
  });

  app.put("/v1/companions/:id/provider", async (c) => {
    try {
      const companionId = companionIdSchema.parse(c.req.param("id"));
      const body = setCompanionProviderInputSchema.parse(await c.req.json());
      const companion = await tenant(c, ({ actor, orgId, database }) =>
        setCompanionProvider({
          actor,
          orgId,
          companionId,
          providerId: body.provider_id,
          database,
        }));
      return c.json({ companion });
    } catch (error) {
      return routeError(c, error);
    }
  });

  app.get("/v1/companions/:id/shares", async (c) => {
    try {
      const companionId = companionIdSchema.parse(c.req.param("id"));
      const shares = await tenant(c, ({ actor, orgId, database }) =>
        listCompanionShares({ actor, orgId, companionId, database }));
      return c.json({ shares });
    } catch (error) {
      return routeError(c, error);
    }
  });

  app.put("/v1/companions/:id/shares/workspace", async (c) => {
    try {
      const companionId = companionIdSchema.parse(c.req.param("id"));
      const body = setCompanionWorkspaceShareInputSchema.parse(await c.req.json());
      const shares = await tenant(c, ({ actor, orgId, database }) =>
        setCompanionWorkspaceShare({ actor, orgId, companionId, role: body.role, database }));
      return c.json({ shares });
    } catch (error) {
      return routeError(c, error);
    }
  });

  app.get("/v1/companions/:id/thread", async (c) => {
    try {
      const companionId = companionIdSchema.parse(c.req.param("id"));
      // Thread reads are also the control-plane fallback when live Box polling is unavailable.
      // Settle overdue chips here without contacting or waking the Box.
      const thread = await tenant(c, async ({ actor, orgId, database }) => {
        await expireCompanionToolRuns({ actor, orgId, companionId, database });
        return getCompanionThread({ actor, orgId, companionId, database });
      });
      return c.json({ thread });
    } catch (error) {
      return routeError(c, error);
    }
  });

  app.post("/v1/companions/:id/messages", async (c) => {
    try {
      const companionId = companionIdSchema.parse(c.req.param("id"));
      const body = sendCompanionMessageInputSchema.parse(await c.req.json());
      const sent = await tenant(c, async ({ actor, orgId, database }) => {
        const companion = await getCompanionForRuntime({ actor, orgId, companionId, database });
        // One send is one turn: the sender's message id decides the transcript entry, so a request
        // that arrives twice resolves to the turn already stored instead of writing a second one.
        const result = await sendCompanionMessage({
          actor,
          orgId,
          companionId,
          content: body.content,
          clientMessageId: body.client_message_id,
          database,
        });
        // Settlement can put user messages accepted during the timed-out turn back on the delivery
        // queue. Do that before reading the backlog so this send starts one normal turn with every
        // stranded message, rather than prompting only the newest one.
        const toolRuns = await expireCompanionToolRuns({ actor, orgId, companionId, database });
        // Anything a sleeping Box never received is still pending, so Pi receives the whole
        // backlog in order rather than this message alone. A resent send that was already
        // delivered is not pending, so it is never handed to Pi a second time either.
        const state = await listPendingCompanionMessages({ actor, orgId, companionId, database });
        const provider = state.pending.length > 0
          ? await getCompanionProviderCredentialGeneration({
              actor, orgId, companionId, database,
            })
          : null;
        return {
          actor,
          orgId,
          companion,
          provider,
          pending: state.pending,
          deliveredOrdinal: state.deliveredOrdinal,
          timeoutRecoveryPending: state.timeoutRecoveryPending,
          timeoutRestartPending: state.timeoutRestartPending,
          timeoutRecoveryOrdinal: state.timeoutRecoveryOrdinal,
          toolRuns,
          ...result,
        };
      });
      // A replay of an already-delivered send has nothing to wake or hand to Pi.
      if (sent.pending.length === 0) {
        const delivered =
          sent.deliveredOrdinal !== null && sent.deliveredOrdinal >= sent.entry.ordinal;
        // A prior attempt may have delivered and persisted the watermark but failed its TTL PATCH.
        // Retrying the same idempotent send repairs that clock without prompting Pi a second time.
        if (delivered && sent.companion.runtime.box_id) {
          await runtimeFactory().refreshTtl({ boxId: sent.companion.runtime.box_id })
            .catch(() => undefined);
        }
        return c.json({
          thread: sent.thread,
          delivery: delivered ? ("delivered" as const) : ("pending" as const),
        });
      }
      let runtime: CompanionBoxRuntime | undefined;
      let boxId: string | undefined;
      if (
        piIsReachable(sent.companion)
        && !sent.timeoutRestartPending
        && providerAuthIsCurrent(sent.companion, sent.provider)
        && sent.companion.runtime.disk_layout_version === COMPANION_PI_DISK_LAYOUT_VERSION
      ) {
        // Provider TTL can archive a Box while the control-plane projection still says running.
        // Observe without resuming; a genuinely warm daemon stays on the prompt-only path, while a
        // stale projection falls through to the same start path as an explicitly asleep Companion.
        const candidate = runtimeFactory();
        const observed = await candidate.status({
          boxId: sent.companion.runtime.box_id!,
        }).catch(() => null);
        if (observed?.runtimeState === "running" && observed.daemonState === "running") {
          runtime = candidate;
          boxId = sent.companion.runtime.box_id!;
        }
      }
      if (!runtime || !boxId) {
        try {
          const started = await startRuntime(
            c,
            companionId,
            startCompanionRuntimeInputSchema.parse({ client_surface: body.client_surface }),
            {
              allowArchiveResume: true,
              // A timed-out execution may still be holding Pi even after the scoped abort fired.
              // Recycle Pi, never the Box, before handing it the tail that follows that dead turn.
              restartPi: sent.timeoutRestartPending,
              timeoutRestartOrdinal: sent.timeoutRestartPending
                ? sent.timeoutRecoveryOrdinal
                : null,
            },
          );
          if (!started.companion.runtime.box_id) {
            throw new CompanionRuntimeTransitionError("companion start completed without a Box");
          }
          // The Box adapter may have exhausted its bounded archive poll and returned the truthful
          // waiting projection. Keep the durable message pending; no command should be attempted
          // against a Box that is still snapshotting.
          if (!started.ready) {
            return c.json({ thread: sent.thread, delivery: "pending" as const });
          }
          runtime = started.runtime;
          boxId = started.companion.runtime.box_id;
        } catch {
          // Persistence happened first and startRuntime recorded last_error. Returning the durable
          // pending turn keeps the composer from creating a second id for the same user action.
          return c.json({ thread: sent.thread, delivery: "pending" as const });
        }
      }
      const delivered = await deliverCompanionMessages({
        actor: sent.actor,
        orgId: sent.orgId,
        companionId,
        boxId,
        messages: sent.pending,
        runtime,
        timeoutRecoveryPending: sent.timeoutRecoveryPending,
      });
      const deliveredOrdinal = delivered?.deliveredOrdinal ?? sent.deliveredOrdinal;
      return c.json({
        thread: delivered?.thread ?? sent.toolRuns.thread,
        delivery: deliveredOrdinal !== null && deliveredOrdinal >= sent.entry.ordinal
          ? ("delivered" as const)
          : ("pending" as const),
      });
    } catch (error) {
      return runtimeRouteError(c, error);
    }
  });

  app.post("/v1/companions/:id/thread/sync", async (c) => {
    try {
      const companionId = companionIdSchema.parse(c.req.param("id"));
      const body = startCompanionRuntimeInputSchema.parse(await c.req.json().catch(() => ({})));
      const resolved = await tenant(c, async ({ actor, orgId, database }) => {
        const companion = await getCompanionForRuntime({ actor, orgId, companionId, database });
        // Re-queue an unanswered post-timeout user tail before taking the pending snapshot this
        // sync will deliver. Settlement itself remains PostgreSQL-only and never wakes Box.
        const toolRuns = await expireCompanionToolRuns({ actor, orgId, companionId, database });
        const state = await listPendingCompanionMessages({ actor, orgId, companionId, database });
        const archiveResumePending = companion.runtime.state === "stopping"
          && companion.runtime.daemon_state === "starting";
        const startRecoveryPending = state.pending.length > 0
          && companion.runtime.state === "provisioning"
          && companion.runtime.daemon_state === "starting";
        const mayNeedProviderRecovery = piIsReachable(companion)
          || archiveResumePending
          || startRecoveryPending
          || (Boolean(companion.runtime.box_id) && companion.runtime.state === "error");
        const provider = mayNeedProviderRecovery
          ? await getCompanionProviderCredentialGeneration({
              actor, orgId, companionId, database,
            })
          : null;
        return {
          actor,
          orgId,
          companion,
          provider,
          archiveResumePending,
          startRecoveryPending,
          toolRuns,
          ...state,
        };
      });
      const mayRecoverProvider = resolved.companion.runtime.state === "error"
        && !providerAuthIsCurrent(resolved.companion, resolved.provider);
      // Timeout settlement is control-plane work. Run it before every runtime gate so a stopped Box
      // or daemon cannot leave a durable chip spinning. The staged Pi extension owns cancellation
      // of the active operation; the control plane never sends an unscoped abort into Pi's FIFO.
      const beforeRuntime = resolved.toolRuns;
      if (
        !piIsReachable(resolved.companion)
        && !mayRecoverProvider
        && !resolved.archiveResumePending
        && !resolved.startRecoveryPending
      ) {
        return c.json({ thread: beforeRuntime.thread, source: "control_plane" as const });
      }
      let boxId = resolved.companion.runtime.box_id!;
      let desktopAvailable = resolved.companion.runtime.desktop_available;
      let runtime = runtimeFactory();
      if (resolved.archiveResumePending || resolved.startRecoveryPending) {
        // The open thread is the automatic continuation for a wake that outlasted the adapter's
        // bounded archive poll. It also keeps retrying a provisioning claim whose owning API process
        // may have died; the lifecycle claim rejects while that owner is fresh and takes over after
        // its stale window. Explicit Stop and Owner deletion remain read-only here.
        let started;
        try {
          started = await startRuntime(c, companionId, body, {
            allowArchiveResume: true,
            // A stale lifecycle claim does not prove its owner reached the timeout recycle. Carry
            // the same recovery requirement through takeover before the pending tail is delivered.
            restartPi: resolved.timeoutRestartPending,
            timeoutRestartOrdinal: resolved.timeoutRestartPending
              ? resolved.timeoutRecoveryOrdinal
              : null,
          });
        } catch (error) {
          if (error instanceof CompanionRuntimeTransitionError) {
            return c.json({ thread: beforeRuntime.thread, source: "control_plane" as const });
          }
          throw error;
        }
        if (!started.companion.runtime.box_id) {
          throw new CompanionRuntimeTransitionError("companion start completed without a Box");
        }
        if (!started.ready) {
          return c.json({ thread: beforeRuntime.thread, source: "control_plane" as const });
        }
        runtime = started.runtime;
        boxId = started.companion.runtime.box_id;
        desktopAvailable = started.companion.runtime.desktop_available;
      } else {
        const observed = await runtime.status({ boxId }).catch(() => null);
        if (!observed) {
          return c.json({ thread: beforeRuntime.thread, source: "control_plane" as const });
        }
        if (observed.runtimeState !== "running" || observed.daemonState !== "running") {
          return c.json({ thread: beforeRuntime.thread, source: "control_plane" as const });
        }
        desktopAvailable = observed.desktopAvailable;
        if (
          !providerAuthIsCurrent(resolved.companion, resolved.provider)
          || resolved.companion.runtime.disk_layout_version !== COMPANION_PI_DISK_LAYOUT_VERSION
          || resolved.timeoutRestartPending
        ) {
          const started = await startRuntime(c, companionId, body, {
            allowBoxWake: false,
            restartPi: resolved.timeoutRestartPending,
            timeoutRestartOrdinal: resolved.timeoutRestartPending
              ? resolved.timeoutRecoveryOrdinal
              : null,
          });
          if (!started.companion.runtime.box_id) {
            throw new CompanionRuntimeTransitionError("companion start completed without a Box");
          }
          if (!started.ready) {
            return c.json({ thread: beforeRuntime.thread, source: "control_plane" as const });
          }
          runtime = started.runtime;
          boxId = started.companion.runtime.box_id;
        }
      }
      let deliveredOrdinal: number | undefined;
      try {
        for (const message of resolved.pending) {
          await runtime.prompt({ boxId, message: message.content, requestId: message.event_id });
          deliveredOrdinal = message.ordinal;
        }
      } finally {
        if (deliveredOrdinal !== undefined) {
          const recorded = await recordProjection({
            actor: resolved.actor,
            orgId: resolved.orgId,
            companionId,
            entries: [],
            deliveredOrdinal,
            timeoutDeliveryOrdinal: resolved.timeoutRecoveryPending
              ? deliveredOrdinal
              : undefined,
          }).then(() => true, () => false);
          if (recorded) await runtime.refreshTtl({ boxId }).catch(() => undefined);
        }
      }
      const events = await runtime.readEvents({ boxId, offset: resolved.piLogOffset });
      const projection = projectCompanionPiEvents({ chunk: events.chunk, offset: events.offset });
      const projected = await recordProjection({
        actor: resolved.actor,
        orgId: resolved.orgId,
        companionId,
        entries: projection.entries,
        toolCompletions: projection.toolCompletions,
        piLogOffset: events.offset + projection.consumedBytes,
        // Pi rereads its log from the start when it shrank, so that projection owns the offset
        // outright; otherwise the offset only moves forward.
        piLogRewound: events.offset < resolved.piLogOffset,
      });
      const afterProjection = await withTenantContext(
        { orgId: resolved.orgId, userId: resolved.actor.id },
        (database) => expireCompanionToolRuns({
          actor: resolved.actor,
          orgId: resolved.orgId,
          companionId,
          database,
        }),
      );
      // Fail-closed: pending cards past their timeout become Deny before the client sees them spin.
      const expired = await withTenantContext(
        { orgId: resolved.orgId, userId: resolved.actor.id },
        (database) => expireCompanionDecisions({
          actor: resolved.actor,
          orgId: resolved.orgId,
          companionId,
          database,
        }),
      );
      let thread = expired.thread;
      for (const response of expired.responses) {
        await runtime.respondExtensionUi({ boxId, response }).catch(() => undefined);
      }
      const visualRuns: CompanionSettledToolRun[] = [
        ...projected.settledToolRuns,
        ...beforeRuntime.timedOut,
        ...afterProjection.timedOut,
      ].filter((run) => companionToolRunIsVisual(run.kind));
      const framed = visualRuns.length
        ? await attachDesktopFrames({
            actor: resolved.actor,
            orgId: resolved.orgId,
            companionId,
            boxId,
            runtime,
            eventIds: visualRuns.map((run) => run.eventId),
            desktopAvailable,
          })
        : null;
      thread = framed ?? thread;
      // Opening/syncing the thread clears unread for this member, including while Pi answers.
      await withTenantContext(
        { orgId: resolved.orgId, userId: resolved.actor.id },
        (database) => markCompanionThreadRead({
          actor: resolved.actor,
          orgId: resolved.orgId,
          companionId,
          database,
        }),
      );
      return c.json({ thread, source: "box" as const });
    } catch (error) {
      return runtimeRouteError(c, error);
    }
  });

  /**
   * Answer or deny a pending ask_user question. The wider action contract remains compatible with
   * shell/file approval cards stored by older runtimes. Owner/Editor only; Viewer is refused before
   * any Box contact. The decision is persisted before the matching FIFO response unblocks Pi.
   */
  app.post("/v1/companions/:id/decisions/:requestId", async (c) => {
    try {
      const companionId = companionIdSchema.parse(c.req.param("id"));
      const requestId = z.string().min(1).max(200).parse(c.req.param("requestId"));
      const body = decideCompanionDecisionInputSchema.parse(await c.req.json());
      const decided = await tenant(c, async ({ actor, orgId, database }) => {
        const companion = await getCompanionForRuntime({ actor, orgId, companionId, database });
        const result = await decideCompanionDecision({
          actor,
          orgId,
          companionId,
          requestId,
          decision: body,
          database,
        });
        return { actor, orgId, companion, ...result };
      });
      const boxId = decided.companion.runtime.box_id;
      if (boxId && piIsReachable(decided.companion)) {
        const runtime = runtimeFactory();
        const observed = await runtime.status({ boxId }).catch(() => null);
        if (observed?.runtimeState === "running" && observed.daemonState === "running") {
          await runtime.respondExtensionUi({ boxId, response: decided.response });
          await runtime.refreshTtl({ boxId }).catch(() => undefined);
        }
      }
      return c.json({ thread: decided.thread });
    } catch (error) {
      return runtimeRouteError(c, error);
    }
  });

  app.get("/v1/companions/:id/runtime", async (c) => {
    try {
      const companionId = companionIdSchema.parse(c.req.param("id"));
      const live = c.req.query("live") === "true";
      const resolved = await tenant(c, async ({ actor, orgId, database }) => {
        const companion = live
          ? await getCompanionForRuntime({ actor, orgId, companionId, withLastMessage: true, database })
          : await getCompanion({ actor, orgId, companionId, withLastMessage: true, database });
        return { actor, orgId, companion };
      });
      c.header("Cache-Control", "private, no-store");
      if (!live || !resolved.companion.runtime.box_id) {
        return c.json({ companion: resolved.companion, source: "control_plane" as const });
      }
      const observed = await runtimeFactory().status({ boxId: resolved.companion.runtime.box_id });
      const companion = await withTenantContext(
        { orgId: resolved.orgId, userId: resolved.actor.id },
        (database) => updateCompanionObservation({
          actor: resolved.actor,
          orgId: resolved.orgId,
          companionId,
          patch: {
            runtimeState: observed.runtimeState,
            daemonState: observed.daemonState,
            desktopAvailable: observed.desktopAvailable,
            observedAt: new Date(),
          },
          database,
        }),
      );
      // The observation is a lifecycle write and answers without a preview; this read asked for one,
      // so it keeps the one it already read rather than handing back a row with a blank line.
      return c.json({
        companion: { ...companion, last_message: resolved.companion.last_message },
        source: "box" as const,
      });
    } catch (error) {
      return jsonError(c, error, errorStatus(error));
    }
  });

  app.post("/v1/companions/:id/runtime/start", async (c) => {
    const companionId = c.req.param("id");
    try {
      companionIdSchema.parse(companionId);
      const body = startCompanionRuntimeInputSchema.parse(await c.req.json().catch(() => ({})));
      const started = await startRuntime(c, companionId, body, { allowArchiveResume: true });
      return c.json({ companion: started.companion }, started.ready ? 200 : 202);
    } catch (error) {
      return runtimeRouteError(c, error);
    }
  });

  app.post("/v1/companions/:id/runtime/restart", async (c) => {
    const companionId = c.req.param("id");
    try {
      companionIdSchema.parse(companionId);
      const rawBody = await c.req.json();

      // An initial Restart is deliberately not a wake. Resolve authorization and the projected
      // state before a Box client exists, then observe the already-running machine without resuming
      // it. The only stopped-state continuation is a Full Box restart this route already left
      // waiting on an asynchronous archive.
      const resolved = await tenant(c, async ({ actor, orgId, database }) => ({
        actor,
        orgId,
        companion: await getCompanionForRuntime({ actor, orgId, companionId, database }),
      }));
      const body = restartCompanionRuntimeInputSchema.parse(rawBody);
      const boxId = resolved.companion.runtime.box_id;
      const continuationRequested = body.target === "box" && body.continuation === true;
      const continuingBoxArchive = continuationRequested
        && boxId !== null
        && resolved.companion.runtime.state === "stopping"
        && resolved.companion.runtime.daemon_state === "starting";
      const continuingBoxStart = continuationRequested
        && boxId !== null
        && resolved.companion.runtime.state === "provisioning"
        && resolved.companion.runtime.daemon_state === "starting";
      const completedBoxArchive = continuationRequested
        && boxId !== null
        && resolved.companion.runtime.state === "running"
        && resolved.companion.runtime.daemon_state === "running";
      // A delayed continuation is idempotent after another tab/request already finished it. Do not
      // observe and reinterpret a later unrelated archive as part of this completed operation.
      if (completedBoxArchive) return c.json({ companion: resolved.companion });
      if (
        !boxId
        || (continuationRequested && !continuingBoxArchive && !continuingBoxStart)
        || (!continuationRequested
        && (
          resolved.companion.runtime.state !== "running"
          || resolved.companion.runtime.daemon_state !== "running"
        ))
      ) {
        throw new CompanionRuntimeTransitionError("companion must be online to restart");
      }

      if (continuingBoxStart) {
        // Another continuation may own a fresh start claim. Retrying reaches this path until that
        // owner settles; after the claim becomes stale, the ordinary start claim can take it over.
        // Enter the adapter directly so its assigned-Box lookup can replace a Box the provider
        // removed while the original continuation was abandoned.
        const startInput = startCompanionRuntimeInputSchema.parse({ client_surface: "web" });
        const started = await startRuntime(c, companionId, startInput, {
          allowArchiveResume: true,
        });
        return c.json({ companion: started.companion }, started.ready ? 200 : 202);
      }
      const observed = await runtimeFactory().status({
        boxId,
      });
      if (continuingBoxArchive) {
        if (observed.runtimeState === "stopping") {
          return c.json({ companion: resolved.companion }, 202);
        }
        if (observed.runtimeState === "stopped") {
          const startInput = startCompanionRuntimeInputSchema.parse({ client_surface: "web" });
          const started = await startRuntime(c, companionId, startInput, {
            allowArchiveResume: true,
          });
          return c.json({ companion: started.companion }, started.ready ? 200 : 202);
        }
        if (observed.runtimeState === "running" && observed.daemonState === "running") {
          const projected = await withTenantContext(
            { orgId: resolved.orgId, userId: resolved.actor.id },
            (database) => updateCompanionRuntime({
              actor: resolved.actor,
              orgId: resolved.orgId,
              companionId,
              expectedUpdatedAt: new Date(resolved.companion.updated_at),
              patch: {
                runtimeState: observed.runtimeState,
                daemonState: observed.daemonState,
                desktopAvailable: observed.desktopAvailable,
                observedAt: new Date(),
              },
              database,
            }),
          );
          return c.json({ companion: projected });
        }
        const message = `companion Box cannot continue restart from ${observed.runtimeState}`;
        await withTenantContext(
          { orgId: resolved.orgId, userId: resolved.actor.id },
          (database) => updateCompanionRuntime({
            actor: resolved.actor,
            orgId: resolved.orgId,
            companionId,
            expectedUpdatedAt: new Date(resolved.companion.updated_at),
            patch: {
              runtimeState: "error",
              daemonState: "error",
              lastError: message,
              desktopAvailable: observed.desktopAvailable,
              observedAt: new Date(),
            },
            database,
          }),
        );
        throw new CompanionRuntimeTransitionError(message);
      }
      await withTenantContext(
        { orgId: resolved.orgId, userId: resolved.actor.id },
        (database) => updateCompanionObservation({
          actor: resolved.actor,
          orgId: resolved.orgId,
          companionId,
          patch: {
            runtimeState: observed.runtimeState,
            daemonState: observed.daemonState,
            desktopAvailable: observed.desktopAvailable,
            observedAt: new Date(),
          },
          database,
        }),
      );
      if (observed.runtimeState !== "running" || observed.daemonState !== "running") {
        throw new CompanionRuntimeTransitionError("companion must be online to restart");
      }

      const startInput = startCompanionRuntimeInputSchema.parse({ client_surface: "web" });
      if (body.target === "pi") {
        const started = await startRuntime(c, companionId, startInput, {
          allowBoxWake: false,
          restartPi: true,
        });
        return c.json({ companion: started.companion }, started.ready ? 200 : 202);
      }

      // The observation above proves this is a restart of an online Box, not a disguised Wake.
      // Stop owns the archive and failure projection; start owns the resume and its own failure
      // projection, so a partial restart always leaves one durable, diagnosable state.
      const stopped = await stopRuntime(c, companionId);
      if (stopped.runtime.state === "stopping") {
        const waiting = await withTenantContext(
          { orgId: resolved.orgId, userId: resolved.actor.id },
          (database) => updateCompanionRuntime({
            actor: resolved.actor,
            orgId: resolved.orgId,
            companionId,
            expectedUpdatedAt: new Date(stopped.updated_at),
            patch: {
              runtimeState: "stopping",
              daemonState: "starting",
              observedAt: new Date(),
            },
            database,
          }),
        );
        return c.json({ companion: waiting }, 202);
      }
      const started = await startRuntime(c, companionId, startInput);
      return c.json({ companion: started.companion }, started.ready ? 200 : 202);
    } catch (error) {
      return runtimeRouteError(c, error);
    }
  });

  app.post("/v1/companions/:id/runtime/stop", async (c) => {
    const companionId = c.req.param("id");
    try {
      companionIdSchema.parse(companionId);
      const companion = await stopRuntime(c, companionId);
      return c.json({ companion });
    } catch (error) {
      return runtimeRouteError(c, error);
    }
  });

  app.post("/v1/companions/:id/runtime/desktop", async (c) => {
    try {
      const companionId = companionIdSchema.parse(c.req.param("id"));
      const companion = await tenant(c, ({ actor, orgId, database }) =>
        getCompanionForRuntime({ actor, orgId, companionId, database }));
      if (!companion.runtime.box_id) {
        throw new CompanionRuntimeTransitionError("companion has no Box");
      }
      const desktop = await runtimeFactory().desktop({ boxId: companion.runtime.box_id });
      // Computer use is the Box desktop Lux drives. The URL is secret-bearing, so it reaches this
      // authorized caller and is never stored, logged, or projected onto the Companion row. Every
      // request mints its own: Box rotates the stream token on each state change, so the in-thread
      // Computer panel and the desktop tab each ask for a URL rather than sharing a kept one.
      const payload: CompanionDesktop = {
        desktop_url: desktop.url,
        provisioning: desktop.provisioning,
        automation: "lux",
        transport: desktop.transport,
      };
      return c.json(payload);
    } catch (error) {
      return jsonError(c, error, errorStatus(error));
    }
  });
}
