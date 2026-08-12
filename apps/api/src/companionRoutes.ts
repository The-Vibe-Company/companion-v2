import type { Context, Hono } from "hono";
import { z } from "zod";
import {
  CompanionNotFoundError,
  CompanionRuntimeForbiddenError,
  CompanionRuntimeTransitionError,
  claimCompanionRuntimeStart,
  claimCompanionRuntimeStop,
  companionsEnabled,
  createCompanion,
  getCompanion,
  getCompanionForRuntime,
  listCompanions,
  updateCompanionRuntime,
} from "@companion/core";
import {
  createCompanionInputSchema,
  startCompanionRuntimeInputSchema,
} from "@companion/contracts";
import { withTenantContext, type Db } from "@companion/db";
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
  type CompanionBoxRuntime,
} from "./boxCompanionRuntime";

const companionIdSchema = z.string().uuid();

type RuntimeFactory = () => CompanionBoxRuntime;

function errorStatus(error: unknown): number {
  if (error instanceof AuthenticationRequiredError) return 401;
  if (error instanceof CompanionNotFoundError) return 404;
  if (error instanceof CompanionRuntimeForbiddenError) return 403;
  if (error instanceof CompanionRuntimeTransitionError) return 409;
  if (error instanceof BoxRuntimeConfigurationError) return 503;
  if (error instanceof BoxRuntimeProviderError) {
    if (error.status === 409) return 409;
    if (error.status === 504) return 504;
    return 502;
  }
  if (error instanceof z.ZodError) return 400;
  return 400;
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
        createCompanion({ actor, orgId, name: body.name, database }));
      return c.json({ companion }, 201);
    } catch (error) {
      return jsonError(c, error, errorStatus(error));
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
        (database) => updateCompanionRuntime({
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
        }
      | undefined;
    try {
      companionIdSchema.parse(companionId);
      const body = startCompanionRuntimeInputSchema.parse(await c.req.json().catch(() => ({})));
      mutation = await tenant(c, async ({ actor, orgId, database }) => {
        const companion = await claimCompanionRuntimeStart({
          actor, orgId, companionId, database,
        });
        return { actor, orgId, companion };
      });
      const providerIds = body.credentials.length
        ? [...new Set(body.credentials.map((credential) => credential.provider))]
        : mutation.companion.runtime.provider_ids;
      const observed = await runtimeFactory().start({
        companionId,
        orgId: mutation.orgId,
        boxId: mutation.companion.runtime.box_id,
        credentials: body.credentials.map((credential) => ({
          provider: credential.provider,
          envKey: credential.env_key,
          value: credential.value,
        })),
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
            providerIds,
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
      return jsonError(c, error, errorStatus(error));
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
      if (!companion.runtime.box_id) throw new Error("companion has no Box");
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
