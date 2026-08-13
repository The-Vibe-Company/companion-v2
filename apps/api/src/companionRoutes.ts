import type { Context, Hono } from "hono";
import { z } from "zod";
import {
  CompanionNotFoundError,
  CompanionPluginConflictError,
  CompanionProviderError,
  CompanionProviderForbiddenError,
  CompanionRuntimeForbiddenError,
  CompanionRuntimeTransitionError,
  CompanionShareForbiddenError,
  CompanionShareTargetError,
  claimCompanionRuntimeStart,
  claimCompanionRuntimeStop,
  companionsEnabled,
  createCompanion,
  deleteCompanionPlugin,
  deleteCompanionProvider,
  getCompanion,
  getCompanionForRuntime,
  getCompanionThread,
  inviteCompanionMember,
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
  revokeCompanionMember,
  saveCompanionProvider,
  saveCompanionPlugin,
  sendCompanionMessage,
  setCompanionProvider,
  setCompanionWorkspaceShare,
  setDefaultCompanionProvider,
  updateCompanionObservation,
  updateCompanionMemberRole,
  updateCompanionRuntime,
} from "@companion/core";
import type { CompanionPiEntry } from "@companion/core";
import {
  createCompanionInputSchema,
  inviteCompanionMemberInputSchema,
  companionProviderIdSchema,
  saveCompanionProviderInputSchema,
  sendCompanionMessageInputSchema,
  setCompanionProviderInputSchema,
  setCompanionWorkspaceShareInputSchema,
  setDefaultCompanionProviderInputSchema,
  startCompanionRuntimeInputSchema,
  saveCompanionPluginInputSchema,
  updateCompanionMemberRoleInputSchema,
} from "@companion/contracts";
import type {
  Companion,
  CompanionThread,
  CompanionTranscriptEntry,
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

const companionIdSchema = z.string().uuid();

type RuntimeFactory = () => CompanionBoxRuntime;

function errorStatus(error: unknown): number {
  if (error instanceof AuthenticationRequiredError) return 401;
  if (error instanceof CompanionNotFoundError) return 404;
  if (error instanceof CompanionRuntimeForbiddenError) return 403;
  if (error instanceof CompanionProviderForbiddenError) return 403;
  if (error instanceof CompanionShareForbiddenError) return 403;
  if (error instanceof CompanionShareTargetError) return 422;
  if (error instanceof CompanionProviderError) return 422;
  if (error instanceof CompanionRuntimeTransitionError) return 409;
  if (error instanceof CompanionPluginConflictError) return 409;
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
 * Pi only receives messages while the control plane already records a running Box. Chat therefore
 * never creates or resumes one: waking stays an explicit Owner/Editor lifecycle action.
 */
function piIsReachable(companion: Companion): boolean {
  return Boolean(companion.runtime.box_id) && companion.runtime.state === "running";
}

function recordProjection(input: {
  actor: ReturnType<typeof actorFromContext>;
  orgId: string;
  companionId: string;
  entries: CompanionPiEntry[];
  piLogOffset?: number;
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
  runtimeFactory: RuntimeFactory;
}): Promise<{ thread: CompanionThread; deliveredOrdinal: number } | null> {
  const runtime = input.runtimeFactory();
  let deliveredOrdinal: number | undefined;
  try {
    for (const message of input.messages) {
      await runtime.prompt({
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
    const orgId = await orgIdFromContext(c);
    return withTenantContext({ orgId, userId: actor.id }, (database) =>
      fn({ actor, orgId, database }));
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

  app.put("/v1/companions/:id/shares/members", async (c) => {
    try {
      const companionId = companionIdSchema.parse(c.req.param("id"));
      const body = inviteCompanionMemberInputSchema.parse(await c.req.json());
      const shares = await tenant(c, ({ actor, orgId, database }) =>
        inviteCompanionMember({
          actor,
          orgId,
          companionId,
          email: body.email,
          role: body.role,
          database,
        }));
      return c.json({ shares });
    } catch (error) {
      return routeError(c, error);
    }
  });

  app.patch("/v1/companions/:id/shares/members/:userId", async (c) => {
    try {
      const companionId = companionIdSchema.parse(c.req.param("id"));
      const userId = z.string().min(1).max(255).parse(c.req.param("userId"));
      const body = updateCompanionMemberRoleInputSchema.parse(await c.req.json());
      const shares = await tenant(c, ({ actor, orgId, database }) =>
        updateCompanionMemberRole({
          actor,
          orgId,
          companionId,
          userId,
          role: body.role,
          database,
        }));
      return c.json({ shares });
    } catch (error) {
      return routeError(c, error);
    }
  });

  app.delete("/v1/companions/:id/shares/members/:userId", async (c) => {
    try {
      const companionId = companionIdSchema.parse(c.req.param("id"));
      const userId = z.string().min(1).max(255).parse(c.req.param("userId"));
      const shares = await tenant(c, ({ actor, orgId, database }) =>
        revokeCompanionMember({ actor, orgId, companionId, userId, database }));
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
        const result = await sendCompanionMessage({
          actor, orgId, companionId, content: body.content, database,
        });
        // Anything a sleeping Box never received is still pending, so Pi receives the whole
        // backlog in order rather than this message alone.
        const state = await listPendingCompanionMessages({ actor, orgId, companionId, database });
        return { actor, orgId, companion, pending: state.pending, ...result };
      });
      if (!piIsReachable(sent.companion)) {
        return c.json({ thread: sent.thread, delivery: "pending" as const });
      }
      const delivered = await deliverCompanionMessages({
        actor: sent.actor,
        orgId: sent.orgId,
        companionId,
        boxId: sent.companion.runtime.box_id!,
        messages: sent.pending,
        runtimeFactory,
      });
      return c.json({
        thread: delivered?.thread ?? sent.thread,
        delivery: delivered && delivered.deliveredOrdinal >= sent.entry.ordinal
          ? ("delivered" as const)
          : ("pending" as const),
      });
    } catch (error) {
      return routeError(c, error);
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
      } catch (error) {
        if (deliveredOrdinal !== undefined) {
          await recordProjection({
            actor: resolved.actor,
            orgId: resolved.orgId,
            companionId,
            entries: [],
            deliveredOrdinal,
          }).catch(() => undefined);
        }
        throw error;
      }
      const events = await runtime.readEvents({ boxId, offset: resolved.piLogOffset });
      const projection = projectCompanionPiEvents({ chunk: events.chunk, offset: events.offset });
      const thread = await recordProjection({
        actor: resolved.actor,
        orgId: resolved.orgId,
        companionId,
        entries: projection.entries,
        piLogOffset: events.offset + projection.consumedBytes,
        deliveredOrdinal,
      });
      return c.json({ thread, source: "box" as const });
    } catch (error) {
      return routeError(c, error);
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
      companionIdSchema.parse(companionId);
      const body = startCompanionRuntimeInputSchema.parse(await c.req.json().catch(() => ({})));
      mutation = await tenant(c, async ({ actor, orgId, database }) => {
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
      const observed = await runtimeFactory().start({
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
      return c.json({ companion });
    } catch (error) {
      if (mutation) {
        await withTenantContext(
          { orgId: mutation.orgId, userId: mutation.actor.id },
          (database) => updateCompanionRuntime({
            actor: mutation!.actor,
            orgId: mutation!.orgId,
            companionId,
            patch: { runtimeState: "error", daemonState: "error", observedAt: new Date() },
            database,
          }),
        ).catch(() => undefined);
      }
      return routeError(c, error);
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
            patch: { runtimeState: "error", daemonState: "error", observedAt: new Date() },
            database,
          }),
        ).catch(() => undefined);
      }
      return jsonError(c, error, errorStatus(error));
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
      return c.json({
        desktop_url: desktop.url,
        provisioning: desktop.provisioning,
        automation: "lux" as const,
      });
    } catch (error) {
      return jsonError(c, error, errorStatus(error));
    }
  });
}
