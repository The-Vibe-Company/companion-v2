import { initTRPC } from "@trpc/server";
import { z } from "zod";
import { listOrgs, listSkills, listSkillVersions, type ActorContext } from "@companion/core/services";
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
    .input(z.object({ scope: z.enum(["private", "team", "public"]).optional() }))
    .query(({ ctx, input }) => {
      if (!ctx.orgId) throw new Error("no organization selected");
      return withTenantContext({ orgId: ctx.orgId, userId: ctx.actor.id }, (database) =>
        listSkills({ actor: ctx.actor, orgId: ctx.orgId!, scope: input.scope, database }),
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
});

export type AppRouter = typeof appRouter;
