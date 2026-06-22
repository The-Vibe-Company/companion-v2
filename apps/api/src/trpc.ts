import { initTRPC } from "@trpc/server";
import { z } from "zod";
import {
  listNotifications,
  listOrgs,
  listSkills,
  listSkillVersions,
  unreadNotificationCount,
  type ActorContext,
} from "@companion/core/services";
import { visibilityFilterSchema } from "@companion/contracts";
import { withTenantContext } from "@companion/db";

export interface TrpcContext {
  actor: ActorContext | null;
  orgId: string | null;
}

const t = initTRPC.context<TrpcContext>().create();

const authed = t.middleware(({ ctx, next }) => {
  if (!ctx.actor) throw new Error("not authenticated");
  return next({ ctx: { actor: ctx.actor, orgId: ctx.orgId } });
});

export const appRouter = t.router({
  me: t.procedure.use(authed).query(({ ctx }) => ctx.actor),
  orgs: t.procedure.use(authed).query(({ ctx }) => listOrgs(ctx.actor)),
  skills: t.procedure
    .use(authed)
    .input(z.object({ visibility: visibilityFilterSchema.optional() }))
    .query(({ ctx, input }) => {
      if (!ctx.orgId) throw new Error("no organization selected");
      return withTenantContext({ orgId: ctx.orgId, userId: ctx.actor.id }, (database) =>
        listSkills({ actor: ctx.actor, orgId: ctx.orgId!, visibility: input.visibility, database }),
      );
    }),
  skillVersions: t.procedure
    .use(authed)
    .input(z.object({ slug: z.string() }))
    .query(({ ctx, input }) => {
      if (!ctx.orgId) throw new Error("no organization selected");
      return withTenantContext({ orgId: ctx.orgId, userId: ctx.actor.id }, (database) =>
        listSkillVersions({ actor: ctx.actor, orgId: ctx.orgId!, slug: input.slug, database }),
      );
    }),
  notifications: t.procedure
    .use(authed)
    .input(
      z
        .object({
          unreadOnly: z.boolean().optional(),
          limit: z.number().int().positive().max(100).optional(),
          before: z.string().optional(),
        })
        .optional(),
    )
    .query(({ ctx, input }) => {
      if (!ctx.orgId) throw new Error("no organization selected");
      return withTenantContext({ orgId: ctx.orgId, userId: ctx.actor.id }, (database) =>
        listNotifications({
          actor: ctx.actor,
          orgId: ctx.orgId!,
          unreadOnly: input?.unreadOnly,
          limit: input?.limit,
          before: input?.before,
          database,
        }),
      );
    }),
  notificationsUnreadCount: t.procedure.use(authed).query(({ ctx }) => {
    if (!ctx.orgId) throw new Error("no organization selected");
    return withTenantContext({ orgId: ctx.orgId, userId: ctx.actor.id }, (database) =>
      unreadNotificationCount({ actor: ctx.actor, orgId: ctx.orgId!, database }),
    );
  }),
});

export type AppRouter = typeof appRouter;
