import { serve } from "@hono/node-server";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { setCookie } from "hono/cookie";
import {
  acceptInvitation,
  addComment,
  addTeamMember,
  createInvitation,
  createOrg,
  createTeam,
  getSkillFilterPreferences,
  getOrgSettings,
  getDownloadVersion,
  issueApiToken,
  listOrgs,
  listSkillComments,
  listSkills,
  listSkillVersions,
  listTeamsForUser,
  publishSkillVersion,
  assertCanPublishSkillVersion,
  removeMember,
  removeTeamMember,
  revokeApiToken,
  revokeInvitation,
  setMemberRole,
  setSkillFilterPreferences,
  setSkillScope,
  setTeamMemberRole,
  toggleStar,
} from "@companion/core/services";
import {
  createSkillInputSchema,
  issueTokenInputSchema,
  publishSkillInputSchema,
  scopeSchema,
  skillFilterPreferencesSchema,
  type Scope,
  type SkillFrontmatter,
} from "@companion/contracts";
import {
  deleteSkillArchive,
  getSkillArchive,
  skillArchiveKey,
  putSkillArchive,
  signedSkillArchiveUrl,
} from "@companion/storage";
import {
  bumpSemver,
  compareSemver,
  isValidSemver,
  packDir,
  tarGzToZip,
  unpackAnyTo,
  validateSkillArchive,
} from "@companion/skills";
import { withTenantContext, type Db } from "@companion/db";
import { auth } from "@companion/auth";
import { inviteEmail, sendTransactionalEmail } from "@companion/email";
import {
  actorFromContext,
  attachSession,
  isTokenRequest,
  jsonError,
  orgIdFromContext,
  requireScope,
  type ApiVariables,
} from "./context";
import { appRouter } from "./trpc";

const app = new Hono<{ Variables: ApiVariables }>();

async function withTenant<T>(
  c: Context<{ Variables: ApiVariables }>,
  fn: (input: { actor: ReturnType<typeof actorFromContext>; orgId: string; database: Db }) => Promise<T>,
  allowToken = false,
): Promise<T> {
  const actor = actorFromContext(c, allowToken);
  const orgId = await orgIdFromContext(c);
  return withTenantContext({ orgId, userId: actor.id }, (database) => fn({ actor, orgId, database }));
}

async function canonicalizeSkillArchive(archive: Buffer) {
  const dir = await mkdtemp(join(tmpdir(), "companion-skill-"));
  try {
    await unpackAnyTo(archive, dir);
    return await packDir(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Assemble a standard SKILL.md from inline fields. The registry sets the version, not the author. */
function buildSkillMd(id: string, version: string, description: string, body: string): string {
  const front = ["---", `name: ${id}`, `version: ${version}`, `description: ${JSON.stringify(description)}`, "---"].join("\n");
  return `${front}\n\n${body.trim()}\n`;
}

/**
 * Shared publish tail: store the canonical archive (idempotently) and write a new
 * skill_versions row, authorizing first and cleaning up the blob on failure.
 */
async function publishCanonical(input: {
  actor: ReturnType<typeof actorFromContext>;
  orgId: string;
  canonical: Awaited<ReturnType<typeof packDir>>;
  fm: SkillFrontmatter;
  scope: Scope;
  teamSlug: string | null;
  version: string;
  note: string;
}): Promise<{ id: string; slug: string; version: string; checksum: string }> {
  const { actor, orgId, canonical, fm, scope, teamSlug, version, note } = input;
  if (!isValidSemver(version)) throw new Error(`invalid semver: ${version}`);
  const key = skillArchiveKey({ orgId, slug: fm.name, version });
  const payload = publishSkillInputSchema.parse({
    slug: fm.name,
    scope,
    team_slug: teamSlug,
    version,
    description: fm.description,
    checksum: canonical.checksum,
    storage_path: key,
    size_bytes: canonical.sizeBytes,
    frontmatter: JSON.stringify(fm, null, 2),
    tools: fm.tools,
    license: fm.license ?? null,
    note,
  });
  await withTenantContext({ orgId, userId: actor.id }, (database) =>
    assertCanPublishSkillVersion({ actor, orgId, payload, database }),
  );
  await putSkillArchive({ key, body: canonical.archive, preventOverwrite: true });
  try {
    const published = await withTenantContext({ orgId, userId: actor.id }, (database) =>
      publishSkillVersion({ actor, orgId, payload, archiveKey: key, database }),
    );
    return { ...published, slug: fm.name, checksum: canonical.checksum };
  } catch (error) {
    await deleteSkillArchive({ key }).catch((cleanupError) => {
      console.error(`failed to delete orphaned skill archive ${key}`, cleanupError);
    });
    throw error;
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

app.get("/v1/skill-filter-preferences", async (c) => {
  try {
    return c.json(await withTenant(c, ({ actor, orgId, database }) => getSkillFilterPreferences({ actor, orgId, database })));
  } catch (error) {
    return jsonError(c, error, 401);
  }
});

app.put("/v1/skill-filter-preferences", async (c) => {
  let body: ReturnType<typeof skillFilterPreferencesSchema.parse>;
  try {
    body = skillFilterPreferencesSchema.parse(await c.req.json());
  } catch (error) {
    return jsonError(c, error);
  }
  try {
    return c.json(
      await withTenant(c, ({ actor, orgId, database }) =>
        setSkillFilterPreferences({ actor, orgId, preferences: body, database }),
      ),
    );
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

/**
 * Publish a packaged skill. Two body shapes:
 *  - multipart/form-data (browser dropzone / CLI): `file` + `action`/`scope`/`team`/`version`/`message`.
 *  - raw `application/zip` or `application/gzip` (guided-prompt curl + Bearer token): the body IS the
 *    archive; `visibility`/`team`/`version`/`message` come from query params.
 * Accepts `.zip` or `.tar.gz`. Requires the `skills:write` scope for token-authed requests.
 * Bodies above 32 MB are rejected with 413 before buffering (just over the 25 MB archive cap).
 */
app.post("/v1/skills", bodyLimit({ maxSize: 32 * 1024 * 1024, onError: (c) => jsonError(c, "package exceeds the 32 MB upload limit", 413) }), async (c) => {
  try {
    const actor = actorFromContext(c, true);
    requireScope(c, "skills:write");
    const orgId = await orgIdFromContext(c);
    const contentType = c.req.header("content-type") ?? "";

    let archive: Buffer;
    let action: string;
    let scopeRaw: string | undefined;
    let teamRaw: string | undefined;
    let versionRaw: string | undefined;
    let messageRaw: string | undefined;
    let expectSlug: string | undefined;

    if (contentType.includes("multipart/form-data")) {
      const form = await c.req.formData();
      const file = form.get("file");
      if (!(file instanceof File)) throw new Error("file is required");
      archive = Buffer.from(await file.arrayBuffer());
      const field = (k: string) => {
        const v = form.get(k);
        return v != null && String(v) !== "" ? String(v) : undefined;
      };
      action = field("action") ?? "publish";
      scopeRaw = field("scope") ?? field("visibility");
      teamRaw = field("team");
      versionRaw = field("version");
      messageRaw = field("message");
      expectSlug = field("expect_slug");
    } else {
      archive = Buffer.from(await c.req.arrayBuffer());
      if (!archive.length) throw new Error("request body is empty");
      action = c.req.query("action") ?? "publish";
      scopeRaw = c.req.query("visibility") ?? c.req.query("scope");
      teamRaw = c.req.query("team");
      versionRaw = c.req.query("version");
      messageRaw = c.req.query("message");
      expectSlug = c.req.query("expect_slug");
    }

    const result = await validateSkillArchive(archive);
    if (action === "validate") return c.json({ result });
    if (!result.ok || !result.frontmatter) {
      return c.json({ result, error: result.error ?? "validation failed" }, 422);
    }
    const fm = result.frontmatter;
    // When updating a known skill, the uploaded package must be that skill (its frontmatter
    // `name` is the slug the server publishes), so an upload can never silently target another id.
    if (expectSlug && fm.name !== expectSlug) {
      return c.json(
        { error: `package name "${fm.name}" does not match the skill you are updating ("${expectSlug}")` },
        422,
      );
    }
    const canonical = await canonicalizeSkillArchive(archive);
    const scope = scopeSchema.parse(scopeRaw ?? fm.scope ?? "private");
    const teamSlug = scope === "team" ? String(teamRaw ?? "") : null;
    const version = versionRaw ?? fm.version;
    const published = await publishCanonical({
      actor,
      orgId,
      canonical,
      fm,
      scope,
      teamSlug,
      version,
      note: messageRaw ?? "",
    });
    return c.json({ ok: true, ...published });
  } catch (error) {
    return jsonError(c, error);
  }
});

/** Author a SKILL.md inline ("Create in the browser") — new skill → 1.0.0, existing → patch-bump. */
app.post("/v1/skills/create", bodyLimit({ maxSize: 2 * 1024 * 1024, onError: (c) => jsonError(c, "request exceeds the 2 MB limit", 413) }), async (c) => {
  try {
    const actor = actorFromContext(c, true);
    requireScope(c, "skills:write");
    const orgId = await orgIdFromContext(c);
    const input = createSkillInputSchema.parse(await c.req.json());
    const version = await withTenantContext({ orgId, userId: actor.id }, async (database) => {
      const existing = await listSkillVersions({ actor, orgId, slug: input.id, database }).catch(() => []);
      // Bump from the highest existing version by semver (not row order).
      const latest = existing.map((v) => v.version).sort((a, b) => compareSemver(b, a))[0];
      return latest ? bumpSemver(latest, "patch") : "1.0.0";
    });
    const dir = await mkdtemp(join(tmpdir(), "companion-skill-"));
    try {
      await writeFile(join(dir, "SKILL.md"), buildSkillMd(input.id, version, input.description, input.body), "utf8");
      const canonical = await packDir(dir);
      const result = await validateSkillArchive(canonical.archive);
      if (!result.ok || !result.frontmatter) {
        return c.json({ result, error: result.error ?? "validation failed" }, 422);
      }
      const teamSlug = input.scope === "team" ? String(input.team ?? "") : null;
      const published = await publishCanonical({
        actor,
        orgId,
        canonical,
        fm: result.frontmatter,
        scope: input.scope,
        teamSlug,
        version,
        note: "",
      });
      return c.json({ ok: true, ...published });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  } catch (error) {
    return jsonError(c, error);
  }
});

app.get("/v1/skills/:slug/download", async (c) => {
  try {
    actorFromContext(c, true);
    requireScope(c, "skills:read");
    const version = c.req.query("version") ?? null;
    const found = await withTenant(
      c,
      ({ actor, orgId, database }) =>
        getDownloadVersion({ actor, orgId, slug: c.req.param("slug"), version, database }),
      true,
    );
    const url = await signedSkillArchiveUrl({ key: found.storagePath });
    return c.json({ ...found, url });
  } catch (error) {
    return jsonError(c, error);
  }
});

/**
 * Download a specific version as a `.zip` (the install flow's `curl … -o <id>.zip` + "Download
 * package" button). Visibility-gated; requires `skills:read` for token-authed callers.
 */
app.get("/v1/skills/:slug/versions/:version/package", async (c) => {
  try {
    actorFromContext(c, true);
    requireScope(c, "skills:read");
    const slug = c.req.param("slug");
    const found = await withTenant(
      c,
      ({ actor, orgId, database }) =>
        getDownloadVersion({ actor, orgId, slug, version: c.req.param("version"), database }),
      true,
    );
    const tarGz = await getSkillArchive({ key: found.storagePath });
    const zip = await tarGzToZip(tarGz);
    return new Response(new Uint8Array(zip), {
      headers: {
        "content-type": "application/zip",
        "content-disposition": `attachment; filename="${slug}.zip"`,
        "content-length": String(zip.length),
      },
    });
  } catch (error) {
    return jsonError(c, error);
  }
});

/**
 * Issue a short-lived scoped personal access token for the guided-prompt / install flows.
 * Cookie session only — a token cannot mint another token. The plaintext is returned once.
 */
app.post("/v1/tokens", async (c) => {
  try {
    if (isTokenRequest(c)) throw new Error("personal access tokens cannot issue tokens");
    const input = issueTokenInputSchema.parse(await c.req.json());
    const issued = await withTenant(c, ({ actor, orgId, database }) =>
      issueApiToken({ actor, orgId, scopes: input.scopes, name: input.name, database }),
    );
    return c.json({
      id: issued.id,
      token: issued.token,
      prefix: issued.prefix,
      scopes: issued.scopes,
      expires_at: issued.expiresAt.toISOString(),
    });
  } catch (error) {
    return jsonError(c, error);
  }
});

app.delete("/v1/tokens/:id", async (c) => {
  try {
    if (isTokenRequest(c)) throw new Error("personal access tokens cannot revoke tokens");
    await withTenant(c, ({ actor, orgId, database }) =>
      revokeApiToken({ actor, orgId, tokenId: c.req.param("id"), database }),
    );
    return c.json({ ok: true });
  } catch (error) {
    return jsonError(c, error);
  }
});

const port = Number(process.env.COMPANION_API_PORT ?? process.env.PORT ?? 3001);
const hostname = process.env.COMPANION_API_HOST;
serve({ fetch: app.fetch, port, ...(hostname ? { hostname } : {}) }, (info) => {
  console.log(`Companion API listening on ${hostname ? `http://${hostname}:${info.port}` : `port ${info.port}`}`);
});
