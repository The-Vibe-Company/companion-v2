import { serve } from "@hono/node-server";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { setCookie } from "hono/cookie";
import {
  acceptInvitation,
  addComment,
  addTeamMember,
  createInvitation,
  createOrg,
  createTeam,
  getOrgSettings,
  getDownloadVersion,
  listOrgs,
  listSkillComments,
  listSkills,
  listSkillVersions,
  listTeamsForUser,
  publishSkillVersion,
  assertCanPublishSkillVersion,
  removeMember,
  removeTeamMember,
  revokeInvitation,
  setMemberRole,
  setSkillScope,
  setTeamMemberRole,
  toggleStar,
} from "@companion/core/services";
import { publishSkillInputSchema, scopeSchema } from "@companion/contracts";
import { deleteSkillArchive, skillArchiveKey, putSkillArchive, signedSkillArchiveUrl } from "@companion/storage";
import { isValidSemver, packDir, unpackTo, validateSkillArchive } from "@companion/skills";
import { withTenantContext, type Db } from "@companion/db";
import { auth } from "@companion/auth";
import { inviteEmail, sendTransactionalEmail } from "@companion/email";
import { actorFromContext, attachSession, jsonError, orgIdFromContext, type ApiVariables } from "./context";
import { appRouter } from "./trpc";

const app = new Hono<{ Variables: ApiVariables }>();

async function withTenant<T>(
  c: Context<{ Variables: ApiVariables }>,
  fn: (input: { actor: ReturnType<typeof actorFromContext>; orgId: string; database: Db }) => Promise<T>,
): Promise<T> {
  const actor = actorFromContext(c);
  const orgId = await orgIdFromContext(c);
  return withTenantContext({ orgId, userId: actor.id }, (database) => fn({ actor, orgId, database }));
}

async function canonicalizeSkillArchive(archive: Buffer) {
  const dir = await mkdtemp(join(tmpdir(), "companion-skill-"));
  try {
    await unpackTo(archive, dir);
    return await packDir(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

app.use(
  "*",
  cors({
    origin: [process.env.COMPANION_WEB_URL ?? "http://127.0.0.1:3000"],
    allowHeaders: ["Content-Type", "Authorization", "x-companion-org"],
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    credentials: true,
  }),
);

app.use("*", attachSession);

app.get("/health", (c) => c.json({ ok: true }));

app.on(["GET", "POST"], "/auth/*", (c) => auth.handler(c.req.raw));

app.all("/trpc/*", async (c) => {
  const actor = c.get("user")
    ? {
        id: c.get("user")!.id,
        email: c.get("user")!.email,
        name: c.get("user")!.name || c.get("user")!.email,
      }
    : null;
  let orgId: string | null = null;
  if (actor) {
    try {
      orgId = await orgIdFromContext(c);
    } catch {
      orgId = null;
    }
  }
  return fetchRequestHandler({
    endpoint: "/trpc",
    req: c.req.raw,
    router: appRouter,
    createContext: async () => ({ actor, orgId }),
  });
});

async function authForward(c: { req: { url: string; method: string; raw: Request } }, targetPath: string) {
  const url = new URL(c.req.url);
  url.pathname = targetPath;
  const response = await auth.handler(
    new Request(url, {
      method: c.req.method,
      headers: c.req.raw.headers,
      body: c.req.raw.body,
      redirect: "manual",
    }),
  );
  return response;
}

app.post("/v1/auth/login", (c) => authForward(c, "/auth/sign-in/email"));
app.post("/v1/auth/signup", (c) => authForward(c, "/auth/sign-up/email"));
app.post("/v1/auth/logout", (c) => authForward(c, "/auth/sign-out"));

function safeAuthNext(value: unknown): string {
  const next = typeof value === "string" ? value : "";
  if (!next.startsWith("/") || next.startsWith("//") || next.includes("\\")) {
    return "/skills";
  }

  try {
    const parsed = new URL(next, "http://companion.local");
    if (parsed.origin !== "http://companion.local") return "/skills";
    const pathname = parsed.pathname.toLowerCase();
    if (pathname.startsWith("/%2f") || pathname.startsWith("/%5c")) return "/skills";
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return "/skills";
  }
}

function authLoginUrl(next: string, mode: string, error: string): string {
  const params = new URLSearchParams({ next, mode, error });
  return `/login?${params.toString()}`;
}

function isAllowedAuthRedirectOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    const configuredWebUrl = process.env.COMPANION_WEB_URL ? new URL(process.env.COMPANION_WEB_URL).origin : null;
    if (configuredWebUrl && url.origin === configuredWebUrl) return true;
    if (process.env.NODE_ENV !== "production") {
      return ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
    }
  } catch {
    return false;
  }
  return false;
}

function authRedirectTarget(c: Context<{ Variables: ApiVariables }>, path: string): string {
  const origin = c.req.header("origin");
  if (origin && isAllowedAuthRedirectOrigin(origin)) {
    return new URL(path, origin).toString();
  }

  const referer = c.req.header("referer");
  if (referer && isAllowedAuthRedirectOrigin(referer)) {
    return new URL(path, new URL(referer).origin).toString();
  }

  return path;
}

function responseSetCookies(response: Response): string[] {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  const cookies = headers.getSetCookie?.();
  if (cookies?.length) return cookies;
  const cookie = response.headers.get("set-cookie");
  return cookie ? [cookie] : [];
}

app.post("/v1/auth/login-redirect", async (c) => {
  const form = await c.req.formData();
  const mode = form.get("mode") === "signup" ? "signup" : "signin";
  const next = safeAuthNext(form.get("next"));
  const email = String(form.get("email") ?? "");
  const password = String(form.get("password") ?? "");
  const name = String(form.get("name") || email.split("@")[0] || email);

  const url = new URL(c.req.url);
  url.pathname = mode === "signup" ? "/auth/sign-up/email" : "/auth/sign-in/email";
  const response = await auth.handler(
    new Request(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: c.req.header("origin") ?? process.env.COMPANION_WEB_URL ?? process.env.COMPANION_API_URL ?? url.origin,
      },
      body: JSON.stringify({ email, password, name }),
      redirect: "manual",
    }),
  );

  if (!response.ok) {
    const json = (await response.json().catch(() => ({}))) as { message?: string; error?: { message?: string } };
    return c.redirect(
      authRedirectTarget(c, authLoginUrl(next, mode, json.error?.message ?? json.message ?? "Authentication failed")),
      303,
    );
  }

  const redirect = c.redirect(authRedirectTarget(c, next), 303);
  for (const cookie of responseSetCookies(response)) {
    redirect.headers.append("set-cookie", cookie);
  }
  return redirect;
});

app.get("/v1/auth/whoami", async (c) => {
  try {
    const actor = actorFromContext(c);
    const orgs = await listOrgs(actor);
    const orgId = await orgIdFromContext(c).catch(() => null);
    const org = orgs.find((o) => o.org_id === orgId) ?? orgs[0] ?? null;
    return c.json({ userId: actor.id, email: actor.email, name: actor.name, org, role: org?.org_role ?? null });
  } catch (error) {
    return jsonError(c, error, 401);
  }
});

app.get("/v1/orgs", async (c) => {
  try {
    const actor = actorFromContext(c);
    return c.json(await listOrgs(actor));
  } catch (error) {
    return jsonError(c, error, 401);
  }
});

app.get("/v1/orgs/current/settings", async (c) => {
  try {
    return c.json(await withTenant(c, ({ actor, orgId, database }) => getOrgSettings({ actor, orgId, database })));
  } catch (error) {
    return jsonError(c, error, 401);
  }
});

app.post("/v1/orgs", async (c) => {
  try {
    const actor = actorFromContext(c);
    const body = await c.req.json<{ name: string; kind?: "personal" | "team" }>();
    return c.json(await createOrg({ actor, name: body.name, kind: body.kind ?? "team" }));
  } catch (error) {
    return jsonError(c, error);
  }
});

app.post("/v1/orgs/current", async (c) => {
  try {
    const actor = actorFromContext(c);
    const body = await c.req.json<{ orgId: string }>();
    const orgs = await listOrgs(actor);
    if (!orgs.some((org) => org.org_id === body.orgId)) {
      return jsonError(c, "selected organization is not available to the current user", 403);
    }
    setCookie(c, "companion_org", body.orgId, {
      path: "/",
      sameSite: "Lax",
      secure: process.env.NODE_ENV === "production",
      httpOnly: false,
    });
    return c.json({ ok: true });
  } catch (error) {
    return jsonError(c, error);
  }
});

app.get("/v1/teams", async (c) => {
  try {
    return c.json(await withTenant(c, ({ actor, orgId, database }) => listTeamsForUser({ actor, orgId, database })));
  } catch (error) {
    return jsonError(c, error, 401);
  }
});

app.post("/v1/teams", async (c) => {
  try {
    const body = await c.req.json<{ name: string }>();
    return c.json(await withTenant(c, ({ actor, orgId, database }) => createTeam({ actor, orgId, name: body.name, database })));
  } catch (error) {
    return jsonError(c, error);
  }
});

app.post("/v1/teams/:teamId/members", async (c) => {
  try {
    const body = await c.req.json<{ userId: string; role?: "admin" | "editor" | "reader" }>();
    await withTenant(c, ({ actor, orgId, database }) =>
      addTeamMember({ actor, orgId, teamId: c.req.param("teamId"), userId: body.userId, role: body.role ?? "reader", database }),
    );
    return c.json({ ok: true });
  } catch (error) {
    return jsonError(c, error);
  }
});

app.patch("/v1/teams/:teamId/members/:userId", async (c) => {
  try {
    const body = await c.req.json<{ role: "admin" | "editor" | "reader" }>();
    await withTenant(c, ({ actor, orgId, database }) =>
      setTeamMemberRole({ actor, orgId, teamId: c.req.param("teamId"), userId: c.req.param("userId"), role: body.role, database }),
    );
    return c.json({ ok: true });
  } catch (error) {
    return jsonError(c, error);
  }
});

app.delete("/v1/teams/:teamId/members/:userId", async (c) => {
  try {
    await withTenant(c, ({ actor, orgId, database }) =>
      removeTeamMember({ actor, orgId, teamId: c.req.param("teamId"), userId: c.req.param("userId"), database }),
    );
    return c.json({ ok: true });
  } catch (error) {
    return jsonError(c, error);
  }
});

app.post("/v1/invitations", async (c) => {
  let createdInvite: { id: string; token: string } | null = null;
  let createdOrgId: string | null = null;
  let createdActor: ReturnType<typeof actorFromContext> | null = null;
  try {
    const actor = actorFromContext(c);
    const orgId = await orgIdFromContext(c);
    createdActor = actor;
    createdOrgId = orgId;
    const body = await c.req.json<{ email: string; role?: "admin" | "developer" }>();
    const role = body.role ?? "developer";
    if (role !== "admin" && role !== "developer") throw new Error("invalid invitation role");
    const invite = await withTenantContext({ orgId, userId: actor.id }, (database) =>
      createInvitation({ actor, orgId, email: body.email, role, database }),
    );
    createdInvite = invite;
    const org = (await listOrgs(actor)).find((o) => o.org_id === orgId);
    const base = process.env.COMPANION_WEB_URL ?? "http://127.0.0.1:3000";
    await sendTransactionalEmail(
      inviteEmail({
        to: body.email,
        orgName: org?.name ?? "Companion",
        inviteUrl: `${base}/join/${invite.token}`,
      }),
    );
    return c.json(invite);
  } catch (error) {
    if (createdInvite && createdOrgId && createdActor) {
      await revokeInvitation({ actor: createdActor, orgId: createdOrgId, inviteId: createdInvite.id }).catch((cleanupError) => {
        console.error(`failed to revoke invitation ${createdInvite?.id} after email failure`, cleanupError);
      });
    }
    return jsonError(c, error);
  }
});

app.delete("/v1/invitations/:inviteId", async (c) => {
  try {
    await withTenant(c, ({ actor, orgId, database }) =>
      revokeInvitation({ actor, orgId, inviteId: c.req.param("inviteId"), database }),
    );
    return c.json({ ok: true });
  } catch (error) {
    return jsonError(c, error);
  }
});

app.post("/v1/invitations/accept", async (c) => {
  try {
    const actor = actorFromContext(c);
    const body = await c.req.json<{ token: string }>();
    return c.json(await acceptInvitation({ actor, token: body.token }));
  } catch (error) {
    return jsonError(c, error);
  }
});

app.patch("/v1/orgs/current/members/:userId", async (c) => {
  try {
    const body = await c.req.json<{ role: "owner" | "admin" | "developer" }>();
    await withTenant(c, ({ actor, orgId, database }) =>
      setMemberRole({ actor, orgId, userId: c.req.param("userId"), role: body.role, database }),
    );
    return c.json({ ok: true });
  } catch (error) {
    return jsonError(c, error);
  }
});

app.delete("/v1/orgs/current/members/:userId", async (c) => {
  try {
    await withTenant(c, ({ actor, orgId, database }) =>
      removeMember({ actor, orgId, userId: c.req.param("userId"), database }),
    );
    return c.json({ ok: true });
  } catch (error) {
    return jsonError(c, error);
  }
});

app.get("/v1/skills", async (c) => {
  try {
    const scopeRaw = c.req.query("scope");
    const scope = scopeRaw ? scopeSchema.parse(scopeRaw) : undefined;
    const mine = c.req.query("mine") === "true";
    return c.json(await withTenant(c, ({ actor, orgId, database }) => listSkills({ actor, orgId, scope, mine, database })));
  } catch (error) {
    return jsonError(c, error, 401);
  }
});

app.get("/v1/skills/:slug", async (c) => {
  try {
    const row = await withTenant(c, async ({ actor, orgId, database }) =>
      (await listSkills({ actor, orgId, database })).find((s) => s.slug === c.req.param("slug")),
    );
    if (!row) return jsonError(c, "skill not found", 404);
    return c.json(row);
  } catch (error) {
    return jsonError(c, error, 401);
  }
});

app.get("/v1/skills/:slug/versions", async (c) => {
  try {
    return c.json(await withTenant(c, ({ actor, orgId, database }) => listSkillVersions({ actor, orgId, slug: c.req.param("slug"), database })));
  } catch (error) {
    return jsonError(c, error);
  }
});

app.get("/v1/skills/:slug/comments", async (c) => {
  try {
    return c.json(await withTenant(c, ({ actor, orgId, database }) => listSkillComments({ actor, orgId, slug: c.req.param("slug"), database })));
  } catch (error) {
    return jsonError(c, error);
  }
});

app.post("/v1/skills/:slug/comments", async (c) => {
  try {
    const body = await c.req.json<{ body: string }>();
    return c.json(await withTenant(c, ({ actor, orgId, database }) => addComment({ actor, orgId, slug: c.req.param("slug"), body: body.body, database })));
  } catch (error) {
    return jsonError(c, error);
  }
});

app.post("/v1/skills/:slug/star", async (c) => {
  try {
    return c.json({ starred: await withTenant(c, ({ actor, orgId, database }) => toggleStar({ actor, orgId, slug: c.req.param("slug"), database })) });
  } catch (error) {
    return jsonError(c, error);
  }
});

app.put("/v1/skills/:slug/scope", async (c) => {
  try {
    const body = await c.req.json<{ scope: string; teamSlug?: string | null }>();
    await withTenant(c, ({ actor, orgId, database }) =>
      setSkillScope({
        actor,
        orgId,
        slug: c.req.param("slug"),
        scope: scopeSchema.parse(body.scope),
        teamSlug: body.teamSlug ?? null,
        database,
      }),
    );
    return c.json({ ok: true });
  } catch (error) {
    return jsonError(c, error);
  }
});

app.post("/v1/skills", async (c) => {
  try {
    const actor = actorFromContext(c);
    const orgId = await orgIdFromContext(c);
    const form = await c.req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) throw new Error("file is required");
    const archive = Buffer.from(await file.arrayBuffer());
    const result = await validateSkillArchive(archive);
    if (form.get("action") === "validate") return c.json({ result });
    if (!result.ok || !result.frontmatter) return c.json({ result, error: result.error ?? "validation failed" }, 422);
    const canonical = await canonicalizeSkillArchive(archive);
    const checksum = canonical.checksum;
    const fm = result.frontmatter;
    const scope = scopeSchema.parse(String(form.get("scope") ?? fm.scope ?? "private"));
    const teamSlug = scope === "team" ? String(form.get("team") ?? "") : null;
    const version = String(form.get("version") ?? fm.version);
    if (!isValidSemver(version)) throw new Error(`invalid semver: ${version}`);
    const key = skillArchiveKey({ orgId, slug: fm.name, version });
    const payload = publishSkillInputSchema.parse({
      slug: fm.name,
      scope,
      team_slug: teamSlug,
      version,
      description: fm.description,
      checksum,
      storage_path: key,
      size_bytes: canonical.sizeBytes,
      frontmatter: JSON.stringify(fm, null, 2),
      tools: fm.tools,
      license: fm.license ?? null,
      note: String(form.get("message") ?? ""),
    });
    await withTenantContext({ orgId, userId: actor.id }, (database) =>
      assertCanPublishSkillVersion({ actor, orgId, payload, database }),
    );
    await putSkillArchive({ key, body: canonical.archive, preventOverwrite: true });
    let published: Awaited<ReturnType<typeof publishSkillVersion>>;
    try {
      published = await withTenantContext({ orgId, userId: actor.id }, (database) =>
        publishSkillVersion({ actor, orgId, payload, archiveKey: key, database }),
      );
    } catch (error) {
      await deleteSkillArchive({ key }).catch((cleanupError) => {
        console.error(`failed to delete orphaned skill archive ${key}`, cleanupError);
      });
      throw error;
    }
    return c.json({ ok: true, ...published, checksum });
  } catch (error) {
    return jsonError(c, error);
  }
});

app.get("/v1/skills/:slug/download", async (c) => {
  try {
    const version = c.req.query("version") ?? null;
    const found = await withTenant(c, ({ actor, orgId, database }) =>
      getDownloadVersion({ actor, orgId, slug: c.req.param("slug"), version, database }),
    );
    const url = await signedSkillArchiveUrl({ key: found.storagePath });
    return c.json({ ...found, url });
  } catch (error) {
    return jsonError(c, error);
  }
});

const port = Number(process.env.COMPANION_API_PORT ?? process.env.PORT ?? 3001);
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`Companion API listening on http://127.0.0.1:${info.port}`);
});
