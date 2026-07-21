import { getCookie } from "hono/cookie";
import type { Context } from "hono";
import type { TokenScope } from "@companion/contracts";
import { auth } from "@companion/auth";
import {
  ensureUserBootstrap,
  listOrgs,
  resolveApiToken,
  type ActorContext,
} from "@companion/core/services";
import { EntitlementDeniedError } from "@companion/core";

export interface ApiVariables {
  user: typeof auth.$Infer.Session.user | null;
  session: typeof auth.$Infer.Session.session | null;
  /** Set when the request authenticated with a `cmp_pat_…` bearer token instead of a cookie session. */
  tokenActor: ActorContext | null;
  tokenOrgId: string | null;
  tokenScopes: TokenScope[] | null;
}

/** Extract a bearer credential from an `Authorization` header, if present. */
export function bearerFromHeader(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1]!.trim() : null;
}

export async function attachSession(c: Context<{ Variables: ApiVariables }>, next: () => Promise<void>) {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  c.set("user", session?.user ?? null);
  c.set("session", session?.session ?? null);
  c.set("tokenActor", null);
  c.set("tokenOrgId", null);
  c.set("tokenScopes", null);
  if (session?.user) {
    await ensureUserBootstrap({
      id: session.user.id,
      email: session.user.email,
      name: session.user.name || session.user.email,
    });
  } else {
    // No cookie session — try a personal access token (programmatic publish/install).
    const bearer = bearerFromHeader(c.req.header("authorization"));
    if (bearer) {
      const resolved = await resolveApiToken(bearer);
      if (resolved) {
        c.set("tokenActor", resolved.actor);
        c.set("tokenOrgId", resolved.orgId);
        c.set("tokenScopes", resolved.scopes);
      }
    }
  }
  await next();
}

/**
 * Resolve the actor. Personal access tokens are opt-in (`allowToken`): by default a token-authed
 * request is rejected, so a scoped PAT can only reach the few endpoints that explicitly allow it
 * (the skills read/write surfaces) and never the org/team/member management endpoints.
 */
export function actorFromContext(
  c: Context<{ Variables: ApiVariables }>,
  allowToken = false,
): ActorContext {
  const user = c.get("user");
  if (user) return { id: user.id, email: user.email, name: user.name || user.email };
  const tokenActor = c.get("tokenActor");
  if (tokenActor) {
    if (!allowToken) throw new Error("personal access tokens are not allowed on this endpoint");
    return tokenActor;
  }
  throw new Error("not authenticated");
}

/** True when the request is authenticated by a personal access token rather than a cookie session. */
export function isTokenRequest(c: Context<{ Variables: ApiVariables }>): boolean {
  return !c.get("user") && !!c.get("tokenActor");
}

/**
 * Gate a capability for token-authed requests. Cookie sessions (a signed-in human) implicitly
 * hold every scope; a `cmp_pat_…` token must carry the requested scope. Call after the actor
 * is established.
 */
export function requireScope(c: Context<{ Variables: ApiVariables }>, scope: TokenScope): void {
  const scopes = c.get("tokenScopes");
  if (scopes === null) return; // cookie session → full access
  if (!scopes.includes(scope)) throw new Error(`token is missing the ${scope} scope`);
}

export async function orgIdFromContext(c: Context<{ Variables: ApiVariables }>): Promise<string> {
  // A token is bound to a single org — that binding wins over any header/cookie hint.
  const tokenOrgId = c.get("tokenOrgId");
  if (tokenOrgId) return tokenOrgId;
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
  if (error instanceof EntitlementDeniedError) {
    return c.json(error.body, 403);
  }
  const message = error instanceof Error ? error.message : String(error);
  return c.json({ ok: false, error: message }, status as never);
}
