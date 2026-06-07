import { getCookie } from "hono/cookie";
import type { Context } from "hono";
import { auth } from "@companion/auth";
import { ensureUserBootstrap, listOrgs, type ActorContext } from "@companion/core/services";

export interface ApiVariables {
  user: typeof auth.$Infer.Session.user | null;
  session: typeof auth.$Infer.Session.session | null;
}

export async function attachSession(c: Context<{ Variables: ApiVariables }>, next: () => Promise<void>) {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  c.set("user", session?.user ?? null);
  c.set("session", session?.session ?? null);
  if (session?.user) {
    await ensureUserBootstrap({
      id: session.user.id,
      email: session.user.email,
      name: session.user.name || session.user.email,
    });
  }
  await next();
}

export function actorFromContext(c: Context<{ Variables: ApiVariables }>): ActorContext {
  const user = c.get("user");
  if (!user) throw new Error("not authenticated");
  return { id: user.id, email: user.email, name: user.name || user.email };
}

export async function orgIdFromContext(c: Context<{ Variables: ApiVariables }>): Promise<string> {
  const actor = actorFromContext(c);
  const header = c.req.header("x-companion-org");
  const cookie = getCookie(c, "companion_org");
  const wanted = header || cookie || null;
  const orgs = await listOrgs(actor);
  if (wanted && !orgs.some((o) => o.org_id === wanted)) {
    throw new Error("selected organization is not available to the current user");
  }
  const current = wanted ? orgs.find((o) => o.org_id === wanted) : orgs[0];
  if (!current) throw new Error("no organization selected");
  return current.org_id;
}

export function jsonError(c: Context, error: unknown, status = 400): Response {
  const message = error instanceof Error ? error.message : String(error);
  return c.json({ ok: false, error: message }, status as never);
}
