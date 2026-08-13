import type { Context, Hono } from "hono";
import { z } from "zod";
import {
  CompanionNotFoundError,
  CompanionPluginConflictError,
  CompanionRegistryUnavailableError,
  CompanionProviderError,
  CompanionProviderForbiddenError,
  CompanionRuntimeForbiddenError,
  CompanionRuntimeTransitionError,
  CompanionShareForbiddenError,
  claimCompanionRuntimeStart,
  claimCompanionRuntimeStop,
  companionsAvailableToUser,
  companionsEnabled,
  createCompanion,
  deleteCompanionPlugin,
  deleteCompanionProvider,
  getCompanion,
  getCompanionRegistryServer,
  listCompanionRegistry,
  getCompanionForRuntime,
  getCompanionThread,
  listCompanionShares,
  listCompanionRuntimeSkillPackages,
  listCompanions,
  listCompanionProviders,
  listCompanionPlugins,
  listPendingCompanionMessages,
  projectCompanionPiEvents,
  recordCompanionPiProjection,
  resolveCompanionProviderAuth,
  resolveCompanionPluginInjection,
  saveCompanionProvider,
  saveCompanionPlugin,
  sendCompanionMessage,
  setCompanionProvider,
  setCompanionWorkspaceShare,
  setDefaultCompanionProvider,
  updateCompanionObservation,
  updateCompanionRuntime,
} from "@companion/core";
import type { CompanionPiEntry } from "@companion/core";
import {
  createCompanionInputSchema,
  companionProviderIdSchema,
  companionRegistryQuerySchema,
  companionRegistryServerNameSchema,
  saveCompanionProviderInputSchema,
  sendCompanionMessageInputSchema,
  setCompanionProviderInputSchema,
  setCompanionWorkspaceShareInputSchema,
  setDefaultCompanionProviderInputSchema,
  startCompanionRuntimeInputSchema,
  saveCompanionPluginInputSchema,
} from "@companion/contracts";
import type {
  Companion,
  CompanionDesktop,
  CompanionThread,
  CompanionTranscriptEntry,
  StartCompanionRuntimeInput,
} from "@companion/contracts";
import { withTenantContext, type Db } from "@companion/db";
import { skillChecksum, toTar } from "@companion/skills";
import { getSkillArchive } from "@companion/storage";
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
import { companionRuntimeErrorMessage, isBoxRuntimeFailure } from "./companionRuntimeError";

const companionIdSchema = z.string().uuid();

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
  if (error instanceof CompanionRuntimeForbiddenError) return 403;
  if (error instanceof CompanionProviderForbiddenError) return 403;
  if (error instanceof CompanionShareForbiddenError) return 403;
  if (error instanceof CompanionProviderError) return 422;
  if (error instanceof CompanionRuntimeTransitionError) return 409;
  if (error instanceof CompanionPluginConflictError) return 409;
  if (error instanceof CompanionRegistryUnavailableError) return 503;
  if (error instanceof BoxRuntimeConfigurationError) return 503;
  if (error instanceof BoxRuntimeProviderError) {
    if (error.status === 409) return 409;
    if (error.status === 504) return 504;
    return 502;
  }
  if (error instanceof z.ZodError) return 400;
  return 400;
}

/** Thread sync observes the control-plane projection and never wakes an unreachable Pi. */
function piIsReachable(companion: Companion): boolean {
  return Boolean(companion.runtime.box_id)
    && companion.runtime.state === "running"
    && companion.runtime.daemon_state === "running";
}

function recordProjection(input: {
  actor: ReturnType<typeof actorFromContext>;
  orgId: string;
  companionId: string;
  entries: CompanionPiEntry[];
  piLogOffset?: number;
  piLogRewound?: boolean;
  deliveredOrdinal?: number;
}): Promise<CompanionThread> {
  return withTenantContext(
    { orgId: input.orgId, userId: input.actor.id },
    (database) => recordCompanionPiProjection({ ...input, database }),
  );
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
  const thread = await recordProjection({
    actor: input.actor,
    orgId: input.orgId,
    companionId: input.companionId,
    entries: [],
    deliveredOrdinal,
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
   */
  async function startRuntime(
    c: Context<{ Variables: ApiVariables }>,
    companionId: string,
    body: StartCompanionRuntimeInput,
  ): Promise<{ companion: Companion; runtime: CompanionBoxRuntime }> {
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
        }
      | undefined;
    try {
      mutation = await tenant(c, async ({ actor, orgId, database }) => {
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
          actor, orgId, companionId, database,
        });
        const skillPackages = body.client_surface === "native_mobile"
          ? []
          : await listCompanionRuntimeSkillPackages({ actor, orgId, database });
        return { actor, orgId, companion, provider, plugins, skillPackages };
      });
      const skills = await Promise.all(mutation.skillPackages.map(async (skill) => {
        const archive = await getSkillArchive({ key: skill.storagePath });
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
      }));
      const runtime = runtimeFactory();
      const observed = await runtime.start({
        companionId,
        orgId: mutation.orgId,
        boxId: mutation.companion.runtime.box_id,
        clientSurface: body.client_surface,
        providerAuth: {
          [mutation.provider.providerId]: mutation.provider.authEntry,
        },
        // Skipping the write preserves a subscription token Pi refreshed on disk, so it is safe
        // only for a Box this Companion already provisioned at the current layout, where the
        // recorded generation proves the expected file is already in Pi's agent directory.
        replaceProviderAuth:
          !mutation.companion.runtime.box_id
          || mutation.companion.runtime.disk_layout_version !== COMPANION_PI_DISK_LAYOUT_VERSION
          || mutation.companion.runtime.provider_credential_generation
            !== mutation.provider.credentialGeneration,
        mcpCredentials: body.client_surface === "native_mobile"
          ? []
          : [...mutation.plugins.credentials, ...body.mcp_credentials],
        mcpAccounts: body.client_surface === "native_mobile"
          ? []
          : [...mutation.plugins.accounts, ...body.mcp_accounts],
        skills,
        // `null` clears the recorded Box: the adapter found that the id this row carried names a
        // machine this Companion does not own, so no other path may reach it either.
        onBoxAssigned: async (boxId) => {
          await withTenantContext(
            { orgId: mutation!.orgId, userId: mutation!.actor.id },
            (database) => updateCompanionRuntime({
              actor: mutation!.actor,
              orgId: mutation!.orgId,
              companionId,
              patch: { boxId, runtimeState: "provisioning", daemonState: "starting" },
              database,
            }),
          );
        },
      });
      const companion = await withTenantContext(
        { orgId: mutation.orgId, userId: mutation.actor.id },
        (database) => updateCompanionRuntime({
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
            observedAt: new Date(),
            startedAt: new Date(),
          },
          database,
        }),
      );
      return { companion, runtime };
    } catch (error) {
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
    }
  }

  /**
   * Registry browse is a read-only proxy of a public catalog, so it needs the same flag/allowlist
   * gate as the rest of Companions but no tenant row: the pins and cache live in the control plane,
   * not in PostgreSQL. Reject before any registry work when the caller is outside the allowlist.
   */
  function assertRegistryAccess(c: Context<{ Variables: ApiVariables }>): void {
    const actor = actorFromContext(c);
    if (!companionsAvailableToUser(actor.email, env)) {
      throw new CompanionAccessForbiddenError();
    }
  }

  app.get("/v1/companions", async (c) => {
    try {
      const companions = await tenant(c, ({ actor, orgId, database }) =>
        listCompanions({ actor, orgId, database }));
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

  app.get("/v1/companion-registry/servers", async (c) => {
    try {
      assertRegistryAccess(c);
      const query = companionRegistryQuerySchema.parse({
        search: c.req.query("search"),
        cursor: c.req.query("cursor"),
      });
      const result = await listCompanionRegistry({
        search: query.search,
        cursor: query.cursor,
        env,
      });
      return c.json(result);
    } catch (error) {
      return routeError(c, error);
    }
  });

  app.get("/v1/companion-registry/server", async (c) => {
    try {
      assertRegistryAccess(c);
      const name = companionRegistryServerNameSchema.parse(c.req.query("name"));
      const result = await getCompanionRegistryServer({ name, env });
      return c.json(result);
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
        getCompanion({ actor, orgId, companionId, database }));
      return c.json({ companion });
    } catch (error) {
      return jsonError(c, error, errorStatus(error));
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
      const thread = await tenant(c, ({ actor, orgId, database }) =>
        getCompanionThread({ actor, orgId, companionId, database }));
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
        // Anything a sleeping Box never received is still pending, so Pi receives the whole
        // backlog in order rather than this message alone. A resent send that was already
        // delivered is not pending, so it is never handed to Pi a second time either.
        const state = await listPendingCompanionMessages({ actor, orgId, companionId, database });
        return {
          actor,
          orgId,
          companion,
          pending: state.pending,
          deliveredOrdinal: state.deliveredOrdinal,
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
      if (piIsReachable(sent.companion)) {
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
          );
          if (!started.companion.runtime.box_id) {
            throw new CompanionRuntimeTransitionError("companion start completed without a Box");
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
      });
      const deliveredOrdinal = delivered?.deliveredOrdinal ?? sent.deliveredOrdinal;
      return c.json({
        thread: delivered?.thread ?? sent.thread,
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
      const resolved = await tenant(c, async ({ actor, orgId, database }) => {
        const companion = await getCompanionForRuntime({ actor, orgId, companionId, database });
        const state = await listPendingCompanionMessages({ actor, orgId, companionId, database });
        return { actor, orgId, companion, ...state };
      });
      if (!piIsReachable(resolved.companion)) {
        const thread = await withTenantContext(
          { orgId: resolved.orgId, userId: resolved.actor.id },
          (database) => getCompanionThread({
            actor: resolved.actor, orgId: resolved.orgId, companionId, database,
          }),
        );
        return c.json({ thread, source: "control_plane" as const });
      }
      const boxId = resolved.companion.runtime.box_id!;
      const runtime = runtimeFactory();
      let deliveredOrdinal: number | undefined;
      try {
        for (const message of resolved.pending) {
          await runtime.prompt({ boxId, message: message.content, requestId: message.event_id });
          deliveredOrdinal = message.ordinal;
        }
      } finally {
        // Record what Pi accepted before reading its log. Whatever happens next — a failed read, a
        // failed projection, a refused prompt — a retry must not prompt the same message twice.
        if (deliveredOrdinal !== undefined) {
          const recorded = await recordProjection({
            actor: resolved.actor,
            orgId: resolved.orgId,
            companionId,
            entries: [],
            deliveredOrdinal,
          }).then(() => true, () => false);
          if (recorded) {
            await runtime.refreshTtl({ boxId }).catch(() => undefined);
          }
        }
      }
      const events = await runtime.readEvents({ boxId, offset: resolved.piLogOffset });
      const projection = projectCompanionPiEvents({ chunk: events.chunk, offset: events.offset });
      const thread = await recordProjection({
        actor: resolved.actor,
        orgId: resolved.orgId,
        companionId,
        entries: projection.entries,
        piLogOffset: events.offset + projection.consumedBytes,
        // Pi rereads its log from the start when it shrank, so that projection owns the offset
        // outright; otherwise the offset only moves forward.
        piLogRewound: events.offset < resolved.piLogOffset,
      });
      return c.json({ thread, source: "box" as const });
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
          ? await getCompanionForRuntime({ actor, orgId, companionId, database })
          : await getCompanion({ actor, orgId, companionId, database });
        return { actor, orgId, companion };
      });
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
      return c.json({ companion, source: "box" as const });
    } catch (error) {
      return jsonError(c, error, errorStatus(error));
    }
  });

  app.post("/v1/companions/:id/runtime/start", async (c) => {
    const companionId = c.req.param("id");
    try {
      companionIdSchema.parse(companionId);
      const body = startCompanionRuntimeInputSchema.parse(await c.req.json().catch(() => ({})));
      const started = await startRuntime(c, companionId, body);
      return c.json({ companion: started.companion });
    } catch (error) {
      return runtimeRouteError(c, error);
    }
  });

  app.post("/v1/companions/:id/runtime/stop", async (c) => {
    const companionId = c.req.param("id");
    let mutation:
      | {
          actor: ReturnType<typeof actorFromContext>;
          orgId: string;
          companion: Awaited<ReturnType<typeof claimCompanionRuntimeStop>>;
        }
      | undefined;
    try {
      companionIdSchema.parse(companionId);
      mutation = await tenant(c, async ({ actor, orgId, database }) => {
        const companion = await claimCompanionRuntimeStop({
          actor, orgId, companionId, database,
        });
        return { actor, orgId, companion };
      });
      const claimed = mutation;
      const observed = await runtimeFactory().stop({ boxId: claimed.companion.runtime.box_id! });
      const companion = await withTenantContext(
        { orgId: claimed.orgId, userId: claimed.actor.id },
        (database) => updateCompanionRuntime({
          actor: claimed.actor,
          orgId: claimed.orgId,
          companionId,
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
      return c.json({ companion });
    } catch (error) {
      if (mutation) {
        await withTenantContext(
          { orgId: mutation.orgId, userId: mutation.actor.id },
          (database) => updateCompanionRuntime({
            actor: mutation!.actor,
            orgId: mutation!.orgId,
            companionId,
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
      // authorized caller and is never stored, logged, or projected onto the Companion row.
      const payload: CompanionDesktop = {
        desktop_url: desktop.url,
        provisioning: desktop.provisioning,
        automation: "lux",
      };
      return c.json(payload);
    } catch (error) {
      return jsonError(c, error, errorStatus(error));
    }
  });
}
