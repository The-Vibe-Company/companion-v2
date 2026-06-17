import { serve } from "@hono/node-server";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  addOrgAccessDomain,
  addTeamMember,
  archiveSkill,
  buildDependencyPlan,
  completeOnboarding,
  createInvitation,
  createOrg,
  createTeam,
  deleteTeam,
  DependencyPublishError,
  computeLocalSkillStatus,
  getLocalSkillInstall,
  getOnboardingContext,
  getOnboardingState,
  getSkillBySlug,
  getSkillDependencies,
  restoreSkill,
  getSkillFilterPreferences,
  getOrgSettings,
  getDownloadVersion,
  getOrgLogoAsset,
  issueApiToken,
  joinOrgByDomain,
  listApiTokens,
  listOrgs,
  listSkillComments,
  listSkills,
  listSkillVersions,
  listTeamsForUser,
  publishSkillVersion,
  assertCanPublishSkillVersion,
  reportLocalSkillInstall,
  removeOrgAccessDomain,
  removeMember,
  removeTeamMember,
  revokeApiToken,
  revokeInvitation,
  setCommentDeprecated,
  setMemberRole,
  setSkillFilterPreferences,
  setSkillVisibility,
  setTeamMemberRole,
  setOrgLogoFromUpload,
  orgLogoPublicPath,
  toggleStar,
  installSkill,
  uninstallSkill,
  updateOrg,
  updateTeam,
  updateUserProfile,
} from "@companion/core/services";
import {
  addCommentInputSchema,
  addOrgAccessDomainInputSchema,
  archiveSkillInputSchema,
  completeOnboardingInputSchema,
  createSkillInputSchema,
  issueTokenInputSchema,
  joinOnboardingOrgInputSchema,
  orgSettingsResponseSchema,
  publishSkillInputSchema,
  reportLocalSkillInstallInputSchema,
  reportSkillInstallInputSchema,
  setCommentDeprecatedInputSchema,
  setSkillVisibilityInputSchema,
  skillFrontmatterSchema,
  skillVisibilityInputSchema,
  visibilityFilterSchema,
  skillFilterPreferencesSchema,
  fallbackCompanionManifest,
  updateOrgInputSchema,
  updateTeamInputSchema,
  resolveOrgLogoContentType,
  updateUserProfileInputSchema,
  type CompanionManifest,
  type SkillVisibilityInput,
  type SkillFrontmatter,
} from "@companion/contracts";
import {
  deleteSkillArchive,
  getSkillArchive,
  getOrgLogo,
  putOrgLogo,
  skillArchiveKey,
  putSkillArchive,
  signedSkillArchiveUrl,
} from "@companion/storage";
import {
  bumpSemver,
  compareSemver,
  extractArchiveFiles,
  isValidSemver,
  buildNormalizedCompanionJson,
  buildNormalizedSkillMd,
  packDir,
  prepareSkillDirForPublish,
  toStoredSkillVersionManifest,
  tarGzToZip,
  toTar,
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
import { assertTargetedSkillUpdate, parseSkillPublishAction } from "./skillPublishGuards";
import { buildInlineCompanionManifest, uploadDependencyValues } from "./skillCompanionManifest";
import { buildSkillUploadOptions } from "./skillUploadOptions";
import { buildCompanionSkillRow, getCompanionSkillPackage } from "./companionSkillPackage";
import { COMPANION_SKILL_KEY } from "@companion/companion-skill";

const app = new Hono<{ Variables: ApiVariables }>();

/** Set the `companion_org` selection cookie (readable client-side, so not httpOnly). */
function setOrgCookie(c: Context<{ Variables: ApiVariables }>, orgId: string): void {
  setCookie(c, "companion_org", orgId, {
    path: "/",
    sameSite: "Lax",
    secure: process.env.NODE_ENV === "production",
    httpOnly: false,
  });
}

async function withTenant<T>(
  c: Context<{ Variables: ApiVariables }>,
  fn: (input: { actor: ReturnType<typeof actorFromContext>; orgId: string; database: Db }) => Promise<T>,
  allowToken = false,
): Promise<T> {
  const actor = actorFromContext(c, allowToken);
  const orgId = await orgIdFromContext(c);
  return withTenantContext({ orgId, userId: actor.id }, (database) => fn({ actor, orgId, database }));
}

async function canonicalizeSkillArchive(
  archive: Buffer,
  companion: { skillId: string; version: string },
  overrides: { dependencies?: string[] } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), "companion-skill-"));
  try {
    await unpackAnyTo(archive, dir);
    const prepared = await prepareSkillDirForPublish(dir, companion);
    const companionManifest = overrides.dependencies
      ? fallbackCompanionManifest({
          summary: prepared.companionManifest.display.summary ?? prepared.frontmatter.description,
          display: prepared.companionManifest.display,
          requirements: prepared.companionManifest.requirements,
          dependencies: overrides.dependencies,
        })
      : prepared.companionManifest;
    if (overrides.dependencies) {
      await writeFile(prepared.companionManifestPath, buildNormalizedCompanionJson(companionManifest), "utf8");
    }
    const canonical = await packDir(prepared.rootDir);
    return { canonical, frontmatter: prepared.frontmatter, companionManifest };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Assemble a standard SKILL.md from inline fields. The registry sets the version, not the author. */
function buildSkillMd(
  id: string,
  description: string,
  body: string,
  companion: { skillId: string; version: string },
): string {
  const frontmatter = skillFrontmatterSchema.parse({
    name: id,
    description,
    metadata: {
      companion_skill_id: companion.skillId,
      companion_version: companion.version,
    },
  });
  return buildNormalizedSkillMd(frontmatter, body);
}

function skillSummary(fm: SkillFrontmatter, manifest: CompanionManifest): string {
  return manifest.display.summary ?? fm.description;
}

async function resolvePublishTarget(input: {
  actor: ReturnType<typeof actorFromContext>;
  orgId: string;
  slug: string;
  explicitVersion?: string;
  metadataVersion?: string;
  metadataSkillId?: string;
  legacyVersion?: string;
}): Promise<{ skillId: string; version: string }> {
  return withTenantContext({ orgId: input.orgId, userId: input.actor.id }, async (database) => {
    const existing = await getSkillBySlug({ actor: input.actor, orgId: input.orgId, slug: input.slug, database });
    const metadataIsPublishedProvenance = Boolean(existing && input.metadataSkillId);
    const candidate =
      input.explicitVersion ??
      (metadataIsPublishedProvenance ? undefined : input.metadataVersion) ??
      input.legacyVersion;
    if (candidate) {
      if (!isValidSemver(candidate)) throw new Error(`invalid semver: ${candidate}`);
      return { skillId: existing?.id ?? randomUUID(), version: candidate };
    }
    if (!existing) return { skillId: randomUUID(), version: "1.0.0" };
    const versions = await listSkillVersions({ actor: input.actor, orgId: input.orgId, slug: input.slug, database });
    const latest = versions.map((v) => v.version).sort((a, b) => compareSemver(b, a))[0];
    return { skillId: existing.id, version: latest ? bumpSemver(latest, "patch") : "1.0.0" };
  });
}

function parseBoolean(value: string | undefined): boolean {
  if (value == null || value === "") return false;
  if (["true", "1", "yes", "on"].includes(value.toLowerCase())) return true;
  if (["false", "0", "no", "off"].includes(value.toLowerCase())) return false;
  throw new Error("everyone must be true or false");
}

function parseTeamValues(values: Array<string | undefined>): string[] {
  return [
    ...new Set(
      values
        .filter((v): v is string => !!v)
        .flatMap((v) => v.split(","))
        .map((v) => v.trim())
        .filter(Boolean),
    ),
  ];
}

function rejectLegacySkillVisibilityInput(hasField: (name: string) => boolean): void {
  if (hasField("scope") || hasField("visibility")) {
    throw new Error("legacy skill scope/visibility inputs are not supported; use everyone and team fields");
  }
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
  companionManifest: CompanionManifest;
  skillId: string;
  ownerTeam?: string | null;
  visibility: SkillVisibilityInput;
  version: string;
  note: string;
  dependencies?: string[];
}): Promise<{ id: string; slug: string; version: string; checksum: string; sizeBytes: number }> {
  const { actor, orgId, canonical, fm, companionManifest, skillId, ownerTeam, visibility, version, note, dependencies } = input;
  if (!isValidSemver(version)) throw new Error(`invalid semver: ${version}`);
  const key = skillArchiveKey({ orgId, slug: fm.name, version });
  const payload = publishSkillInputSchema.parse({
    skill_id: skillId,
    slug: fm.name,
    owner_team: ownerTeam,
    visibility,
    version,
    description: skillSummary(fm, companionManifest),
    checksum: canonical.checksum,
    storage_path: key,
    size_bytes: canonical.sizeBytes,
    frontmatter: JSON.stringify(toStoredSkillVersionManifest(fm, companionManifest), null, 2),
    tools: fm.allowedTools,
    license: fm.license ?? null,
    note,
    dependencies: dependencies ?? [],
  });
  await withTenantContext({ orgId, userId: actor.id }, (database) =>
    assertCanPublishSkillVersion({ actor, orgId, payload, database }),
  );
  await putSkillArchive({ key, body: canonical.archive, preventOverwrite: true });
  try {
    const published = await withTenantContext({ orgId, userId: actor.id }, (database) =>
      publishSkillVersion({ actor, orgId, payload, archiveKey: key, database }),
    );
    return { ...published, slug: fm.name, checksum: canonical.checksum, sizeBytes: canonical.sizeBytes };
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
    const { onboarded } = await getOnboardingState(actor);
    return c.json({
      userId: actor.id,
      email: actor.email,
      name: actor.name,
      org,
      role: org?.org_role ?? null,
      onboarded,
      needsOnboarding: !onboarded,
    });
  } catch (error) {
    return jsonError(c, error, 401);
  }
});

app.put("/v1/users/me", async (c) => {
  try {
    if (isTokenRequest(c)) throw new Error("personal access tokens cannot update the profile");
    const actor = actorFromContext(c);
    const input = updateUserProfileInputSchema.parse(await c.req.json());
    // `profiles` carries no RLS (keyed by the auth user id), so this is not org-scoped.
    const profile = await updateUserProfile({ actor, name: input.name });
    // Best-effort: keep the Better Auth `user.name` in sync so the session display name matches.
    // `core` stays auth-free; the sync lives here in the route. A failure must not fail the request.
    await auth.api
      .updateUser({ headers: c.req.raw.headers, body: { name: profile.name } })
      .catch((authError) => {
        console.error("failed to sync Better Auth user name", authError);
      });
    return c.json(profile);
  } catch (error) {
    return jsonError(c, error);
  }
});

app.get("/v1/onboarding/context", async (c) => {
  try {
    const actor = actorFromContext(c);
    const ctx = await getOnboardingContext(actor);
    return c.json({
      email: ctx.email,
      domain: ctx.domain,
      is_personal: ctx.isPersonal,
      matched_orgs: ctx.matchedOrgs.map((org) => ({
        id: org.id,
        name: org.name,
        domain: org.domain,
        member_count: org.memberCount,
        team_count: org.teamCount,
      })),
    });
  } catch (error) {
    return jsonError(c, error, 401);
  }
});

app.post("/v1/onboarding/join", async (c) => {
  try {
    const actor = actorFromContext(c);
    const input = joinOnboardingOrgInputSchema.parse(await c.req.json());
    const { orgId } = await joinOrgByDomain(actor, input.orgId);
    setOrgCookie(c, orgId);
    return c.json({ ok: true, orgId });
  } catch (error) {
    return jsonError(c, error);
  }
});

app.post("/v1/onboarding/create", async (c) => {
  try {
    const actor = actorFromContext(c);
    const input = completeOnboardingInputSchema.parse(await c.req.json());
    const { orgId, inviteTokens } = await completeOnboarding(actor, input);
    setOrgCookie(c, orgId);
    // Best-effort invite emails: a bounced address must NOT undo the org/team the user just created
    // (this intentionally diverges from /v1/invitations, which rolls a single invite back on failure).
    const base = process.env.COMPANION_WEB_URL ?? "http://127.0.0.1:3000";
    for (const { email, token } of inviteTokens) {
      await sendTransactionalEmail(
        inviteEmail({ to: email, orgName: input.org.name, inviteUrl: `${base}/join/${token}` }),
      ).catch((emailError) => {
        console.error(`onboarding invite email to ${email} failed`, emailError);
      });
    }
    return c.json({ ok: true, orgId, invited: inviteTokens.map((t) => t.email) });
  } catch (error) {
    return jsonError(c, error);
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
    const settings = await withTenant(c, ({ actor, orgId, database }) => getOrgSettings({ actor, orgId, database }));
    const parsed = orgSettingsResponseSchema.safeParse(settings);
    if (!parsed.success) {
      console.error(
        "Invalid org settings response",
        parsed.error.issues.slice(0, 5).map((issue) => ({
          path: issue.path.join(".") || "<root>",
          message: issue.message,
        })),
      );
      return jsonError(c, "Companion API produced an invalid settings response.", 500);
    }
    return c.json(parsed.data);
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
    setOrgCookie(c, body.orgId);
    return c.json({ ok: true });
  } catch (error) {
    return jsonError(c, error);
  }
});

app.put("/v1/orgs/current", async (c) => {
  try {
    if (isTokenRequest(c)) throw new Error("personal access tokens cannot update the workspace");
    const input = updateOrgInputSchema.parse(await c.req.json());
    return c.json(
      await withTenant(c, ({ actor, orgId, database }) =>
        updateOrg({
          actor,
          orgId,
          name: input.name,
          slug: input.slug,
          color: input.color,
          logoUrl: input.logoUrl,
          database,
        }),
      ),
    );
  } catch (error) {
    return jsonError(c, error);
  }
});

app.post("/v1/orgs/current/domains", async (c) => {
  try {
    if (isTokenRequest(c)) throw new Error("personal access tokens cannot manage workspace domains");
    const input = addOrgAccessDomainInputSchema.parse(await c.req.json());
    return c.json(await withTenant(c, ({ actor, orgId, database }) => addOrgAccessDomain({ actor, orgId, domain: input.domain, database })));
  } catch (error) {
    return jsonError(c, error);
  }
});

app.delete("/v1/orgs/current/domains/:domainId", async (c) => {
  try {
    if (isTokenRequest(c)) throw new Error("personal access tokens cannot manage workspace domains");
    await withTenant(c, ({ actor, orgId, database }) =>
      removeOrgAccessDomain({ actor, orgId, domainId: c.req.param("domainId"), database }),
    );
    return c.json({ ok: true });
  } catch (error) {
    return jsonError(c, error);
  }
});

/** Upload a workspace logo image (once — while no logo is configured). */
app.post(
  "/v1/orgs/current/logo",
  bodyLimit({ maxSize: 2 * 1024 * 1024, onError: (c) => jsonError(c, "logo exceeds the 2 MB upload limit", 413) }),
  async (c) => {
    try {
      if (isTokenRequest(c)) throw new Error("personal access tokens cannot update the workspace");
      const file = (await c.req.formData()).get("file");
      if (!(file instanceof File)) throw new Error("file is required");
      const contentType = resolveOrgLogoContentType(file);
      if (!contentType) throw new Error("logo must be a PNG, JPEG, WebP, or GIF image");
      const body = Buffer.from(await file.arrayBuffer());
      if (!body.length) throw new Error("file is empty");

      return c.json(
        await withTenant(c, async ({ actor, orgId, database }) => {
          await putOrgLogo({ orgId, body, contentType });
          return setOrgLogoFromUpload({ actor, orgId, logoUrl: orgLogoPublicPath(orgId), database });
        }),
      );
    } catch (error) {
      return jsonError(c, error);
    }
  },
);

/** Serve a hosted workspace logo binary for org members. */
app.get("/v1/orgs/:orgId/logo", async (c) => {
  try {
    const actor = actorFromContext(c, true);
    const orgId = c.req.param("orgId");
    await getOrgLogoAsset({ actor, orgId });
    const asset = await getOrgLogo({ orgId });
    if (!asset) return c.json({ error: "logo not found" }, 404);
    return new Response(asset.body, {
      headers: {
        "Content-Type": asset.contentType,
        "Cache-Control": "private, no-cache",
      },
    });
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

app.put("/v1/teams/:teamId", async (c) => {
  try {
    if (isTokenRequest(c)) throw new Error("personal access tokens cannot update teams");
    const input = updateTeamInputSchema.parse(await c.req.json());
    return c.json(
      await withTenant(c, ({ actor, orgId, database }) =>
        updateTeam({
          actor,
          orgId,
          teamId: c.req.param("teamId"),
          name: input.name,
          slug: input.slug,
          description: input.description,
          color: input.color,
          icon: input.icon,
          database,
        }),
      ),
    );
  } catch (error) {
    return jsonError(c, error);
  }
});

app.delete("/v1/teams/:teamId", async (c) => {
  try {
    if (isTokenRequest(c)) throw new Error("personal access tokens cannot delete teams");
    await withTenant(c, ({ actor, orgId, database }) =>
      deleteTeam({ actor, orgId, teamId: c.req.param("teamId"), database }),
    );
    return c.json({ ok: true });
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
    const visibilityRaw = c.req.query("visibility");
    const visibility = visibilityRaw ? visibilityFilterSchema.parse(visibilityRaw) : undefined;
    const mine = c.req.query("mine") === "true";
    const archived = c.req.query("archived") === "true";
    return c.json(
      await withTenant(c, ({ actor, orgId, database }) => listSkills({ actor, orgId, visibility, mine, archived, database })),
    );
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

/**
 * Skills-scoped upload choices for assistants. This deliberately lives under `/skills` rather than
 * opening the general team-management surface to PATs: a read/write skill token can list the teams
 * it may present as owner/share choices, but cannot manage those teams.
 */
app.get("/v1/skills/upload-options", async (c) => {
  try {
    actorFromContext(c, true);
    requireScope(c, "skills:write");
    const teams = await withTenant(
      c,
      ({ actor, orgId, database }) => listTeamsForUser({ actor, orgId, database }),
      true,
    );
    return c.json(buildSkillUploadOptions(teams));
  } catch (error) {
    return jsonError(c, error, 401);
  }
});

app.get("/v1/skills/:slug", async (c) => {
  try {
    // Resolve archived skills too — they stay viewable, so the canonical detail endpoint must
    // return them (getSkillBySlug includes archived).
    const row = await withTenant(c, ({ actor, orgId, database }) =>
      getSkillBySlug({ actor, orgId, slug: c.req.param("slug"), database }),
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
    const input = addCommentInputSchema.parse(await c.req.json());
    return c.json(
      await withTenant(c, ({ actor, orgId, database }) =>
        addComment({
          actor,
          orgId,
          slug: c.req.param("slug"),
          body: input.body,
          parentId: input.parent_id ?? null,
          versionId: input.version_id ?? null,
          database,
        }),
      ),
    );
  } catch (error) {
    return jsonError(c, error);
  }
});

app.patch("/v1/skills/:slug/comments/:id", async (c) => {
  try {
    const input = setCommentDeprecatedInputSchema.parse(await c.req.json());
    return c.json(
      await withTenant(c, ({ actor, orgId, database }) =>
        setCommentDeprecated({
          actor,
          orgId,
          slug: c.req.param("slug"),
          commentId: c.req.param("id"),
          deprecated: input.deprecated,
          database,
        }),
      ),
    );
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

/**
 * Record a published skill as installed for the caller. The assistant posts here at the end of the
 * normal install flow (`source: "agent"`); a member can also hand-mark via the UI (`source: "manual"`,
 * e.g. installed another way). This is per-member personal state (like a star) that only affects the
 * caller's own view, so `skills:read` suffices — the install prompt's download token can report
 * without ever holding publish/archive/visibility authority. Visibility is still enforced via the slug.
 */
app.post("/v1/skills/:slug/install", async (c) => {
  try {
    actorFromContext(c, true);
    requireScope(c, "skills:read");
    let input;
    try {
      // An empty body is a valid bare "mark installed"; malformed JSON is an error, not an empty mark.
      const raw = await c.req.text();
      input = reportSkillInstallInputSchema.parse(raw.trim() ? JSON.parse(raw) : {});
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 422);
    }
    const result = await withTenant(
      c,
      ({ actor, orgId, database }) =>
        installSkill({
          actor,
          orgId,
          slug: c.req.param("slug"),
          version: input.version ?? null,
          agentLabel: input.agent ?? null,
          source: input.source ?? "manual",
          database,
        }),
      true,
    );
    return c.json({
      ok: true as const,
      installed: true as const,
      status: result.status,
      installed_version: result.installedVersion,
      current_version: result.currentVersion,
    });
  } catch (error) {
    return jsonError(c, error);
  }
});

/** Mark a published skill NOT installed for the caller (uninstall / correct a false state). */
app.delete("/v1/skills/:slug/install", async (c) => {
  try {
    actorFromContext(c, true);
    requireScope(c, "skills:read");
    await withTenant(
      c,
      ({ actor, orgId, database }) => uninstallSkill({ actor, orgId, slug: c.req.param("slug"), database }),
      true,
    );
    return c.json({ ok: true as const, installed: false as const, status: "none" as const });
  } catch (error) {
    return jsonError(c, error);
  }
});

app.put("/v1/skills/:slug/visibility", async (c) => {
  try {
    actorFromContext(c, true);
    requireScope(c, "skills:write");
    const { cascade, ...visibility } = setSkillVisibilityInputSchema.parse(await c.req.json());
    const { cascaded } = await withTenant(
      c,
      ({ actor, orgId, database }) =>
        setSkillVisibility({
          actor,
          orgId,
          slug: c.req.param("slug"),
          visibility,
          cascade,
          database,
        }),
      true,
    );
    return c.json({ ok: true, cascaded });
  } catch (error) {
    return jsonError(c, error);
  }
});

/** Requires + Used by graph for a skill (optionally a specific version). Session or skills:read PAT. */
app.get("/v1/skills/:slug/dependencies", async (c) => {
  try {
    actorFromContext(c, true);
    requireScope(c, "skills:read");
    const version = c.req.query("version") ?? null;
    return c.json(
      await withTenant(
        c,
        ({ actor, orgId, database }) =>
          getSkillDependencies({ actor, orgId, slug: c.req.param("slug"), version, database }),
        true,
      ),
    );
  } catch (error) {
    return jsonError(c, error);
  }
});

/** Archive a skill — hides it from normal lists but keeps it viewable/restorable/downloadable. */
app.post("/v1/skills/:slug/archive", async (c) => {
  try {
    actorFromContext(c, true);
    requireScope(c, "skills:write");
    const body = archiveSkillInputSchema.parse(await c.req.json().catch(() => ({})));
    await withTenant(
      c,
      ({ actor, orgId, database }) =>
        archiveSkill({ actor, orgId, slug: c.req.param("slug"), reason: body.reason, database }),
      true,
    );
    return c.json({ ok: true });
  } catch (error) {
    return jsonError(c, error);
  }
});

/** Restore an archived skill back into the normal lists. */
app.post("/v1/skills/:slug/restore", async (c) => {
  try {
    actorFromContext(c, true);
    requireScope(c, "skills:write");
    await withTenant(
      c,
      ({ actor, orgId, database }) => restoreSkill({ actor, orgId, slug: c.req.param("slug"), database }),
      true,
    );
    return c.json({ ok: true });
  } catch (error) {
    return jsonError(c, error);
  }
});

/**
 * Publish a packaged skill. Two body shapes:
 *  - multipart/form-data (browser dropzone / CLI): `file` + `action`/`everyone`/`team`/`version`/`message`.
 *  - raw `application/zip` or `application/gzip` (guided assistant + Bearer token): the body IS the
 *    archive; `everyone`/`team`/`version`/`message` come from query params.
 * `action=validate` runs the same package and targeted identity checks without publishing.
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
    let everyoneRaw: string | undefined;
    let teamValues: string[] = [];
    let versionRaw: string | undefined;
    let messageRaw: string | undefined;
    let expectSlug: string | undefined;
    let expectSkillId: string | undefined;
    let ownerTeamRaw: string | undefined;
    let dependencyValues: string[] = [];

    if (contentType.includes("multipart/form-data")) {
      const form = await c.req.formData();
      rejectLegacySkillVisibilityInput((name) => form.has(name));
      const file = form.get("file");
      if (!(file instanceof File)) throw new Error("file is required");
      archive = Buffer.from(await file.arrayBuffer());
      const field = (k: string) => {
        const v = form.get(k);
        return v != null && String(v) !== "" ? String(v) : undefined;
      };
      action = field("action") ?? "publish";
      everyoneRaw = field("everyone");
      teamValues = parseTeamValues([...form.getAll("team"), ...form.getAll("teams")].map((v) => String(v)));
      versionRaw = field("version");
      messageRaw = field("message");
      expectSlug = field("expect_slug");
      expectSkillId = field("expect_skill_id");
      ownerTeamRaw = field("owner_team");
      dependencyValues = parseTeamValues([...form.getAll("dependency"), ...form.getAll("dependencies")].map((v) => String(v)));
    } else {
      const url = new URL(c.req.url);
      rejectLegacySkillVisibilityInput((name) => url.searchParams.has(name));
      archive = Buffer.from(await c.req.arrayBuffer());
      if (!archive.length) throw new Error("request body is empty");
      action = c.req.query("action") ?? "publish";
      everyoneRaw = c.req.query("everyone");
      teamValues = parseTeamValues([...url.searchParams.getAll("team"), ...url.searchParams.getAll("teams")]);
      versionRaw = c.req.query("version");
      messageRaw = c.req.query("message");
      expectSlug = c.req.query("expect_slug");
      expectSkillId = c.req.query("expect_skill_id");
      ownerTeamRaw = c.req.query("owner_team");
      dependencyValues = parseTeamValues([...url.searchParams.getAll("dependency"), ...url.searchParams.getAll("dependencies")]);
    }

    let parsedAction;
    try {
      parsedAction = parseSkillPublishAction(action);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }

    const result = await validateSkillArchive(archive);
    if (!result.ok || !result.frontmatter) {
      if (parsedAction === "validate") return c.json({ result });
      return c.json({ result, error: result.error ?? "validation failed" }, 422);
    }
    const fm = result.frontmatter;
    // When updating a known skill, bind the upload to both the slug and, when supplied, the
    // Companion skill UUID. Metadata is optional for old packages, but cannot point elsewhere.
    if (expectSlug || expectSkillId) {
      const expectedSkill = await getSkillBySlug({
        actor,
        orgId,
        slug: expectSlug ?? fm.name,
      });
      try {
        assertTargetedSkillUpdate({
          frontmatter: fm,
          expectSlug,
          expectSkillId,
          expectedSkill,
        });
      } catch (error) {
        return c.json({ result, error: error instanceof Error ? error.message : String(error) }, 422);
      }
    }
    // companion.json is the preferred dependency source. Legacy dependency= query params remain a
    // fallback for old clients that upload packages without a Companion manifest.
    dependencyValues = uploadDependencyValues({
      queryDependencies: dependencyValues,
      companionManifestPath: result.companion_manifest_path,
      companionManifest: result.companion_manifest,
    });
    const visibility = skillVisibilityInputSchema.parse({ everyone: parseBoolean(everyoneRaw), teams: teamValues });
    // Dependency preflight: which declared deps are published / must be uploaded / dropped, plus any
    // blockers (missing / cycle / visibility). Computed for both validate (preview) and publish.
    const dependencyPlan = await withTenant(
      c,
      ({ actor: a, orgId: o, database }) =>
        buildDependencyPlan({
          actor: a,
          orgId: o,
          slug: fm.name,
          declaredSlugs: dependencyValues,
          visibility,
          ownerTeamSlug: ownerTeamRaw ?? null,
          database,
        }),
      true,
    );
    if (parsedAction === "validate") return c.json({ result, dependency_plan: dependencyPlan });
    const target = await resolvePublishTarget({
      actor,
      orgId,
      slug: fm.name,
      explicitVersion: versionRaw,
      metadataVersion: fm.metadata.companion_version,
      metadataSkillId: fm.metadata.companion_skill_id,
      legacyVersion: result.legacy?.version,
    });
    const normalized = await canonicalizeSkillArchive(archive, {
      skillId: target.skillId,
      version: target.version,
    }, result.companion_manifest_path === null ? { dependencies: dependencyValues } : {});
    const normalizedResult = await validateSkillArchive(normalized.canonical.archive);
    if (!normalizedResult.ok || !normalizedResult.frontmatter) {
      return c.json({ result: normalizedResult, error: normalizedResult.error ?? "validation failed after normalization" }, 422);
    }
    let published;
    try {
      published = await publishCanonical({
        actor,
        orgId,
        canonical: normalized.canonical,
        fm: normalized.frontmatter,
        companionManifest: normalized.companionManifest,
        skillId: target.skillId,
        ownerTeam: ownerTeamRaw,
        visibility,
        version: target.version,
        note: messageRaw ?? "",
        dependencies: normalized.companionManifest.dependencies,
      });
    } catch (error) {
      // Unresolved dependencies (missing / cycle / visibility) — surface the plan, don't 500.
      if (error instanceof DependencyPublishError) {
        return c.json({ error: error.message, dependency_plan: error.plan }, 422);
      }
      throw error;
    }
    return c.json({ ok: true, ...published, dependency_plan: dependencyPlan, warnings: result.warnings ?? [] });
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
    const target = await resolvePublishTarget({
      actor,
      orgId,
      slug: input.id,
    });
    // Edit-in-browser reuses this endpoint to publish a new version of an existing skill. Carry
    // forward the current version's declared dependencies and requirements (declared secrets/env
    // setup notes) so an inline edit never silently drops them — this path rebuilds the frontmatter
    // from id/description/body alone (there is no companion.json or frontmatter editor here).
    const { carriedDependencies, carriedRequirements, carriedDisplay } = await withTenant(
      c,
      async ({ actor: a, orgId: o, database }) => {
        const existing = await getSkillBySlug({ actor: a, orgId: o, slug: input.id, database });
        if (!existing?.current_version) return { carriedDependencies: [], carriedRequirements: [], carriedDisplay: null };
        const deps = await getSkillDependencies({ actor: a, orgId: o, slug: input.id, database });
        return {
          carriedDependencies: deps.requires.map((r) => r.slug),
          carriedRequirements: existing.requirements,
          carriedDisplay: existing.display,
        };
      },
      true,
    );
    const companionManifest = buildInlineCompanionManifest({
      description: input.description,
      carriedDisplay,
      carriedRequirements,
      carriedDependencies,
    });
    const dir = await mkdtemp(join(tmpdir(), "companion-skill-"));
    try {
      await writeFile(join(dir, "SKILL.md"), buildSkillMd(input.id, input.description, input.body, target), "utf8");
      await writeFile(join(dir, "companion.json"), buildNormalizedCompanionJson(companionManifest), "utf8");
      const canonical = await packDir(dir);
      const result = await validateSkillArchive(canonical.archive);
      if (!result.ok || !result.frontmatter) {
        return c.json({ result, error: result.error ?? "validation failed" }, 422);
      }
      const published = await publishCanonical({
        actor,
        orgId,
        canonical,
        fm: result.frontmatter,
        companionManifest,
        skillId: target.skillId,
        ownerTeam: input.owner_team,
        visibility: input.visibility,
        version: target.version,
        note: "",
        dependencies: carriedDependencies,
      });
      return c.json({ ok: true, ...published, warnings: result.warnings ?? [] });
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
 * Download a specific version as a `.zip` for assistant or direct-download installs.
 * Visibility-gated; requires `skills:read` for token-authed callers.
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
 * Read every (non-directory) file in a specific version's package into memory for the in-app
 * file explorer. Visibility-gated like `/package`; requires `skills:read` for token-authed callers.
 * Text files are returned UTF-8-decoded (capped); binaries/over-cap files carry `content: null`.
 */
app.get("/v1/skills/:slug/versions/:version/files", async (c) => {
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
    const tar = toTar(tarGz);
    const { files } = await extractArchiveFiles(tar);
    return c.json({ version: found.version, files });
  } catch (error) {
    return jsonError(c, error);
  }
});

/**
 * "Companion skills" (local skills) — the built-in helper-skill catalog. Currently one entry,
 * `companion`. Status is per-member: the skill reports its install via the endpoint below, and the
 * view compares the reported version against the bundled package version. Session or token
 * (`skills:read`); a read+write token (the one the install prompt mints) satisfies the gate.
 */
app.get("/v1/local-skills", async (c) => {
  try {
    actorFromContext(c, true);
    requireScope(c, "skills:read");
    const install = await withTenant(
      c,
      ({ actor, orgId, database }) =>
        getLocalSkillInstall({ actor, orgId, skillKey: COMPANION_SKILL_KEY, database }),
      true,
    );
    return c.json([await buildCompanionSkillRow(install)]);
  } catch (error) {
    return jsonError(c, error, 401);
  }
});

app.get("/v1/local-skills/:key", async (c) => {
  try {
    actorFromContext(c, true);
    requireScope(c, "skills:read");
    const key = c.req.param("key");
    if (key !== COMPANION_SKILL_KEY) return c.json({ error: `unknown local skill: ${key}` }, 404);
    const install = await withTenant(
      c,
      ({ actor, orgId, database }) => getLocalSkillInstall({ actor, orgId, skillKey: key, database }),
      true,
    );
    return c.json(await buildCompanionSkillRow(install));
  } catch (error) {
    return jsonError(c, error, 401);
  }
});

/** Download the bundled local skill as a `.zip` for the assistant to unpack. Auth like skill packages. */
app.get("/v1/local-skills/:key/package", async (c) => {
  try {
    actorFromContext(c, true);
    requireScope(c, "skills:read");
    const key = c.req.param("key");
    if (key !== COMPANION_SKILL_KEY) return c.json({ error: `unknown local skill: ${key}` }, 404);
    const pkg = await getCompanionSkillPackage();
    const zip = await tarGzToZip(pkg.archive);
    return new Response(new Uint8Array(zip), {
      headers: {
        "content-type": "application/zip",
        "content-disposition": `attachment; filename="${key}.zip"`,
        "content-length": String(zip.length),
        "x-skill-checksum": pkg.checksum,
        "x-skill-version": pkg.version,
      },
    });
  } catch (error) {
    return jsonError(c, error);
  }
});

/**
 * The install callback. The local skill posts here at the end of its install (and after updates) to
 * record that this member has it, and at which version. This mutates workspace state (and writes an
 * audit row), so token callers need `skills:write` — a read-only PAT cannot report/spoof an install.
 * The install prompt mints a read+write token, so the skill satisfies this.
 */
app.post("/v1/local-skills/:key/installed", async (c) => {
  try {
    actorFromContext(c, true);
    requireScope(c, "skills:write");
    const key = c.req.param("key");
    if (key !== COMPANION_SKILL_KEY) return c.json({ error: `unknown local skill: ${key}` }, 404);
    let input;
    try {
      input = reportLocalSkillInstallInputSchema.parse(await c.req.json());
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 422);
    }
    const pkg = await getCompanionSkillPackage();
    // The workspace only serves the bundled version, so a report newer than it cannot be real; reject
    // it rather than let a typo/bogus version (e.g. 999.0.0) silently suppress update prompts forever.
    if (compareSemver(input.version, pkg.version) > 0) {
      return c.json(
        { error: `reported version ${input.version} is newer than the available version ${pkg.version}` },
        422,
      );
    }
    const install = await withTenant(
      c,
      ({ actor, orgId, database }) =>
        reportLocalSkillInstall({
          actor,
          orgId,
          skillKey: key,
          version: input.version,
          agentLabel: input.agent ?? null,
          database,
        }),
      true,
    );
    return c.json({
      ok: true as const,
      status: computeLocalSkillStatus(install.installedVersion, pkg.version),
      availableVersion: pkg.version,
    });
  } catch (error) {
    return jsonError(c, error);
  }
});

/**
 * List the caller's personal access tokens for the settings UI. Cookie session only — a PAT cannot
 * enumerate tokens. Developers see only their own; org admins see all in the org. No secret is returned.
 */
app.get("/v1/tokens", async (c) => {
  try {
    if (isTokenRequest(c)) throw new Error("personal access tokens cannot list tokens");
    return c.json(await withTenant(c, ({ actor, orgId, database }) => listApiTokens({ actor, orgId, database })));
  } catch (error) {
    return jsonError(c, error, 401);
  }
});

/**
 * Issue a scoped personal access token for the guided-prompt / install flows.
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
