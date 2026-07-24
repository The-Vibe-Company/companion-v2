import { serve } from "@hono/node-server";
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { getCookie, setCookie } from "hono/cookie";
import {
  acceptInvitation,
  addComment,
  assertCommentTarget,
  addOrgAccessDomain,
  archiveSkill,
  assignLabel,
  buildDependencyPlan,
  buildSkillSharePlan,
  authorizePublicSkillPackageForSession,
  clearSkillPublicVersion,
  completeOnboarding,
  createPublicSkillTransferTicket,
  createLocalSkillDownloadTransferTicket,
  createSkillDownloadTransferTicket,
  createSkillFileDownloadTransferTicket,
  createSkillUploadTransferTicket,
  createInvitation,
  createLabel,
  createOrg,
  consumePublicSkillTransferTicket,
  consumeSkillPackageTransferTicket,
  preflightSkillPackageTransferTicket,
  revalidateAgentTransferTicket,
  deleteLabel,
  DependencyPublishError,
  computeLocalSkillStatus,
  getLocalSkillInstall,
  getOnboardingContext,
  getOnboardingState,
  getSkillBySlug,
  getSkillById,
  getSkillDependencies,
  restoreSkill,
  getSkillFilterPreferences,
  getOrgSettings,
  getSkillNamingPolicy,
  getDownloadVersion,
  getCommentImageAsset,
  getOrgLogoAsset,
  getSkillPublicPreviewByShareToken,
  getSkillShareTargetByShareToken,
  ApiTokenRefreshError,
  issueApiToken,
  joinOrgByDomain,
  listApiTokens,
  listLabels,
  listOrgs,
  listSkillComments,
  listSkills,
  listSkillVersions,
  publishSkillVersion,
  assertCanPublishSkillVersion,
  prepareSkillPublishDependencies,
  refreshApiToken,
  renameSkill,
  renameLabel,
  reportLocalSkillInstall,
  removeOrgAccessDomain,
  removeMember,
  revokeApiToken,
  revokeInvitation,
  setCommentDeprecated,
  setLabelColor,
  setLabelIcon,
  setMemberRole,
  setSkillFilterPreferences,
  setSkillPublicVersion,
  setOrgLogoFromUpload,
  orgLogoPublicPath,
  setUserAvatarFromUpload,
  clearUserAvatar,
  getUserAvatarAsset,
  getMyAvatarUrl,
  shareSkill,
  installSkill,
  unassignLabel,
  uninstallSkill,
  updateOrg,
  updateUserProfile,
  listPersonalLabels,
  createPersonalLabel,
  assignPersonalLabel,
  unassignPersonalLabel,
  setPersonalLabelColor,
  setPersonalLabelIcon,
  renamePersonalLabel,
  deletePersonalLabel,
  connectedOrgProviderIds,
  connectedProviderIds,
  deleteOrgProviderConnection,
  deleteProviderConnection,
  listOrgProviderConnections,
  listProviderConnections,
  setOrgProviderConnection,
  setProviderConnection,
  getActivatedModels,
  setUserActivatedModels,
  setOrgActivatedModels,
  listProjects,
  getProject,
  getProjectCreateReplay,
  createProject,
  updateProject,
  retryProjectWorkspace,
  setProjectSkills,
  requestProjectDeletion,
  listProjectSessions,
  updateProjectSession,
  getProjectSession,
  getProjectPromptAttachment,
  createProjectSession,
  enqueueProjectPrompt,
  hasProjectPromptIdempotencyKey,
  reserveProjectAttachmentUploads,
  reserveProjectFileUploads,
  commitProjectFileUploads,
  requestProjectSessionStop,
  listProjectSessionEvents,
  listProjectFiles,
  getProjectFile,
  listProjectFileVersions,
  getProjectFileVersion,
  isProjectWorkerReady,
  ProjectConflictError,
  ProjectNotFoundError,
  ProjectValidationError,
  getRunOptions,
  listRunConfigurations,
  createRunConfiguration,
  updateRunConfiguration,
  deleteRunConfiguration,
  createRun,
  createRunPrewarm,
  heartbeatRunPrewarm,
  cancelRunPrewarm,
  enqueueRunPrompt,
  preflightRunPromptUpload,
  reserveRunAttachmentUploads,
  requestRunPromptCancellation,
  requestRunCancellation,
  listRunEvents,
  listRuns,
  getRun,
  getRunAttachment,
  getRunArtifact,
  detectRunFileType,
  isRunWorkerReady,
  RunBusyError,
  RunValidationError,
  type RunControlContext,
  listSecrets,
  getSecret,
  createSecret,
  updateSecret,
  rotateSecret,
  deleteSecret,
  getSkillSecretConfiguration,
  setSkillSecretBinding,
  removeSkillSecretBinding,
  setSkillSecretSuggestion,
  removeSkillSecretSuggestion,
  acceptSkillSecretSuggestion,
  preflightSecretRetrieval,
  createSecretRetrievalGrant,
  redeemSecretRetrievalGrant,
  createGitHubDestination,
  deleteGitHubConnection,
  deleteGitHubDestination,
  getGitHubIntegration,
  getGitHubSkillSyncOverview,
  getGitHubUserCredential,
  GitHubSkillSyncConflictError,
  GitHubSkillSyncNotFoundError,
  refreshGitHubConnectionCredential,
  requestGitHubDestinationSync,
  saveGitHubConnection,
  setGitHubDestinationSkillSelection,
  updateGitHubDestination,
  SkillPublicReleaseConflictError,
  SkillPublicReleaseForbiddenError,
  SkillPublicReleaseNotFoundError,
  SkillPublicReleaseValidationError,
} from "@companion/core/services";
import {
  SecretConfigurationError,
  hasInternalProductAccess,
  loadSecretsMasterKey,
} from "@companion/core";
import {
  addCommentInputSchema,
  addOrgAccessDomainInputSchema,
  archiveSkillInputSchema,
  assignLabelInputSchema,
  completeOnboardingInputSchema,
  createLabelInputSchema,
  createSkillInputSchema,
  deleteLabelInputSchema,
  issueTokenInputSchema,
  refreshTokenResponseSchema,
  joinOnboardingOrgInputSchema,
  labelPathSchema,
  orgSettingsResponseSchema,
  skillNamingPolicyResponseSchema,
  publishSkillInputSchema,
  renameSkillInputSchema,
  renameLabelInputSchema,
  reportLocalSkillInstallInputSchema,
  reportSkillInstallInputSchema,
  setCommentDeprecatedInputSchema,
  setLabelColorInputSchema,
  setLabelIconInputSchema,
  skillFrontmatterSchema,
  skillFilterPreferencesInputSchema,
  companionDependencySlugs,
  companionManifestV2JsonSchema,
  updateOrgInputSchema,
  resolveOrgLogoContentType,
  resolveUserAvatarContentType,
  MAX_USER_AVATAR_BYTES,
  resolveCommentImageContentType,
  sniffCommentImageMime,
  MAX_COMMENT_IMAGES,
  MAX_COMMENT_IMAGE_BYTES,
  updateUserProfileInputSchema,
  setModelProviderConnectionInputSchema,
  setSkillPublicVersionInputSchema,
  setActivatedModelsInputSchema,
  createProjectInputSchema,
  updateProjectInputSchema,
  updateProjectSessionInputSchema,
  listProjectsQuerySchema,
  listProjectSessionsQuerySchema,
  setProjectSkillsInputSchema,
  createProjectSessionFieldsSchema,
  projectPromptFieldsSchema,
  PROJECT_ATTACHMENT_MAX_FILES,
  PROJECT_ATTACHMENT_MAX_BYTES,
  launchRunFieldsSchema,
  runPromptFieldsSchema,
  runPromptInputSchema,
  createRunConfigurationInputSchema,
  updateRunConfigurationInputSchema,
  deleteRunConfigurationInputSchema,
  RUN_ATTACHMENT_MAX_FILES,
  RUN_ATTACHMENT_MAX_BYTES,
  type CompanionManifest,
  type SkillFrontmatter,
  type SkillScope,
  type RunFilePreviewKind,
  createSecretInputSchema,
  updateSecretInputSchema,
  rotateSecretInputSchema,
  setSecretBindingInputSchema,
  setSecretSuggestionInputSchema,
  secretRetrievalPreflightInputSchema,
  redeemSecretGrantInputSchema,
  runPreferencesSchema,
  createGitHubDestinationInputSchema,
  createGitHubRepositoryInputSchema,
  requestGitHubDestinationSyncInputSchema,
  updateGitHubDestinationInputSchema,
} from "@companion/contracts";
import { GitHubOAuthClient, githubOAuthConfig, githubSyncEnabled } from "@companion/github";
import { createModelCatalog } from "@companion/sandbox";
import {
  commentImageKey,
  projectAttachmentKey,
  projectFileCacheKey,
  runAttachmentKey,
  deleteSkillArchive,
  getSkillArchive,
  headSkillArchive,
  InvalidSkillArchiveRangeError,
  isStoragePreconditionFailure,
  getOrgLogo,
  publicSkillReleaseKey,
  putPublicSkillReleaseSnapshot,
  putOrgLogo,
  putUserAvatar,
  getUserAvatar,
  deleteUserAvatar,
  skillArchiveKey,
  putSkillArchive,
  resolveSkillArchiveByteRange,
  signedSkillArchiveUrl,
  streamSkillArchive,
} from "@companion/storage";
import {
  bumpSemver,
  compareSemver,
  extractArchiveFileContent,
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
import { sql as postgresSql, withTenantContext, type Db } from "@companion/db";
import { auth, registerAgentCapabilityExecutor } from "@companion/auth";
import { inviteEmail, sendTransactionalEmail } from "@companion/email";
import {
  actorFromContext,
  attachSession,
  bearerFromHeader,
  isAgentRequest,
  isTokenRequest,
  jsonError,
  orgIdFromContext,
  requireScope,
  type ApiVariables,
} from "./context";
import { appRouter } from "./trpc";
import { assertNoCompanionRetarget, assertTargetedSkillUpdate, assertUpdateIsTargeted, parseSkillPublishAction } from "./skillPublishGuards";
import { buildInlineCompanionManifest, uploadDependencyValues, withResolvedManifestDependencies } from "./skillCompanionManifest";
import { buildCompanionSkillRow, getCompanionSkillPackage } from "./companionSkillPackage";
import { parseSkillListQuery } from "./skillListQuery";
import {
  parseLastEventId,
  parseRunEventNotification,
  runDrainAction,
  runEventFrame,
  runReadyFrame,
} from "./runEvents";
import { registerAgentAuthRoutes } from "./agentAuthRoutes";
import {
  deterministicRunAttachmentId,
  putRunAttachmentOnce,
} from "./runAttachments";
import {
  deterministicProjectAttachmentId,
  putProjectAttachmentOnce,
} from "./projectAttachments";
import {
  parseProjectEventNotification,
  parseProjectLastEventId,
  projectEventFrame,
  projectReadyFrame,
} from "./projectEvents";
import { COMPANION_SKILL_KEY } from "@companion/companion-skill";
import { StripeBillingGateway } from "@companion/billing";
import {
  billingRuntimeConfig,
  assertBillingEnvironmentConfigured,
  BillingPreviewProviderError,
  createBillingCheckout,
  createBillingPortal,
  getBillingPreview,
  getBillingPreviewSource,
  getBillingOverview,
  getRunPreferences,
  processStripeWebhook,
  updateRunPreferences,
} from "@companion/core";

const app = new Hono<{ Variables: ApiVariables }>();

export { app };

function capabilityRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function assertCapabilityWorkspace(grant: { constraints?: unknown }, workspaceId: unknown): asserts workspaceId is string {
  if (typeof workspaceId !== "string" || !workspaceId.trim()) {
    throw new Error("a workspaceId constraint is required");
  }
  const constraints = capabilityRecord(grant.constraints);
  const constrained = constraints?.workspaceId;
  const exact = typeof constrained === "string"
    ? constrained
    : capabilityRecord(constrained)?.eq;
  if (exact !== workspaceId) throw new Error("capability grant does not allow this workspace");
}

registerAgentCapabilityExecutor(
  "public-skills:install",
  async ({ arguments: capabilityArguments, session, grant }) => {
    const token = capabilityArguments?.token;
    const version = capabilityArguments?.version;
    if (typeof token !== "string" || typeof version !== "string" || !token.trim() || !version.trim()) {
      throw new Error("public-skills:install requires an exact token and version");
    }
    return createPublicSkillTransferTicket({
      token,
      version,
      userId: session.user.id,
      agentId: session.agentId,
      agentGrantId: grant.id,
    });
  },
);

registerAgentCapabilityExecutor(
  "skills:read",
  async ({ arguments: capabilityArguments, session, grant }) => {
    const workspaceId = capabilityArguments?.workspaceId;
    assertCapabilityWorkspace(grant, workspaceId);
    const transfer = capabilityRecord(capabilityArguments?.transfer);
    if (!transfer) {
      return { ok: true, capability: "skills:read", transport: "companion-rest", workspace_id: workspaceId };
    }
    if (
      !["download", "download-file", "download-local"].includes(String(transfer.action))
      || typeof transfer.slug !== "string"
      || typeof transfer.version !== "string"
      || (transfer.action === "download-file" && typeof transfer.path !== "string")
    ) {
      throw new Error("skills:read transfer requires an exact package/file kind, slug/key, version, and file path when applicable");
    }
    const actor = {
      id: session.user.id,
      email: session.user.email,
      name: session.user.name || session.user.email,
    };
    if (transfer.action === "download-local") {
      if (transfer.slug !== COMPANION_SKILL_KEY) throw new Error(`unknown local skill: ${transfer.slug}`);
      const pkg = await getCompanionSkillPackage();
      if (pkg.version !== transfer.version) {
        throw new Error(`local skill version ${transfer.version} is not available`);
      }
      const checksum = `sha256:${createHash("sha256").update(pkg.zip).digest("hex")}`;
      return withTenantContext({ orgId: workspaceId, userId: actor.id }, (database) =>
        createLocalSkillDownloadTransferTicket({
          actor,
          orgId: workspaceId,
          key: transfer.slug as string,
          version: transfer.version as string,
          packageChecksum: checksum,
          packageSizeBytes: pkg.zip.length,
          agentId: session.agentId,
          agentGrantId: grant.id,
          database,
        }),
      );
    }
    const found = await withTenantContext({ orgId: workspaceId, userId: actor.id }, (database) =>
      getDownloadVersion({
        actor,
        orgId: workspaceId,
        slug: transfer.slug as string,
        version: transfer.version as string,
        database,
      }),
    );
    if (transfer.action === "download-file") {
      const file = await extractArchiveFileContent(
        toTar(await getSkillArchive({ key: found.storagePath })),
        transfer.path as string,
      );
      if (file.status !== "ok") throw new Error(file.message);
      const checksum = `sha256:${createHash("sha256").update(file.bytes).digest("hex")}`;
      return withTenantContext({ orgId: workspaceId, userId: actor.id }, (database) =>
        createSkillFileDownloadTransferTicket({
          actor,
          orgId: workspaceId,
          slug: transfer.slug as string,
          version: transfer.version as string,
          filePath: file.path,
          storagePath: found.storagePath,
          fileChecksum: checksum,
          fileSizeBytes: file.bytes.length,
          agentId: session.agentId,
          agentGrantId: grant.id,
          database,
        }),
      );
    }
    const zip = await tarGzToZip(await getSkillArchive({ key: found.storagePath }));
    const checksum = `sha256:${createHash("sha256").update(zip).digest("hex")}`;
    return withTenantContext({ orgId: workspaceId, userId: actor.id }, (database) =>
      createSkillDownloadTransferTicket({
        actor,
        orgId: workspaceId,
        slug: transfer.slug as string,
        version: transfer.version as string,
        storagePath: found.storagePath,
        packageChecksum: checksum,
        packageSizeBytes: zip.length,
        agentId: session.agentId,
        agentGrantId: grant.id,
        database,
      }),
    );
  },
);

registerAgentCapabilityExecutor(
  "skills:write",
  async ({ arguments: capabilityArguments, session, grant }) => {
    const workspaceId = capabilityArguments?.workspaceId;
    assertCapabilityWorkspace(grant, workspaceId);
    const transfer = capabilityRecord(capabilityArguments?.transfer);
    if (!transfer) {
      return { ok: true, capability: "skills:write", transport: "companion-rest", workspace_id: workspaceId };
    }
    if (
      transfer.action !== "upload"
      || typeof transfer.slug !== "string"
      || typeof transfer.version !== "string"
      || typeof transfer.checksum !== "string"
      || typeof transfer.sizeBytes !== "number"
    ) {
      throw new Error("skills:write transfer requires upload slug, version, checksum, and sizeBytes");
    }
    const actor = {
      id: session.user.id,
      email: session.user.email,
      name: session.user.name || session.user.email,
    };
    return withTenantContext({ orgId: workspaceId, userId: actor.id }, (database) =>
      createSkillUploadTransferTicket({
        actor,
        orgId: workspaceId,
        slug: transfer.slug as string,
        version: transfer.version as string,
        packageChecksum: transfer.checksum as string,
        packageSizeBytes: transfer.sizeBytes as number,
        agentId: session.agentId,
        agentGrantId: grant.id,
        database,
      }),
    );
  },
);

function stripeBillingGateway(): StripeBillingGateway {
  const secretKey = process.env.STRIPE_SECRET_KEY?.trim();
  const priceId = process.env.STRIPE_PRO_PRICE_ID?.trim();
  const portalId = process.env.STRIPE_PORTAL_CONFIGURATION_ID?.trim();
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET?.trim();
  if (!secretKey || !priceId || !portalId || !webhookSecret) {
    throw new Error("Stripe billing is not fully configured");
  }
  return new StripeBillingGateway(secretKey, priceId, portalId, webhookSecret);
}

app.get("/v1/schemas/companion-manifest.v2.schema.json", (c) => c.json(companionManifestV2JsonSchema));

app.get("/v1/public/skills/:token", async (c) => {
  try {
    const preview = await getSkillPublicPreviewByShareToken({ token: c.req.param("token") });
    if (!preview) return jsonError(c, "skill not found", 404);
    // Promotion, withdrawal, and archive must take effect immediately; never let an edge keep an
    // install button alive for a release whose exact package route has already been revoked.
    c.header("Cache-Control", "no-store");
    return c.json(preview);
  } catch (error) {
    return jsonError(c, error);
  }
});

app.post(
  "/v1/billing/webhooks/stripe",
  bodyLimit({ maxSize: 2 * 1024 * 1024, onError: (c) => jsonError(c, "Stripe webhook exceeds the 2 MB limit", 413) }),
  async (c) => {
    try {
      if (!billingRuntimeConfig().webhooksEnabled) return jsonError(c, "Stripe webhooks are disabled", 404);
      const signature = c.req.header("stripe-signature");
      if (!signature) return jsonError(c, "missing Stripe signature", 400);
      const gateway = stripeBillingGateway();
      const event = gateway.constructWebhookEvent(await c.req.text(), signature);
      const object = event.data.object as unknown as Record<string, unknown>;
      const objectType = typeof object.object === "string" ? object.object : null;
      const subscriptionId =
        objectType === "subscription" && typeof object.id === "string"
          ? object.id
          : typeof object.subscription === "string"
            ? object.subscription
            : null;
      const customerId = typeof object.customer === "string" ? object.customer : null;
      const outcome = await processStripeWebhook({
        eventId: event.id,
        eventType: event.type,
        subscriptionId,
        customerId,
        gateway,
      });
      if (outcome === "ignored") {
        console.info("ignored Stripe event with no matching organization", {
          eventId: event.id,
          eventType: event.type,
        });
      }
      return c.json({ received: true, outcome });
    } catch (error) {
      return jsonError(c, error, 400);
    }
  },
);

/** Set the `companion_org` selection cookie (readable client-side, so not httpOnly). */
function setOrgCookie(c: Context<{ Variables: ApiVariables }>, orgId: string): void {
  setCookie(c, "companion_org", orgId, {
    path: "/",
    sameSite: "Lax",
    secure: process.env.NODE_ENV === "production",
    httpOnly: false,
  });
}

function secretRouteError(c: Context, error: unknown, status = 400): Response {
  return jsonError(c, error, error instanceof SecretConfigurationError ? 503 : status);
}

function assertSecretsConfigured(): void {
  const key = loadSecretsMasterKey();
  key.fill(0);
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
  overrides: { dependencies?: string[] | Record<string, string> } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), "companion-skill-"));
  try {
    await unpackAnyTo(archive, dir);
    const prepared = await prepareSkillDirForPublish(dir, companion);
    const companionManifest = overrides.dependencies
      ? withResolvedManifestDependencies(prepared.companionManifest, overrides.dependencies)
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
  _companion: { skillId: string; version: string },
): string {
  const frontmatter = skillFrontmatterSchema.parse({
    name: id,
    description,
    metadata: {},
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

/** Collect a repeatable form/query field into a de-duped, comma-splittable string list. */
function parseMultiValues(values: Array<string | undefined>): string[] {
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
  // `scope` is a supported input again (the personal/org library axis). The team/visibility/owner
  // inputs below were the removed ownership model and stay rejected.
  if (
    hasField("visibility") ||
    hasField("everyone") ||
    hasField("team") ||
    hasField("teams") ||
    hasField("owner_team") ||
    hasField("private")
  ) {
    throw new Error(
      "legacy skill visibility/owner/team inputs are not supported; organize skills with labels and use `scope` (personal/org) to choose a library",
    );
  }
}

/**
 * Shared publish tail: store the canonical archive (idempotently) and write a new
 * skill_versions row, authorizing first and cleaning up the blob on failure.
 */
class TransferTicketAuthorizationChangedError extends Error {}

async function publishCanonical(input: {
  actor: ReturnType<typeof actorFromContext>;
  orgId: string;
  canonical: Awaited<ReturnType<typeof packDir>>;
  fm: SkillFrontmatter;
  companionManifest: CompanionManifest;
  skillId: string;
  /** Library to publish into on first create: 'personal' (My Skills) or 'org' (default). */
  scope?: SkillScope;
  /** Label paths to file the skill under on create (personal folders for 'personal', else org). */
  labels?: string[];
  version: string;
  note: string;
  /** SKILL.md markdown body — persisted server-side to power full-text content search. */
  body: string;
  dependencies?: Awaited<ReturnType<typeof prepareSkillPublishDependencies>>;
  /** Runs after external storage work and immediately before the tenant mutation. */
  beforeCommit?: () => Promise<boolean>;
}): Promise<{ id: string; slug: string; version: string; checksum: string; sizeBytes: number }> {
  const { actor, orgId, canonical, fm, companionManifest, skillId, scope, labels, version, note, body, dependencies } =
    input;
  if (!isValidSemver(version)) throw new Error(`invalid semver: ${version}`);
  const key = skillArchiveKey({ orgId, slug: fm.name, version });
  const payload = publishSkillInputSchema.parse({
    skill_id: skillId,
    slug: fm.name,
    ...(scope ? { scope } : {}),
    labels: labels ?? [],
    version,
    description: skillSummary(fm, companionManifest),
    checksum: canonical.checksum,
    storage_path: key,
    size_bytes: canonical.sizeBytes,
    frontmatter: JSON.stringify(toStoredSkillVersionManifest(fm, companionManifest), null, 2),
    body,
    tools: fm.allowedTools,
    license: fm.license ?? null,
    note,
    dependencies: dependencies?.slugs ?? [],
  });
  await withTenantContext({ orgId, userId: actor.id }, (database) =>
    assertCanPublishSkillVersion({ actor, orgId, payload, database }),
  );
  await putSkillArchive({ key, body: canonical.archive, preventOverwrite: true });
  try {
    if (input.beforeCommit && !await input.beforeCommit()) {
      throw new TransferTicketAuthorizationChangedError(
        "transfer ticket authorization changed before publication",
      );
    }
    const published = await withTenantContext({ orgId, userId: actor.id }, (database) =>
      publishSkillVersion({ actor, orgId, payload, archiveKey: key, dependencies, database }),
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
    allowHeaders: ["Content-Type", "Authorization", "Idempotency-Key", "Last-Event-ID", "x-companion-org", "x-companion-workspace-id", "x-companion-transfer-ticket"],
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    credentials: true,
  }),
);

app.use("*", attachSession);

registerAgentAuthRoutes(app);

app.get("/health", (c) => c.json({ ok: true }));

app.on(["GET", "POST"], "/auth/*", (c) => auth.handler(c.req.raw));

app.get("/v1/skills/share-target/:token", async (c) => {
  try {
    const actor = actorFromContext(c);
    const target = await getSkillShareTargetByShareToken({ actor, token: c.req.param("token") });
    if (!target) return jsonError(c, "skill not found", 404);
    return c.json(target);
  } catch (error) {
    return jsonError(c, error, 401);
  }
});

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

app.get("/v1/billing", async (c) => {
  try {
    const overview = await withTenant(c, ({ actor, orgId, database }) =>
      getBillingOverview({ actorId: actor.id, orgId, database }),
    );
    return c.json(overview);
  } catch (error) {
    return jsonError(c, error, 401);
  }
});

app.get("/v1/billing/preview", async (c) => {
  try {
    const source = await withTenant(c, ({ actor, orgId, database }) =>
      getBillingPreviewSource({
        actorId: actor.id,
        orgId,
        database,
      }),
    );
    const preview = source
      ? await getBillingPreview({ source, gateway: stripeBillingGateway() })
      : { paymentMethod: null, latestInvoice: null };
    c.header("Cache-Control", "private, no-store");
    return c.json(preview);
  } catch (error) {
    return jsonError(c, error, error instanceof BillingPreviewProviderError ? 502 : 403);
  }
});

app.post("/v1/billing/checkout", async (c) => {
  try {
    const result = await withTenant(c, ({ actor, orgId, database }) =>
      createBillingCheckout({
        actorId: actor.id,
        orgId,
        database,
        gateway: stripeBillingGateway(),
        appUrl: process.env.COMPANION_WEB_URL ?? "http://127.0.0.1:3000",
      }),
    );
    return c.json(result);
  } catch (error) {
    return jsonError(c, error, 403);
  }
});

app.post("/v1/billing/portal", async (c) => {
  try {
    const result = await withTenant(c, ({ actor, orgId, database }) =>
      createBillingPortal({
        actorId: actor.id,
        orgId,
        database,
        gateway: stripeBillingGateway(),
        appUrl: process.env.COMPANION_WEB_URL ?? "http://127.0.0.1:3000",
      }),
    );
    return c.json(result);
  } catch (error) {
    return jsonError(c, error, 403);
  }
});

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
  let actor: ReturnType<typeof actorFromContext>;
  try {
    actor = actorFromContext(c);
  } catch (error) {
    return jsonError(c, error, 401);
  }

  try {
    const orgs = await listOrgs(actor);
    const orgId = await orgIdFromContext(c).catch(() => null);
    const org = orgs.find((o) => o.org_id === orgId) ?? orgs[0] ?? null;
    const { onboarded } = await getOnboardingState(actor);
    // Resolve the actor's own avatar (custom upload or Gravatar) — the single source both web
    // loaders use to build `MeVM`, so the current user's avatar shows on every authed surface.
    const avatarUrl = await getMyAvatarUrl({ actor });
    return c.json({
      userId: actor.id,
      email: actor.email,
      name: actor.name,
      avatarUrl,
      org,
      role: org?.org_role ?? null,
      onboarded,
      needsOnboarding: !onboarded,
    });
  } catch (error) {
    // Authentication was established above. Dependency/database failures must remain retryable
    // server errors rather than masquerading as an authoritative signed-out response.
    return jsonError(c, error, 500);
  }
});

type GitHubOAuthState = { orgId: string; userId: string; nonce: string; expiresAt: number };

function githubRedirectUri(): string {
  const base = process.env.COMPANION_WEB_URL ?? "http://127.0.0.1:3000";
  return new URL("/v1/integrations/github/callback", base).toString();
}

function signGitHubState(payload: GitHubOAuthState, secret: string): string {
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = createHmac("sha256", secret).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
}

function verifyGitHubState(value: string, secret: string): GitHubOAuthState {
  const [encoded, signature] = value.split(".");
  if (!encoded || !signature) throw new Error("invalid GitHub authorization state");
  const expected = createHmac("sha256", secret).update(encoded).digest();
  const actual = Buffer.from(signature, "base64url");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new Error("invalid GitHub authorization state");
  const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as GitHubOAuthState;
  if (!payload.orgId || !payload.userId || !payload.nonce || payload.expiresAt < Date.now()) {
    throw new Error("GitHub authorization state expired");
  }
  return payload;
}

function githubClient(): GitHubOAuthClient {
  const config = githubOAuthConfig();
  if (!config || !githubSyncEnabled()) throw new Error("GitHub App integration is not configured");
  return new GitHubOAuthClient(config);
}

async function activeGitHubUserToken(input: {
  actor: ReturnType<typeof actorFromContext>; orgId: string; client: GitHubOAuthClient;
}): Promise<string> {
  const credential = await withTenantContext({ orgId: input.orgId, userId: input.actor.id }, (database) =>
    getGitHubUserCredential({ actor: input.actor, orgId: input.orgId, database }),
  );
  if (!credential.accessExpiresAt || credential.accessExpiresAt.getTime() > Date.now() + 5 * 60_000) return credential.accessToken;
  if (!credential.refreshToken || (credential.refreshExpiresAt && credential.refreshExpiresAt.getTime() <= Date.now())) {
    throw new Error("GitHub authorization expired; reconnect Companion");
  }
  const refreshed = await input.client.refreshUserToken(credential.refreshToken);
  const persisted = await withTenantContext({ orgId: input.orgId, userId: input.actor.id }, (database) =>
    refreshGitHubConnectionCredential({
      actor: input.actor,
      orgId: input.orgId,
      expectedCredentialGeneration: credential.credentialGeneration,
      expectedCredentialVersion: credential.credentialVersion,
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken,
      accessExpiresAt: refreshed.accessExpiresAt,
      refreshExpiresAt: refreshed.refreshExpiresAt,
      database,
    }),
  );
  if (!persisted) {
    await input.client.revokeUserToken(refreshed.accessToken);
    throw new Error("GitHub authorization changed while refreshing; retry the request");
  }
  return refreshed.accessToken;
}

app.get("/v1/integrations/github", async (c) => {
  try {
    const config = githubOAuthConfig();
    const configured = Boolean(config) && githubSyncEnabled();
    const result = await withTenant(c, ({ actor, orgId, database }) => getGitHubIntegration({
      actor, orgId, configured, appSlug: config?.slug ?? null,
      appName: config?.name ?? "GitHub App", managed: config?.managed ?? false, database,
    }));
    return c.json(result);
  } catch (error) {
    return jsonError(c, error, 403);
  }
});

app.get("/v1/integrations/github/skills", async (c) => {
  try {
    const result = await withTenant(c, ({ actor, orgId, database }) =>
      getGitHubSkillSyncOverview({ actor, orgId, database }),
    );
    return c.json(result);
  } catch (error) {
    return jsonError(c, error, 403);
  }
});

app.post("/v1/integrations/github/connect", async (c) => {
  try {
    const client = githubClient();
    const actor = actorFromContext(c);
    const orgId = await orgIdFromContext(c);
    await withTenantContext({ orgId, userId: actor.id }, (database) => getGitHubIntegration({
      actor, orgId, configured: true, appSlug: client.config.slug, appName: client.config.name,
      managed: client.config.managed, database,
    }));
    const nonce = randomUUID();
    const state = signGitHubState({ orgId, userId: actor.id, nonce, expiresAt: Date.now() + 10 * 60_000 }, client.config.clientSecret);
    setCookie(c, "companion_github_oauth", nonce, {
      path: "/v1/integrations/github/callback", httpOnly: true, sameSite: "Lax",
      secure: process.env.NODE_ENV === "production", maxAge: 600,
    });
    return c.json({
      url: client.authorizationUrl({ state, redirectUri: githubRedirectUri() }),
      install_url: client.installationUrl(state),
    });
  } catch (error) {
    return jsonError(c, error, 403);
  }
});

app.get("/v1/integrations/github/callback", async (c) => {
  const web = process.env.COMPANION_WEB_URL ?? "http://127.0.0.1:3000";
  try {
    const client = githubClient();
    const actor = actorFromContext(c);
    const state = verifyGitHubState(c.req.query("state") ?? "", client.config.clientSecret);
    if (actor.id !== state.userId || getCookie(c, "companion_github_oauth") !== state.nonce) {
      throw new Error("GitHub authorization session does not match");
    }
    const code = c.req.query("code");
    if (!code) throw new Error("GitHub did not return an authorization code");
    const tokens = await client.exchangeCode(code, githubRedirectUri());
    const user = await client.user(tokens.accessToken);
    await withTenantContext({ orgId: state.orgId, userId: actor.id }, (database) => saveGitHubConnection({
      actor, orgId: state.orgId, githubUserId: String(user.id), githubLogin: user.login,
      githubAvatarUrl: user.avatar_url, accessToken: tokens.accessToken, refreshToken: tokens.refreshToken,
      accessExpiresAt: tokens.accessExpiresAt, refreshExpiresAt: tokens.refreshExpiresAt, database,
    }));
    setCookie(c, "companion_org", state.orgId, { path: "/", sameSite: "Lax", secure: process.env.NODE_ENV === "production" });
    setCookie(c, "companion_github_oauth", "", { path: "/v1/integrations/github/callback", maxAge: 0, httpOnly: true });
    return c.redirect(new URL("/settings?view=github&github=connected", web).toString(), 303);
  } catch (error) {
    const message = error instanceof Error ? error.message : "GitHub authorization failed";
    setCookie(c, "companion_github_oauth", "", {
      path: "/v1/integrations/github/callback",
      maxAge: 0,
      httpOnly: true,
      sameSite: "Lax",
      secure: process.env.NODE_ENV === "production",
    });
    const target = new URL("/settings", web);
    target.searchParams.set("view", "github");
    target.searchParams.set("github_error", message.slice(0, 200));
    return c.redirect(target.toString(), 303);
  }
});

app.delete("/v1/integrations/github/account", async (c) => {
  try {
    const client = githubClient();
    await withTenant(c, ({ actor, orgId, database }) => deleteGitHubConnection({
      actor,
      orgId,
      revokeAccessToken: (accessToken) => client.revokeUserToken(accessToken),
      database,
    }));
    return c.json({ ok: true });
  } catch (error) {
    return jsonError(c, error, 403);
  }
});

app.get("/v1/integrations/github/repositories", async (c) => {
  try {
    const client = githubClient();
    const actor = actorFromContext(c);
    const orgId = await orgIdFromContext(c);
    const accessToken = await activeGitHubUserToken({ actor, orgId, client });
    const [repositories, installations] = await Promise.all([
      client.repositories(accessToken),
      client.installations(accessToken),
    ]);
    const result = { repositories, installations, install_url: client.installationUrl() };
    return c.json(result);
  } catch (error) {
    return jsonError(c, error, 403);
  }
});

app.post("/v1/integrations/github/repositories", async (c) => {
  try {
    const body = createGitHubRepositoryInputSchema.parse(await c.req.json());
    const client = githubClient();
    const actor = actorFromContext(c);
    const orgId = await orgIdFromContext(c);
    const accessToken = await activeGitHubUserToken({ actor, orgId, client });
    const user = await client.user(accessToken);
    const installation = (await client.installations(accessToken)).find((candidate) =>
      candidate.installation_id === body.installation_id && candidate.owner === body.owner,
    );
    if (!installation) throw new Error("GitHub App installation is not accessible");
    const repository = await client.createRepository({
      accessToken, installationId: installation.installation_id, owner: installation.owner,
      userLogin: user.login, name: body.name, private: body.private,
    });
    return c.json({ repository }, 201);
  } catch (error) {
    return jsonError(c, error, 400);
  }
});

app.post("/v1/integrations/github/destinations", async (c) => {
  try {
    const raw = await c.req.json() as Record<string, unknown>;
    const client = githubClient();
    const actor = actorFromContext(c);
    const orgId = await orgIdFromContext(c);
    const accessToken = await activeGitHubUserToken({ actor, orgId, client });
    const candidates = await client.repositories(accessToken);
    const candidate = candidates.find((repo) => repo.repository_id === raw.repository_id && repo.installation_id === raw.installation_id);
    if (!candidate) throw new Error("repository is not accessible to the Companion GitHub App");
    const destination = createGitHubDestinationInputSchema.parse({
      ...raw, owner: candidate.owner, name: candidate.name, html_url: candidate.html_url,
      default_branch: candidate.default_branch || "main", private: candidate.private,
      repository_empty: candidate.empty,
    });
    const id = await withTenantContext({ orgId, userId: actor.id }, (database) =>
      createGitHubDestination({ actor, orgId, destination, database }),
    );
    return c.json({ ok: true, id }, 201);
  } catch (error) {
    return jsonError(c, error, 400);
  }
});

app.patch("/v1/integrations/github/destinations/:id", async (c) => {
  try {
    const patch = updateGitHubDestinationInputSchema.parse(await c.req.json());
    await withTenant(c, ({ actor, orgId, database }) => updateGitHubDestination({
      actor, orgId, destinationId: c.req.param("id"), patch, database,
    }));
    return c.json({ ok: true });
  } catch (error) {
    return jsonError(c, error, 400);
  }
});

function githubSkillSelectionError(c: Context, error: unknown): Response {
  if (error instanceof GitHubSkillSyncConflictError) return jsonError(c, error, 409);
  if (error instanceof GitHubSkillSyncNotFoundError) return jsonError(c, error, 404);
  return jsonError(c, error, 403);
}

app.put("/v1/integrations/github/destinations/:id/skills/:skillId", async (c) => {
  try {
    const changed = await withTenant(c, ({ actor, orgId, database }) => setGitHubDestinationSkillSelection({
      actor,
      orgId,
      destinationId: c.req.param("id"),
      skillId: c.req.param("skillId"),
      selected: true,
      database,
    }));
    return c.json({ ok: true as const, changed });
  } catch (error) {
    return githubSkillSelectionError(c, error);
  }
});

app.delete("/v1/integrations/github/destinations/:id/skills/:skillId", async (c) => {
  try {
    const changed = await withTenant(c, ({ actor, orgId, database }) => setGitHubDestinationSkillSelection({
      actor,
      orgId,
      destinationId: c.req.param("id"),
      skillId: c.req.param("skillId"),
      selected: false,
      database,
    }));
    return c.json({ ok: true as const, changed });
  } catch (error) {
    return githubSkillSelectionError(c, error);
  }
});

app.post("/v1/integrations/github/destinations/:id/sync", async (c) => {
  try {
    const input = requestGitHubDestinationSyncInputSchema.parse(await c.req.json().catch(() => ({})));
    await withTenant(c, ({ actor, orgId, database }) => requestGitHubDestinationSync({
      actor, orgId, destinationId: c.req.param("id"), resumeDisconnected: input.resume_disconnected, database,
    }));
    return c.json({ ok: true });
  } catch (error) {
    return jsonError(c, error, 403);
  }
});

app.delete("/v1/integrations/github/destinations/:id", async (c) => {
  try {
    await withTenant(c, ({ actor, orgId, database }) => deleteGitHubDestination({
      actor, orgId, destinationId: c.req.param("id"), database,
    }));
    return c.json({ ok: true });
  } catch (error) {
    return jsonError(c, error, 403);
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
    // Best-effort invite emails: a bounced address must NOT undo the org the user just created
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
          skillNamingPolicy: input.skillNamingPolicy,
          database,
        }),
      ),
    );
  } catch (error) {
    return jsonError(c, error);
  }
});

/**
 * Token-readable read of the org's own skill-naming policy (the free-text prompt each org defines for
 * itself). This is what the triage skill calls to apply the active org's rule. Companion imposes no
 * convention; an org with no policy returns { policy: null }.
 */
app.get("/v1/orgs/current/skill-naming-policy", async (c) => {
  try {
    actorFromContext(c, true);
    requireScope(c, "skills:read");
    const policy = await withTenant(
      c,
      ({ actor, orgId, database }) => getSkillNamingPolicy({ actor, orgId, database }),
      true,
    );
    return c.json(skillNamingPolicyResponseSchema.parse({ policy }));
  } catch (error) {
    return jsonError(c, error, 401);
  }
});

app.post("/v1/orgs/current/domains", async (c) => {
  try {
    if (isTokenRequest(c)) throw new Error("personal access tokens cannot manage workspace domains");
    const input = addOrgAccessDomainInputSchema.parse(await c.req.json());
    return c.json(await withTenant(c, ({ actor, orgId, database }) => addOrgAccessDomain({ actor, orgId, domain: input.domain, acknowledgeSeatBilling: input.acknowledgeSeatBilling, database })));
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
    await withTenantContext({ orgId, userId: actor.id }, (database) =>
      getOrgLogoAsset({ actor, orgId, database }),
    );
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

/** Upload (or replace) the current user's profile avatar. Self-service; session only. */
app.post(
  "/v1/users/me/avatar",
  // The body limit guards the whole multipart request (file bytes + form framing), so it carries a
  // little headroom over the 2 MB file cap; the real file-size limit is enforced on the bytes below
  // so a genuine 2 MB image is never rejected by framing overhead alone.
  bodyLimit({
    maxSize: MAX_USER_AVATAR_BYTES + 256 * 1024,
    onError: (c) => jsonError(c, "avatar exceeds the 2 MB upload limit", 413),
  }),
  async (c) => {
    try {
      if (isTokenRequest(c)) throw new Error("personal access tokens cannot update the profile");
      const actor = actorFromContext(c);
      const file = (await c.req.formData()).get("file");
      if (!(file instanceof File)) throw new Error("file is required");
      if (!resolveUserAvatarContentType(file)) throw new Error("avatar must be a PNG, JPEG, WebP, or GIF image");
      const body = Buffer.from(await file.arrayBuffer());
      if (!body.length) throw new Error("file is empty");
      if (body.length > MAX_USER_AVATAR_BYTES) throw new Error("avatar exceeds the 2 MB upload limit");
      // Verify the real bytes match an allowed image (reject a non-image with a faked extension/header).
      const contentType = sniffCommentImageMime(body);
      if (!contentType) throw new Error("avatar must be a PNG, JPEG, WebP, or GIF image");
      await putUserAvatar({ userId: actor.id, body, contentType });
      return c.json(await setUserAvatarFromUpload({ actor }));
    } catch (error) {
      return jsonError(c, error);
    }
  },
);

/** Remove the current user's custom avatar, reverting to Gravatar / colored initials. */
app.delete("/v1/users/me/avatar", async (c) => {
  try {
    if (isTokenRequest(c)) throw new Error("personal access tokens cannot update the profile");
    const actor = actorFromContext(c);
    // Clear the profile marker first so the avatar stops resolving and serving immediately; then
    // remove the storage object best-effort. If the object delete fails, the cleared marker already
    // makes it unfetchable (the serve gate requires the marker), so the photo is gone from view and
    // the two stores cannot diverge into a still-servable orphan.
    const result = await clearUserAvatar({ actor });
    await deleteUserAvatar({ userId: actor.id }).catch((err) => {
      console.error("failed to delete avatar object", err);
    });
    return c.json(result);
  } catch (error) {
    return jsonError(c, error);
  }
});

/** Serve a hosted user-avatar binary to any authenticated member. */
app.get("/v1/users/:userId/avatar", async (c) => {
  try {
    const actor = actorFromContext(c, true);
    const userId = c.req.param("userId");
    await getUserAvatarAsset({ actor, userId });
    const asset = await getUserAvatar({ userId });
    if (!asset) return c.json({ error: "avatar not found" }, 404);
    return new Response(asset.body, {
      headers: {
        "Content-Type": asset.contentType,
        "Cache-Control": "private, no-cache",
        "X-Content-Type-Options": "nosniff",
      },
    });
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
    const body = await c.req.json<{ email: string; role?: "admin" | "developer"; acknowledgeSeatBilling?: boolean }>();
    const role = body.role ?? "developer";
    if (role !== "admin" && role !== "developer") throw new Error("invalid invitation role");
    const invite = await withTenantContext({ orgId, userId: actor.id }, (database) =>
      createInvitation({ actor, orgId, email: body.email, role, acknowledgeSeatBilling: body.acknowledgeSeatBilling, database }),
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
      await withTenantContext({ orgId: createdOrgId, userId: createdActor.id }, (database) =>
        revokeInvitation({ actor: createdActor!, orgId: createdOrgId!, inviteId: createdInvite!.id, database }),
      ).catch((cleanupError) => {
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
    actorFromContext(c, true);
    requireScope(c, "skills:read");
    // `?lib=mine` returns the caller's "My Skills" (authored personal skills + org skills they have
    // installed); `?lib=org` (default) is the flat org-wide library. `?label=marketing/seo` filters to
    // skills filed under that path OR any descendant (personal folders for `mine`, org folders for
    // `org`); `?nolabel=true` filters to skills with no folder; `?installed=true` narrows to skills
    // the caller has reported installed.
    const parsed = parseSkillListQuery((name) => c.req.query(name));
    // A label may only reach the LIKE-prefix filter if it is a well-formed path. A malformed/typo
    // `?label=` (e.g. `%`) can't match any validated stored path, so it returns an EMPTY folder —
    // never a SQL wildcard leaking into the LIKE, and never a silent broadening to the whole org list.
    // `?q=` turns this into a relevance-ranked full-text search (slug, description, tools, and the
    // SKILL.md body). Folded into the list endpoint so no path can shadow a valid `search` slug.
    return c.json(
      await withTenant(c, ({ actor, orgId, database }) =>
        parsed.labelValid
          ? listSkills({
              actor,
              orgId,
              library: parsed.library,
              label: parsed.label,
              nolabel: parsed.nolabel,
              installedOnly: parsed.installedOnly,
              archived: parsed.archived,
              query: parsed.query,
              limit: parsed.limit,
              database,
            })
          : Promise.resolve([] as Awaited<ReturnType<typeof listSkills>>),
        true,
      ),
    );
  } catch (error) {
    return jsonError(c, error, 401);
  }
});

/**
 * Org-wide shared labels ("folders"). The path always lives in the request body/query (never a URL
 * segment) so a slash-separated path like `marketing/seo` survives. Any member may read or mutate
 * labels (`withTenant` membership-gated); the service enforces `assertMember`.
 */
app.get("/v1/labels", async (c) => {
  try {
    actorFromContext(c, true);
    requireScope(c, "skills:read");
    return c.json(await withTenant(c, ({ actor, orgId, database }) => listLabels({ actor, orgId, database }), true));
  } catch (error) {
    return jsonError(c, error, 401);
  }
});

app.post("/v1/labels", async (c) => {
  try {
    actorFromContext(c, true);
    requireScope(c, "skills:write");
    const input = createLabelInputSchema.parse(await c.req.json());
    await withTenant(
      c,
      ({ actor, orgId, database }) =>
        createLabel({
          actor,
          orgId,
          path: input.path,
          displayName: input.displayName,
          color: input.color,
          icon: input.icon,
          database,
        }),
      true,
    );
    return c.json({ ok: true as const });
  } catch (error) {
    return jsonError(c, error);
  }
});

app.put("/v1/labels/rename", async (c) => {
  try {
    actorFromContext(c, true);
    requireScope(c, "skills:write");
    const input = renameLabelInputSchema.parse(await c.req.json());
    await withTenant(
      c,
      ({ actor, orgId, database }) =>
        renameLabel({
          actor,
          orgId,
          from: input.from,
          to: input.to,
          displayName: input.displayName,
          database,
        }),
      true,
    );
    return c.json({ ok: true as const });
  } catch (error) {
    return jsonError(c, error);
  }
});

app.put("/v1/labels/color", async (c) => {
  try {
    actorFromContext(c, true);
    requireScope(c, "skills:write");
    const input = setLabelColorInputSchema.parse(await c.req.json());
    await withTenant(
      c,
      ({ actor, orgId, database }) => setLabelColor({ actor, orgId, path: input.path, color: input.color, database }),
      true,
    );
    return c.json({ ok: true as const });
  } catch (error) {
    return jsonError(c, error);
  }
});

app.put("/v1/labels/icon", async (c) => {
  try {
    actorFromContext(c, true);
    requireScope(c, "skills:write");
    const input = setLabelIconInputSchema.parse(await c.req.json());
    await withTenant(
      c,
      ({ actor, orgId, database }) => setLabelIcon({ actor, orgId, path: input.path, icon: input.icon, database }),
      true,
    );
    return c.json({ ok: true as const });
  } catch (error) {
    return jsonError(c, error);
  }
});

app.delete("/v1/labels", async (c) => {
  try {
    actorFromContext(c, true);
    requireScope(c, "skills:write");
    const input = deleteLabelInputSchema.parse(await c.req.json());
    await withTenant(
      c,
      ({ actor, orgId, database }) => deleteLabel({ actor, orgId, path: input.path, database }),
      true,
    );
    return c.json({ ok: true as const });
  } catch (error) {
    return jsonError(c, error);
  }
});

/**
 * Personal folders ("My Skills"). Same request shapes as org labels but scoped to the caller — a
 * member never sees another member's personal folders. The service enforces the `owner_id` scope on
 * every query.
 */
app.get("/v1/personal-labels", async (c) => {
  try {
    actorFromContext(c, true);
    requireScope(c, "skills:read");
    return c.json(
      await withTenant(c, ({ actor, orgId, database }) => listPersonalLabels({ actor, orgId, database }), true),
    );
  } catch (error) {
    return jsonError(c, error, 401);
  }
});

app.post("/v1/personal-labels", async (c) => {
  try {
    actorFromContext(c, true);
    requireScope(c, "skills:write");
    const input = createLabelInputSchema.parse(await c.req.json());
    await withTenant(
      c,
      ({ actor, orgId, database }) =>
        createPersonalLabel({
          actor,
          orgId,
          path: input.path,
          displayName: input.displayName,
          color: input.color,
          icon: input.icon,
          database,
        }),
      true,
    );
    return c.json({ ok: true as const });
  } catch (error) {
    return jsonError(c, error);
  }
});

app.put("/v1/personal-labels/rename", async (c) => {
  try {
    actorFromContext(c, true);
    requireScope(c, "skills:write");
    const input = renameLabelInputSchema.parse(await c.req.json());
    await withTenant(
      c,
      ({ actor, orgId, database }) =>
        renamePersonalLabel({ actor, orgId, from: input.from, to: input.to, displayName: input.displayName, database }),
      true,
    );
    return c.json({ ok: true as const });
  } catch (error) {
    return jsonError(c, error);
  }
});

app.put("/v1/personal-labels/color", async (c) => {
  try {
    actorFromContext(c, true);
    requireScope(c, "skills:write");
    const input = setLabelColorInputSchema.parse(await c.req.json());
    await withTenant(
      c,
      ({ actor, orgId, database }) =>
        setPersonalLabelColor({ actor, orgId, path: input.path, color: input.color, database }),
      true,
    );
    return c.json({ ok: true as const });
  } catch (error) {
    return jsonError(c, error);
  }
});

app.put("/v1/personal-labels/icon", async (c) => {
  try {
    actorFromContext(c, true);
    requireScope(c, "skills:write");
    const input = setLabelIconInputSchema.parse(await c.req.json());
    await withTenant(
      c,
      ({ actor, orgId, database }) =>
        setPersonalLabelIcon({ actor, orgId, path: input.path, icon: input.icon, database }),
      true,
    );
    return c.json({ ok: true as const });
  } catch (error) {
    return jsonError(c, error);
  }
});

app.delete("/v1/personal-labels", async (c) => {
  try {
    actorFromContext(c, true);
    requireScope(c, "skills:write");
    const input = deleteLabelInputSchema.parse(await c.req.json());
    await withTenant(
      c,
      ({ actor, orgId, database }) => deletePersonalLabel({ actor, orgId, path: input.path, database }),
      true,
    );
    return c.json({ ok: true as const });
  } catch (error) {
    return jsonError(c, error);
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
  let body: ReturnType<typeof skillFilterPreferencesInputSchema.parse>;
  try {
    body = skillFilterPreferencesInputSchema.parse(await c.req.json());
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

/** Share a personal skill into the org library (owner-only; flips scope personal → org). */
app.get("/v1/skills/:slug/share-plan", async (c) => {
  try {
    actorFromContext(c, true);
    requireScope(c, "skills:read");
    const result = await withTenant(
      c,
      ({ actor, orgId, database }) => buildSkillSharePlan({ actor, orgId, slug: c.req.param("slug"), database }),
      true,
    );
    return c.json(result);
  } catch (error) {
    return jsonError(c, error);
  }
});

app.post("/v1/skills/:slug/share", async (c) => {
  try {
    actorFromContext(c, true);
    requireScope(c, "skills:write");
    const result = await withTenant(
      c,
      ({ actor, orgId, database }) => shareSkill({ actor, orgId, slug: c.req.param("slug"), database }),
      true,
    );
    return c.json({
      ok: true as const,
      slug: c.req.param("slug"),
      scope: result.scope,
      shared_dependencies: result.shared_dependencies,
    });
  } catch (error) {
    return jsonError(c, error);
  }
});

/** Explicitly rename a skill slug/title in place without publishing a new version. */
app.post("/v1/skills/:slug/rename", async (c) => {
  try {
    actorFromContext(c, true);
    requireScope(c, "skills:write");
    const body = renameSkillInputSchema.parse(await c.req.json());
    const result = await withTenant(
      c,
      ({ actor, orgId, database }) =>
        renameSkill({
          actor,
          orgId,
          slug: c.req.param("slug"),
          newSlug: body.newSlug,
          title: body.title,
          database,
        }),
      true,
    );
    return c.json(result);
  } catch (error) {
    return jsonError(c, error, error instanceof SkillPublicReleaseConflictError ? 409 : 400);
  }
});

app.get("/v1/skills/:slug", async (c) => {
  try {
    actorFromContext(c, true);
    requireScope(c, "skills:read");
    // Resolve archived skills too — they stay viewable, so the canonical detail endpoint must
    // return them (getSkillBySlug includes archived).
    const row = await withTenant(
      c,
      ({ actor, orgId, database }) =>
        getSkillBySlug({ actor, orgId, slug: c.req.param("slug"), database }),
      true,
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

app.post(
  "/v1/skills/:slug/comments",
  // Authenticate before the body-reading bodyLimit middleware, so an unauthenticated caller can't make
  // the server read or measure a large upload body.
  async (c, next) => {
    try {
      actorFromContext(c);
    } catch (error) {
      return jsonError(c, error, 401);
    }
    await next();
  },
  // 6 images x 10 MB + form overhead. Text-only comments come through the JSON branch well under this.
  bodyLimit({ maxSize: 64 * 1024 * 1024, onError: (c) => jsonError(c, "comment exceeds the 64 MB upload limit", 413) }),
  async (c) => {
    try {
      const slug = c.req.param("slug");
      const contentType = c.req.header("content-type") ?? "";

      // Multipart: a comment with image attachments.
      if (contentType.includes("multipart/form-data")) {
        // Authenticate + resolve the tenant BEFORE buffering/parsing the (up to 64 MB) body, so an
        // unauthenticated caller can't force the server to parse a large upload.
        const actor = actorFromContext(c);
        const orgId = await orgIdFromContext(c);

        const form = await c.req.formData();
        const rawBody = form.get("body");
        const body = typeof rawBody === "string" ? rawBody : "";
        const rawParent = form.get("parent_id");
        const parentId = typeof rawParent === "string" && rawParent.length ? rawParent : null;
        const rawVersion = form.get("version_id");
        const versionId = typeof rawVersion === "string" && rawVersion.length ? rawVersion : null;
        // File entries only (the other branch of FormDataEntryValue is `string`).
        const files = form.getAll("image").filter((f): f is Exclude<typeof f, string> => typeof f !== "string");

        if (files.length > MAX_COMMENT_IMAGES) {
          throw new Error(`a comment can have at most ${MAX_COMMENT_IMAGES} images`);
        }
        if (!body.trim() && files.length === 0) throw new Error("comment body is required");
        for (const file of files) {
          if (!resolveCommentImageContentType(file)) throw new Error("images must be PNG, JPEG, WebP, or GIF");
          if (file.size === 0) throw new Error("an image file is empty");
          if (file.size > MAX_COMMENT_IMAGE_BYTES) throw new Error("each image must be 10 MB or smaller");
        }

        // Validate the comment target (skill visibility + parent / version) BEFORE writing any object
        // bytes, so an inaccessible or invalid target never triggers S3 uploads. addComment re-checks
        // this in its write transaction; the duplicate read is cheap and keeps the service self-guarding.
        await withTenantContext({ orgId, userId: actor.id }, (database) =>
          assertCommentTarget({ actor, orgId, slug, parentId, versionId, database }),
        );

        // Upload the bytes to object storage OUTSIDE any DB transaction (slow uploads must not hold a
        // pooled connection idle-in-transaction); the transaction below only persists metadata.
        const uploadedKeys: string[] = [];
        const images: Array<{ id: string; storageKey: string; contentType: string; byteSize: number }> = [];
        try {
          for (const file of files) {
            const buf = Buffer.from(await file.arrayBuffer());
            // The stored content type comes from the actual file bytes, not the client-declared
            // MIME/extension, so disguised non-images are rejected and never stored or served back.
            const ct = sniffCommentImageMime(buf);
            if (!ct) throw new Error("images must be valid PNG, JPEG, WebP, or GIF files");
            const imageId = randomUUID();
            const key = commentImageKey({ orgId, imageId });
            await putSkillArchive({ key, body: buf, contentType: ct });
            uploadedKeys.push(key);
            images.push({ id: imageId, storageKey: key, contentType: ct, byteSize: buf.length });
          }
          return c.json(
            await withTenantContext({ orgId, userId: actor.id }, (database) =>
              addComment({ actor, orgId, slug, body, parentId, versionId, images, database }),
            ),
          );
        } catch (e) {
          // The comment insert rolled back (or upload failed); drop any objects we stored so they don't orphan.
          await Promise.allSettled(uploadedKeys.map((key) => deleteSkillArchive({ key })));
          throw e;
        }
      }

      // JSON: a text-only comment (unchanged contract).
      const input = addCommentInputSchema.parse(await c.req.json());
      return c.json(
        await withTenant(c, ({ actor, orgId, database }) =>
          addComment({
            actor,
            orgId,
            slug,
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
  },
);

/** Serve a comment image attachment to viewers who can see the skill. */
app.get("/v1/skills/:slug/comments/:commentId/images/:imageId", async (c) => {
  try {
    const asset = await withTenant(c, ({ actor, orgId, database }) =>
      getCommentImageAsset({
        actor,
        orgId,
        slug: c.req.param("slug"),
        commentId: c.req.param("commentId"),
        imageId: c.req.param("imageId"),
        database,
      }),
    );
    const body = await getSkillArchive({ key: asset.storageKey });
    return new Response(body, {
      headers: {
        "Content-Type": asset.contentType,
        // Private + revalidate (matches the workspace-logo endpoint): the visibility check re-runs on
        // every request, so a cached copy can't outlive the viewer's access after logout / revocation.
        "Cache-Control": "private, no-cache",
        // User-uploaded bytes: never let the browser sniff them into an executable type.
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    // Not-visible skill / unknown image / cross-tenant all surface as a 404 for the <img> request.
    return jsonError(c, error, 404);
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

/**
 * Record a published skill as installed for the caller. The assistant posts here at the end of the
 * normal install flow (`source: "agent"`); a member can also hand-mark via the UI (`source: "manual"`,
 * e.g. installed another way). This is per-member personal state that only affects the
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

/** File a skill under a label path (org-wide shared folder). Path in the body so slashes survive. */
app.post("/v1/skills/:slug/labels", async (c) => {
  try {
    actorFromContext(c, true);
    requireScope(c, "skills:write");
    const { path } = assignLabelInputSchema.parse(await c.req.json());
    await withTenant(
      c,
      ({ actor, orgId, database }) => assignLabel({ actor, orgId, slug: c.req.param("slug"), path, database }),
      true,
    );
    return c.json({ ok: true as const });
  } catch (error) {
    return jsonError(c, error);
  }
});

/** Remove a label path from a skill. Path in the body so slashes survive. */
app.delete("/v1/skills/:slug/labels", async (c) => {
  try {
    actorFromContext(c, true);
    requireScope(c, "skills:write");
    const { path } = assignLabelInputSchema.parse(await c.req.json());
    await withTenant(
      c,
      ({ actor, orgId, database }) => unassignLabel({ actor, orgId, slug: c.req.param("slug"), path, database }),
      true,
    );
    return c.json({ ok: true as const });
  } catch (error) {
    return jsonError(c, error);
  }
});

/** File one of the caller's authored personal skills into a personal folder (path in the body). */
app.post("/v1/skills/:slug/personal-labels", async (c) => {
  try {
    actorFromContext(c, true);
    requireScope(c, "skills:write");
    const { path } = assignLabelInputSchema.parse(await c.req.json());
    await withTenant(
      c,
      ({ actor, orgId, database }) =>
        assignPersonalLabel({ actor, orgId, slug: c.req.param("slug"), path, database }),
      true,
    );
    return c.json({ ok: true as const });
  } catch (error) {
    return jsonError(c, error);
  }
});

/** Remove a personal folder from one of the caller's skills (the folder itself stays). */
app.delete("/v1/skills/:slug/personal-labels", async (c) => {
  try {
    actorFromContext(c, true);
    requireScope(c, "skills:write");
    const { path } = assignLabelInputSchema.parse(await c.req.json());
    await withTenant(
      c,
      ({ actor, orgId, database }) =>
        unassignPersonalLabel({ actor, orgId, slug: c.req.param("slug"), path, database }),
      true,
    );
    return c.json({ ok: true as const });
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

function publicReleaseRouteError(c: Context, error: unknown): Response {
  if (error instanceof SkillPublicReleaseNotFoundError) return jsonError(c, error, 404);
  if (error instanceof SkillPublicReleaseForbiddenError) return jsonError(c, error, 403);
  if (error instanceof SkillPublicReleaseConflictError) return jsonError(c, error, 409);
  if (error instanceof SkillPublicReleaseValidationError) return jsonError(c, error, 400);
  return jsonError(c, error);
}

/** Pin/promote the current version. Session, legacy PAT, or delegated skills:write capability. */
app.put("/v1/skills/:slug/public-version", async (c) => {
  try {
    actorFromContext(c, true);
    requireScope(c, "skills:write");
    const body = setSkillPublicVersionInputSchema.parse(await c.req.json());
    const packageVersion = await withTenant(
      c,
      async ({ actor, orgId, database }) => ({
        orgId,
        ...await getDownloadVersion({
          actor,
          orgId,
          slug: c.req.param("slug"),
          version: body.version,
          forPublicRelease: true,
          database,
        }),
      }),
      true,
    );
    if (!packageVersion.isCurrent) {
      throw new SkillPublicReleaseValidationError("only the current skill version can be made public");
    }
    const storedArchive = await getSkillArchive({ key: packageVersion.storagePath });
    let publicZip: Buffer;
    try {
      publicZip = await tarGzToZip(storedArchive);
    } catch {
      throw new SkillPublicReleaseValidationError(
        "the stored skill package is not safe for public installation; publish a corrected version first",
      );
    }
    const packageChecksum = `sha256:${createHash("sha256").update(publicZip).digest("hex")}`;
    await putPublicSkillReleaseSnapshot({
      orgId: packageVersion.orgId,
      checksum: packageChecksum,
      body: publicZip,
    });
    return c.json(
      await withTenant(
        c,
        ({ actor, orgId, database }) =>
          setSkillPublicVersion({
            actor,
            orgId,
            slug: c.req.param("slug"),
            version: body.version,
            packageChecksum,
            packageSizeBytes: publicZip.length,
            expectedCurrentVersionId: packageVersion.versionId,
            database,
          }),
        true,
      ),
    );
  } catch (error) {
    return publicReleaseRouteError(c, error);
  }
});

/** Idempotently withdraw package access. The share token and immutable version stay intact. */
app.delete("/v1/skills/:slug/public-version", async (c) => {
  try {
    actorFromContext(c, true);
    requireScope(c, "skills:write");
    return c.json(
      await withTenant(
        c,
        ({ actor, orgId, database }) =>
          clearSkillPublicVersion({ actor, orgId, slug: c.req.param("slug"), database }),
        true,
      ),
    );
  } catch (error) {
    return publicReleaseRouteError(c, error);
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
 *  - multipart/form-data (browser dropzone / CLI): `file` + `action`/`label`/`version`/`message`.
 *  - raw `application/zip` or `application/gzip` (guided assistant + Bearer token): the body IS the
 *    archive; `label`/`version`/`message` come from query params (repeatable `label`).
 * `action=validate` runs the same package and targeted identity checks without publishing.
 * Accepts `.zip` or `.tar.gz`. Requires the `skills:write` scope for token-authed requests.
 * Bodies above 32 MB are rejected with 413 before buffering (just over the 25 MB archive cap).
 */
app.post("/v1/skills", bodyLimit({ maxSize: 32 * 1024 * 1024, onError: (c) => jsonError(c, "package exceeds the 32 MB upload limit", 413) }), async (c) => {
  try {
    const contentType = c.req.header("content-type") ?? "";
    const transferTicket = c.req.header("x-companion-transfer-ticket")?.trim() || null;
    let actor: ReturnType<typeof actorFromContext>;
    let orgId: string;
    let ticketArchive: Buffer | null = null;
    let transferBinding: NonNullable<Awaited<ReturnType<typeof consumeSkillPackageTransferTicket>>> | null = null;

    if (transferTicket) {
      if (contentType.includes("multipart/form-data")) {
        return jsonError(c, "Agent Auth transfer tickets require a raw archive body", 400);
      }
      const action = c.req.query("action") ?? "publish";
      const slug = c.req.query("expect_slug")?.trim();
      const version = c.req.query("version")?.trim();
      if (!["publish", "validate"].includes(action) || !slug || !version) {
        return jsonError(c, "Agent Auth uploads require action=publish|validate, expect_slug, and version", 400);
      }
      if (!await preflightSkillPackageTransferTicket({
        ticket: transferTicket,
        action: "skill_package.upload",
        slug,
        version,
      })) {
        return jsonError(c, "transfer ticket is invalid, expired, revoked, already used, or does not match this upload", 401);
      }
      ticketArchive = Buffer.from(await c.req.arrayBuffer());
      if (!ticketArchive.length) throw new Error("request body is empty");
      const checksum = `sha256:${createHash("sha256").update(ticketArchive).digest("hex")}`;
      transferBinding = await consumeSkillPackageTransferTicket({
        ticket: transferTicket,
        action: "skill_package.upload",
        slug,
        version,
        checksum,
        sizeBytes: ticketArchive.length,
      });
      if (!transferBinding) {
        return jsonError(c, "transfer ticket is invalid, expired, revoked, already used, or does not match this upload", 401);
      }
      actor = transferBinding.actor;
      orgId = transferBinding.orgId;
    } else {
      actor = actorFromContext(c, true);
      requireScope(c, "skills:write");
      orgId = await orgIdFromContext(c);
    }

    let archive: Buffer;
    let action: string;
    let versionRaw: string | undefined;
    let messageRaw: string | undefined;
    let expectSlug: string | undefined;
    let expectSkillId: string | undefined;
    let labelValues: string[] = [];
    let dependencyValues: string[] = [];
    let scopeRaw: string | undefined;

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
      versionRaw = field("version");
      messageRaw = field("message");
      expectSlug = field("expect_slug");
      expectSkillId = field("expect_skill_id");
      scopeRaw = field("scope");
      labelValues = parseMultiValues([...form.getAll("label"), ...form.getAll("labels")].map((v) => String(v)));
      dependencyValues = parseMultiValues([...form.getAll("dependency"), ...form.getAll("dependencies")].map((v) => String(v)));
    } else {
      const url = new URL(c.req.url);
      rejectLegacySkillVisibilityInput((name) => url.searchParams.has(name));
      archive = ticketArchive ?? Buffer.from(await c.req.arrayBuffer());
      if (!archive.length) throw new Error("request body is empty");
      action = c.req.query("action") ?? "publish";
      versionRaw = c.req.query("version");
      messageRaw = c.req.query("message");
      expectSlug = c.req.query("expect_slug");
      expectSkillId = c.req.query("expect_skill_id");
      scopeRaw = c.req.query("scope");
      labelValues = parseMultiValues([...url.searchParams.getAll("label"), ...url.searchParams.getAll("labels")]);
      dependencyValues = parseMultiValues([...url.searchParams.getAll("dependency"), ...url.searchParams.getAll("dependencies")]);
    }
    // Library to publish into on first create ('personal' from My Skills, else 'org'). Re-publish of an
    // existing skill keeps its scope regardless. Validated to the enum; an unknown value is ignored.
    const scope: SkillScope | undefined = scopeRaw === "personal" || scopeRaw === "org" ? scopeRaw : undefined;

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
    if (transferBinding && fm.name !== transferBinding.slug) {
      return c.json({ result, error: "package name does not match the Agent Auth upload ticket" }, 422);
    }
    // Identity guard, enforced on every publish/validate so a buggy or malicious agent can never
    // retarget a skill. `slugSkill` is the skill that currently owns this slug (null on a fresh create
    // — it doubles as the "is this an update?" probe); `companionIdSkill` is the skill the package's
    // declared Companion id resolves to (org-scoped). The declared id (== skills.id) is authoritative.
    const declaredCompanionId =
      result.companion_manifest?.metadata.companionSkillId ?? fm.metadata.companion_skill_id ?? undefined;
    const { slugSkill, companionIdSkill } = await withTenantContext(
      { orgId, userId: actor.id },
      async (database) => ({
        slugSkill: await getSkillBySlug({ actor, orgId, slug: fm.name, database }),
        companionIdSkill: declaredCompanionId
          ? await getSkillById({ actor, orgId, id: declaredCompanionId, database })
          : null,
      }),
    );
    if (
      transferBinding
      && (
        (transferBinding.expectedSkillId !== null && slugSkill?.id !== transferBinding.expectedSkillId)
        || (transferBinding.expectedSkillId === null && !!slugSkill)
      )
    ) {
      return c.json({ result, error: "skill target changed after the Agent Auth upload ticket was issued" }, 409);
    }
    if (transferBinding?.expectedSkillId && expectSkillId !== transferBinding.expectedSkillId) {
      return c.json({ result, error: "expect_skill_id does not match the Agent Auth upload ticket" }, 422);
    }
    try {
      assertNoCompanionRetarget({
        frontmatter: fm,
        companionSkillId: declaredCompanionId,
        lookup: { slugSkill, companionIdSkill },
      });
      // The actual mutation must declare its intent: updating an existing slug requires expect_*.
      // Validate stays flexible so an agent can probe an unknown package without knowing the id yet.
      if (parsedAction === "publish") {
        assertUpdateIsTargeted({ frontmatter: fm, slugSkill, expectSlug, expectSkillId });
      }
      // When the caller does send expect_*, also bind the upload to that exact slug + id.
      if (expectSlug || expectSkillId) {
        const expectedSkill = expectSlug && expectSlug !== fm.name
          ? await withTenantContext({ orgId, userId: actor.id }, (database) =>
              getSkillBySlug({ actor, orgId, slug: expectSlug, database }),
            )
          : slugSkill;
        assertTargetedSkillUpdate({
          frontmatter: fm,
          companionSkillId: declaredCompanionId,
          expectSlug,
          expectSkillId,
          expectedSkill,
        });
      }
    } catch (error) {
      return c.json({ result, error: error instanceof Error ? error.message : String(error) }, 422);
    }
    // companion.json is the preferred dependency source. Legacy dependency= query params remain a
    // fallback for old clients that upload packages without a Companion manifest.
    dependencyValues = uploadDependencyValues({
      queryDependencies: dependencyValues,
      companionManifestPath: result.companion_manifest_path,
      companionManifest: result.companion_manifest,
    });
    let preparedDependencies;
    try {
      preparedDependencies = await withTenantContext({ orgId, userId: actor.id }, (database) =>
        prepareSkillPublishDependencies({
          actor,
          orgId,
          slugs: dependencyValues,
          manifest: result.companion_manifest,
          database,
        }),
      );
    } catch (error) {
      return c.json({ result, error: error instanceof Error ? error.message : String(error) }, 422);
    }
    dependencyValues = preparedDependencies.slugs;
    // Dependency preflight: which declared deps are published / must be uploaded / dropped, plus any
    // blockers (missing / cycle). Skills are flat — there is no owner-cover constraint. Computed for
    // both validate (preview) and publish.
    const dependencyPlan = await withTenantContext(
      { orgId, userId: actor.id },
      (database) =>
        buildDependencyPlan({
          actor,
          orgId,
          slug: fm.name,
          declaredSlugs: dependencyValues,
          database,
        }),
    );
    if (parsedAction === "validate") return c.json({ result, dependency_plan: dependencyPlan });
    const target = await resolvePublishTarget({
      actor,
      orgId,
      slug: fm.name,
      explicitVersion: versionRaw,
      metadataVersion: result.companion_manifest?.version ?? fm.metadata.companion_version,
      metadataSkillId: result.companion_manifest?.metadata.companionSkillId ?? fm.metadata.companion_skill_id,
      legacyVersion: result.legacy?.version,
    });
    if (
      transferBinding
      && (
        target.version !== transferBinding.version
        || (transferBinding.expectedSkillId !== null && target.skillId !== transferBinding.expectedSkillId)
      )
    ) {
      return c.json({ result, error: "publish target does not match the Agent Auth upload ticket" }, 422);
    }
    const normalized = await canonicalizeSkillArchive(archive, {
      skillId: target.skillId,
      version: target.version,
    }, { dependencies: preparedDependencies.manifestDependencies });
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
        // First create picks the library; re-publish keeps the existing scope (the publish guard
        // rejects a scope that contradicts an existing skill of that slug).
        scope,
        labels: labelValues,
        version: target.version,
        note: messageRaw ?? "",
        body: normalizedResult.body ?? "",
        dependencies: preparedDependencies,
        beforeCommit: transferBinding && transferTicket
          ? () => revalidateAgentTransferTicket({ ticket: transferTicket })
          : undefined,
      });
    } catch (error) {
      if (error instanceof TransferTicketAuthorizationChangedError) {
        return jsonError(c, error, 401);
      }
      // Unresolved dependencies (missing / cycle) — surface the plan, don't 500.
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
    const { carriedDependencies, carriedRequirements, carriedDisplay, carriedNotes, carriedIcon, exists } = await withTenant(
      c,
      async ({ actor: a, orgId: o, database }) => {
        const existing = await getSkillBySlug({ actor: a, orgId: o, slug: input.id, database });
        if (!existing?.current_version)
          return { carriedDependencies: [], carriedRequirements: [], carriedDisplay: null, carriedNotes: null, carriedIcon: null, exists: !!existing };
        const deps = await getSkillDependencies({ actor: a, orgId: o, slug: input.id, database });
        return {
          carriedDependencies: deps.requires.map((r) => r.slug),
          carriedRequirements: existing.requirements,
          carriedDisplay: existing.display,
          carriedNotes: existing.notes,
          carriedIcon: existing.icon,
          exists: true,
        };
      },
      true,
    );
    const preparedCarriedDependencies = await withTenantContext(
      { orgId, userId: actor.id },
      (database) => prepareSkillPublishDependencies({ actor, orgId, slugs: carriedDependencies, database }),
    );
    const companionManifest = buildInlineCompanionManifest({
      description: input.description,
      carriedDisplay,
      carriedNotes,
      carriedIcon,
      carriedRequirements,
      carriedDependencies: preparedCarriedDependencies.manifestDependencies,
      name: input.id,
      version: target.version,
      companionSkillId: target.skillId,
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
        // Only a brand-new skill chooses its library; editing an existing one keeps its scope.
        scope: exists ? undefined : input.scope,
        labels: input.labels,
        version: target.version,
        note: "",
        body: result.body ?? "",
        dependencies: preparedCarriedDependencies,
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
    // Agent JWTs may read version metadata, but package bytes always flow
    // through a one-use transfer ticket. Do not hand an agent a signed object
    // URL that would bypass that binding. Existing session/PAT behavior stays
    // compatible.
    if (isAgentRequest(c)) return c.json(found);
    const url = await signedSkillArchiveUrl({ key: found.storagePath });
    return c.json({ ...found, url });
  } catch (error) {
    return jsonError(c, error);
  }
});

/**
 * Download the exact pinned public release. Anonymous requests and PATs are deliberately rejected:
 * callers need either a verified Better Auth browser session or a one-use Agent Auth transfer
 * ticket supplied in a header (never in the URL).
 */
app.get("/v1/public/skills/:token/versions/:version/package", async (c) => {
  try {
    const token = c.req.param("token");
    const version = c.req.param("version");
    const user = c.get("user");
    const transferTicket = c.req.header("x-companion-transfer-ticket")?.trim() || null;
    let consumedAgentTicket: string | null = null;
    let found;
    if (user) {
      if (!user.emailVerified) return jsonError(c, "a verified account is required", 401);
      found = await authorizePublicSkillPackageForSession({ token, version, userId: user.id });
      if (!found) return jsonError(c, "public skill release not found", 404);
    } else if (transferTicket) {
      found = await consumePublicSkillTransferTicket({ ticket: transferTicket, token, version });
      if (!found) return jsonError(c, "transfer ticket is invalid, expired, revoked, or already used", 401);
      consumedAgentTicket = transferTicket;
    } else {
      return jsonError(c, "sign in or use an approved Agent Auth transfer ticket", 401);
    }

    const zip = await getSkillArchive({
      key: publicSkillReleaseKey({ orgId: found.orgId, checksum: found.checksum }),
    });
    const zipChecksum = `sha256:${createHash("sha256").update(zip).digest("hex")}`;
    if (zip.length !== found.sizeBytes || zipChecksum !== found.checksum) {
      return jsonError(c, "public package bytes no longer match the pinned release metadata", 409);
    }
    if (consumedAgentTicket && !await revalidateAgentTransferTicket({ ticket: consumedAgentTicket })) {
      return jsonError(c, "transfer authorization was revoked before package delivery", 401);
    }
    return new Response(new Uint8Array(zip), {
      headers: {
        "content-type": "application/zip",
        "content-disposition": `attachment; filename="${found.slug}.zip"`,
        "content-length": String(zip.length),
        "cache-control": "private, no-store",
        // This checksum and size cover the exact ZIP bytes in this response.
        "x-companion-package-checksum": found.checksum,
        "x-companion-package-size": String(found.sizeBytes),
        "x-companion-public-version": found.version,
      },
    });
  } catch (error) {
    return jsonError(c, error);
  }
});

async function loadSkillVersionArchive(
  c: Context<{ Variables: ApiVariables }>,
  slug: string,
  version: string,
) {
  const found = await withTenant(
    c,
    ({ actor, orgId, database }) =>
      getDownloadVersion({ actor, orgId, slug, version, database }),
    true,
  );
  const tarGz = await getSkillArchive({ key: found.storagePath });
  return { found, tarGz };
}

/**
 * Download a specific version as a `.zip` for assistant or direct-download installs.
 * Visibility-gated; requires `skills:read` for token-authed callers.
 */
app.get("/v1/skills/:slug/versions/:version/package", async (c) => {
  try {
    const slug = c.req.param("slug");
    const version = c.req.param("version");
    const transferTicket = c.req.header("x-companion-transfer-ticket")?.trim() || null;
    let tarGz: Buffer;
    let transferBinding: NonNullable<Awaited<ReturnType<typeof consumeSkillPackageTransferTicket>>> | null = null;
    if (transferTicket) {
      transferBinding = await consumeSkillPackageTransferTicket({
        ticket: transferTicket,
        action: "skill_package.download",
        slug,
        version,
      });
      if (!transferBinding) {
        return jsonError(c, "transfer ticket is invalid, expired, revoked, already used, or does not match this package", 401);
      }
      const loaded = await withTenantContext(
        { orgId: transferBinding.orgId, userId: transferBinding.actor.id },
        async (database) => {
          const found = await getDownloadVersion({
            actor: transferBinding!.actor,
            orgId: transferBinding!.orgId,
            slug,
            version,
            database,
          });
          const skill = await getSkillBySlug({
            actor: transferBinding!.actor,
            orgId: transferBinding!.orgId,
            slug,
            database,
          });
          const versions = await listSkillVersions({
            actor: transferBinding!.actor,
            orgId: transferBinding!.orgId,
            slug,
            database,
          });
          const exactVersion = versions.find((candidate) => candidate.version === version);
          if (
            !skill
            || skill.id !== transferBinding!.expectedSkillId
            || exactVersion?.id !== transferBinding!.expectedSkillVersionId
          ) {
            throw new Error("skill package changed after the transfer ticket was issued");
          }
          return found;
        },
      );
      tarGz = await getSkillArchive({ key: loaded.storagePath });
    } else {
      actorFromContext(c, true);
      requireScope(c, "skills:read");
      ({ tarGz } = await loadSkillVersionArchive(c, slug, version));
    }
    const zip = await tarGzToZip(tarGz);
    const checksum = `sha256:${createHash("sha256").update(zip).digest("hex")}`;
    if (transferBinding && (checksum !== transferBinding.checksum || zip.length !== transferBinding.sizeBytes)) {
      return jsonError(c, "package bytes no longer match the Agent Auth transfer ticket", 409);
    }
    if (transferBinding && transferTicket && !await revalidateAgentTransferTicket({ ticket: transferTicket })) {
      return jsonError(c, "transfer authorization was revoked before package delivery", 401);
    }
    return new Response(new Uint8Array(zip), {
      headers: {
        "content-type": "application/zip",
        "content-disposition": `attachment; filename="${slug}.zip"`,
        "content-length": String(zip.length),
        "cache-control": "private, no-store",
        "x-companion-package-checksum": checksum,
        "x-companion-package-size": String(zip.length),
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
    const { found, tarGz } = await loadSkillVersionArchive(c, slug, c.req.param("version"));
    const tar = toTar(tarGz);
    const { files } = await extractArchiveFiles(tar);
    return c.json({ version: found.version, files });
  } catch (error) {
    return jsonError(c, error);
  }
});

/**
 * Serve one browser-native previewable file from a specific package version. Visibility-gated like
 * `/files` and `/package`; unsupported package entries stay download-only.
 */
app.get("/v1/skills/:slug/versions/:version/files/content", async (c) => {
  try {
    const path = c.req.query("path");
    if (!path) return jsonError(c, new Error("path is required"), 400);
    const slug = c.req.param("slug");
    const version = c.req.param("version");
    const transferTicket = c.req.header("x-companion-transfer-ticket")?.trim() || null;
    let tarGz: Buffer;
    let transferBinding: NonNullable<Awaited<ReturnType<typeof consumeSkillPackageTransferTicket>>> | null = null;
    if (transferTicket) {
      transferBinding = await consumeSkillPackageTransferTicket({
        ticket: transferTicket,
        action: "skill_file.download",
        slug,
        version,
        filePath: path,
      });
      if (!transferBinding) {
        return jsonError(c, "transfer ticket is invalid, expired, revoked, already used, or does not match this file", 401);
      }
      const loaded = await withTenantContext(
        { orgId: transferBinding.orgId, userId: transferBinding.actor.id },
        async (database) => {
          const found = await getDownloadVersion({
            actor: transferBinding!.actor,
            orgId: transferBinding!.orgId,
            slug,
            version,
            database,
          });
          const skill = await getSkillBySlug({
            actor: transferBinding!.actor,
            orgId: transferBinding!.orgId,
            slug,
            database,
          });
          const versions = await listSkillVersions({
            actor: transferBinding!.actor,
            orgId: transferBinding!.orgId,
            slug,
            database,
          });
          const exactVersion = versions.find((candidate) => candidate.version === version);
          if (
            !skill
            || skill.id !== transferBinding!.expectedSkillId
            || exactVersion?.id !== transferBinding!.expectedSkillVersionId
          ) {
            throw new Error("skill file changed after the transfer ticket was issued");
          }
          return found;
        },
      );
      tarGz = await getSkillArchive({ key: loaded.storagePath });
    } else {
      actorFromContext(c, true);
      requireScope(c, "skills:read");
      ({ tarGz } = await loadSkillVersionArchive(c, slug, version));
    }
    const tar = toTar(tarGz);
    const file = await extractArchiveFileContent(tar, path);
    if (file.status !== "ok") {
      const status =
        file.status === "invalid_path" ? 400 :
          file.status === "not_found" ? 404 :
            file.status === "unsupported" ? 415 :
              413;
      return jsonError(c, new Error(file.message), status);
    }
    if (transferBinding) {
      const checksum = `sha256:${createHash("sha256").update(file.bytes).digest("hex")}`;
      if (
        transferBinding.filePath !== file.path
        || transferBinding.checksum !== checksum
        || transferBinding.sizeBytes !== file.bytes.length
      ) {
        return jsonError(c, "file bytes no longer match the Agent Auth transfer ticket", 409);
      }
    }

    const leaf = file.path.split("/").pop() || "file";
    const filename = leaf.replace(/["\r\n]/g, "_");
    const transferHeaders: Record<string, string> = transferBinding
      ? {
          "x-companion-file-checksum": transferBinding.checksum,
          "x-companion-file-size": String(transferBinding.sizeBytes),
        }
      : {};
    if (transferBinding && transferTicket && !await revalidateAgentTransferTicket({ ticket: transferTicket })) {
      return jsonError(c, "transfer authorization was revoked before file delivery", 401);
    }
    return new Response(new Uint8Array(file.bytes), {
      headers: {
        "content-type": file.content_type,
        "content-disposition": `inline; filename="${filename}"`,
        "content-length": String(file.bytes.length),
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
        "content-security-policy": "sandbox; default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'",
        ...transferHeaders,
      },
    });
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
    const row = await withTenant(
      c,
      async ({ actor, orgId, database }) => {
        const install = await getLocalSkillInstall({ actor, orgId, skillKey: COMPANION_SKILL_KEY, database });
        return buildCompanionSkillRow(install, orgId);
      },
      true,
    );
    return c.json([row]);
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
    const row = await withTenant(
      c,
      async ({ actor, orgId, database }) => {
        const install = await getLocalSkillInstall({ actor, orgId, skillKey: key, database });
        return buildCompanionSkillRow(install, orgId);
      },
      true,
    );
    return c.json(row);
  } catch (error) {
    return jsonError(c, error, 401);
  }
});

/** Download the bundled local skill as a `.zip` for the assistant to unpack. Auth like skill packages. */
app.get("/v1/local-skills/:key/package", async (c) => {
  try {
    const key = c.req.param("key");
    if (key !== COMPANION_SKILL_KEY) return c.json({ error: `unknown local skill: ${key}` }, 404);
    const transferTicket = c.req.header("x-companion-transfer-ticket")?.trim() || null;
    if (!transferTicket) {
      actorFromContext(c, true);
      requireScope(c, "skills:read");
    }
    const pkg = await getCompanionSkillPackage();
    const transportChecksum = `sha256:${createHash("sha256").update(pkg.zip).digest("hex")}`;
    let consumedAgentTicket: string | null = null;
    if (transferTicket) {
      const binding = await consumeSkillPackageTransferTicket({
        ticket: transferTicket,
        action: "local_skill.download",
        slug: key,
        version: pkg.version,
        checksum: transportChecksum,
        sizeBytes: pkg.zip.length,
      });
      if (!binding) {
        return jsonError(c, "transfer ticket is invalid, expired, revoked, already used, or does not match this local skill", 401);
      }
      consumedAgentTicket = transferTicket;
    }
    if (consumedAgentTicket && !await revalidateAgentTransferTicket({ ticket: consumedAgentTicket })) {
      return jsonError(c, "transfer authorization was revoked before package delivery", 401);
    }
    return new Response(new Uint8Array(pkg.zip), {
      headers: {
        "content-type": "application/zip",
        "content-disposition": `attachment; filename="${key}.zip"`,
        "content-length": String(pkg.zip.length),
        "cache-control": "private, no-store",
        "x-companion-package-checksum": transportChecksum,
        "x-companion-package-size": String(pkg.zip.length),
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
 * audit row), so delegated agents request `skills:write` progressively. Explicit legacy PAT callers
 * still need the same scope; no install prompt silently creates one.
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

// Secrets metadata/retrieval use `secrets:read`; every Secrets mutation uses `secrets:write`.
// PAT callers have the same Secrets capabilities as their signed-in user inside the token's workspace.
app.get("/v1/secrets", async (c) => {
  try {
    assertSecretsConfigured();
    actorFromContext(c, true);
    requireScope(c, "secrets:read");
    return c.json(await withTenant(c, ({ actor, orgId, database }) => listSecrets({ actor, orgId, database }), true));
  } catch (error) {
    return secretRouteError(c, error, 401);
  }
});

app.post(
  "/v1/secrets",
  // A secret value is capped at 64 KiB. Keep modest room for JSON framing, metadata and recipient
  // ids, but reject oversized requests before buffering/parsing them in the handler.
  bodyLimit({ maxSize: 128 * 1024, onError: (c) => secretRouteError(c, "secret request exceeds the 128 KiB limit", 413) }),
  async (c) => {
    try {
      assertSecretsConfigured();
      actorFromContext(c, true);
      requireScope(c, "secrets:write");
      const value = createSecretInputSchema.parse(await c.req.json());
      return c.json(await withTenant(c, ({ actor, orgId, database }) => createSecret({ actor, orgId, value, database }), true), 201);
    } catch (error) {
      return secretRouteError(c, error);
    }
  },
);

app.get("/v1/secrets/:id", async (c) => {
  try {
    assertSecretsConfigured();
    actorFromContext(c, true);
    requireScope(c, "secrets:read");
    return c.json(await withTenant(c, ({ actor, orgId, database }) => getSecret({ actor, orgId, secretId: c.req.param("id"), database }), true));
  } catch (error) {
    return secretRouteError(c, error, 404);
  }
});

app.patch("/v1/secrets/:id", async (c) => {
  try {
    assertSecretsConfigured();
    actorFromContext(c, true);
    requireScope(c, "secrets:write");
    const value = updateSecretInputSchema.parse(await c.req.json());
    return c.json(await withTenant(c, ({ actor, orgId, database }) => updateSecret({ actor, orgId, secretId: c.req.param("id"), value, database }), true));
  } catch (error) {
    return secretRouteError(c, error);
  }
});

app.delete("/v1/secrets/:id", async (c) => {
  try {
    assertSecretsConfigured();
    actorFromContext(c, true);
    requireScope(c, "secrets:write");
    await withTenant(c, ({ actor, orgId, database }) => deleteSecret({ actor, orgId, secretId: c.req.param("id"), database }), true);
    return c.json({ ok: true as const });
  } catch (error) {
    return secretRouteError(c, error);
  }
});

app.post("/v1/secrets/:id/rotate", async (c) => {
  try {
    assertSecretsConfigured();
    actorFromContext(c, true);
    requireScope(c, "secrets:write");
    const value = rotateSecretInputSchema.parse(await c.req.json());
    return c.json(await withTenant(c, ({ actor, orgId, database }) => rotateSecret({ actor, orgId, secretId: c.req.param("id"), value: value.value, database }), true));
  } catch (error) {
    return secretRouteError(c, error);
  }
});

app.get("/v1/skills/:slug/secret-configuration", async (c) => {
  try {
    assertSecretsConfigured();
    actorFromContext(c, true);
    requireScope(c, "secrets:read");
    return c.json(await withTenant(c, ({ actor, orgId, database }) => getSkillSecretConfiguration({ actor, orgId, slug: c.req.param("slug"), version: c.req.query("version"), database }), true));
  } catch (error) {
    return secretRouteError(c, error, 404);
  }
});

app.put("/v1/skills/:slug/secret-bindings/:slotId", async (c) => {
  try {
    assertSecretsConfigured();
    actorFromContext(c, true);
    requireScope(c, "secrets:write");
    const value = setSecretBindingInputSchema.parse(await c.req.json());
    return c.json(await withTenant(c, ({ actor, orgId, database }) => setSkillSecretBinding({ actor, orgId, slug: c.req.param("slug"), slotId: c.req.param("slotId"), secretId: value.secret_id, database }), true));
  } catch (error) {
    return secretRouteError(c, error);
  }
});

app.delete("/v1/skills/:slug/secret-bindings/:slotId", async (c) => {
  try {
    assertSecretsConfigured();
    actorFromContext(c, true);
    requireScope(c, "secrets:write");
    return c.json(await withTenant(c, ({ actor, orgId, database }) => removeSkillSecretBinding({ actor, orgId, slug: c.req.param("slug"), slotId: c.req.param("slotId"), database }), true));
  } catch (error) {
    return secretRouteError(c, error);
  }
});

app.put("/v1/skills/:slug/secret-suggestions/:slotId", async (c) => {
  try {
    assertSecretsConfigured();
    actorFromContext(c, true);
    requireScope(c, "secrets:write");
    const value = setSecretSuggestionInputSchema.parse(await c.req.json());
    return c.json(await withTenant(c, ({ actor, orgId, database }) => setSkillSecretSuggestion({ actor, orgId, slug: c.req.param("slug"), slotId: c.req.param("slotId"), secretId: value.secret_id, database }), true));
  } catch (error) {
    return secretRouteError(c, error);
  }
});

app.delete("/v1/skills/:slug/secret-suggestions/:slotId", async (c) => {
  try {
    assertSecretsConfigured();
    actorFromContext(c, true);
    requireScope(c, "secrets:write");
    return c.json(await withTenant(c, ({ actor, orgId, database }) => removeSkillSecretSuggestion({ actor, orgId, slug: c.req.param("slug"), slotId: c.req.param("slotId"), database }), true));
  } catch (error) {
    return secretRouteError(c, error);
  }
});

app.post("/v1/skills/:slug/secret-suggestions/:slotId/accept", async (c) => {
  try {
    assertSecretsConfigured();
    actorFromContext(c, true);
    requireScope(c, "secrets:write");
    return c.json(await withTenant(c, ({ actor, orgId, database }) => acceptSkillSecretSuggestion({ actor, orgId, slug: c.req.param("slug"), slotId: c.req.param("slotId"), database }), true));
  } catch (error) {
    return secretRouteError(c, error);
  }
});

app.post("/v1/secret-retrievals/preflight", async (c) => {
  try {
    assertSecretsConfigured();
    actorFromContext(c, true);
    requireScope(c, "secrets:read");
    const value = secretRetrievalPreflightInputSchema.parse(await c.req.json());
    return c.json(await withTenant(c, ({ actor, orgId, database }) => preflightSecretRetrieval({ actor, orgId, value, database }), true));
  } catch (error) {
    return secretRouteError(c, error);
  }
});

app.post("/v1/secret-retrievals/:planId/grant", async (c) => {
  try {
    assertSecretsConfigured();
    actorFromContext(c, true);
    requireScope(c, "secrets:read");
    return c.json(await withTenant(c, ({ actor, orgId, database }) => createSecretRetrievalGrant({ actor, orgId, planId: c.req.param("planId"), database }), true));
  } catch (error) {
    return secretRouteError(c, error);
  }
});

app.post("/v1/secret-grants/redeem", async (c) => {
  try {
    assertSecretsConfigured();
    actorFromContext(c, true);
    requireScope(c, "secrets:read");
    const value = redeemSecretGrantInputSchema.parse(await c.req.json());
    const result = await withTenant(c, ({ actor, orgId, database }) => redeemSecretRetrievalGrant({ actor, orgId, grant: value.grant, database }), true);
    return result.ok ? c.json(result.value) : secretRouteError(c, result.error, 409);
  } catch (error) {
    return secretRouteError(c, error);
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
 * Return active-token metadata or replace an expired PAT during its 30-day recovery window.
 * This route reads the bearer directly because an expired PAT intentionally cannot authenticate any
 * other API surface. Ineligible credentials are indistinguishable to callers.
 */
app.post("/v1/tokens/refresh", async (c) => {
  try {
    const bearer = bearerFromHeader(c.req.header("authorization"));
    if (!bearer) throw new ApiTokenRefreshError();
    return c.json(refreshTokenResponseSchema.parse(await refreshApiToken(bearer)));
  } catch (error) {
    if (error instanceof ApiTokenRefreshError) {
      return c.json({ ok: false, error: "token cannot be refreshed" }, 401);
    }
    return jsonError(c, error, 500);
  }
});

/**
 * Issue a scoped personal access token for the guided-prompt / install flows.
 * Cookie session only — ordinary PATs cannot mint arbitrary tokens. The dedicated refresh route
 * above can only preserve an eligible token's existing name and scopes. Plaintext is returned once.
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

/* ---- Model catalog + provider connections (session-only; PATs rejected) ------------------- */

const modelCatalog = createModelCatalog();

app.get("/v1/models", async (c) => {
  try {
    if (isTokenRequest(c)) return jsonError(c, "personal access tokens cannot use provider connections", 401);
    const catalog = await modelCatalog.listModels();
    // Mark which providers are usable: the user's own connection OR one shared by the workspace.
    const { connected, activated } = await withTenant(c, async ({ actor, orgId, database }) => {
      const [personal, shared, activatedLists] = await Promise.all([
        connectedProviderIds({ actor, orgId, database }),
        connectedOrgProviderIds({ actor, orgId, database }),
        getActivatedModels({ actor, orgId, database }),
      ]);
      return { connected: new Set<string>([...personal, ...shared]), activated: activatedLists };
    });
    // Prune stored activations against the live catalog so models.dev drift never shows ghosts.
    const known = new Set(catalog.models.map((m) => m.id));
    return c.json({
      models: catalog.models,
      providers: catalog.providers.map((p) => {
        const envKeys = catalog.models.find((m) => m.provider === p.id)?.env_keys ?? [];
        return { ...p, env_keys: envKeys, connected: connected.has(p.id) };
      }),
      activated: {
        personal: activated.personal.filter((id) => known.has(id)),
        org: activated.org.filter((id) => known.has(id)),
      },
    });
  } catch (error) {
    return jsonError(c, error, 401);
  }
});

/**
 * Activated-model lists (personal + workspace) — the short lists the run launcher's picker shows.
 * Ids are validated against the live catalog here (core is catalog-agnostic); createRun enforces
 * the activation gate at run time.
 */
async function rejectUnknownModels(c: Context, models: string[]): Promise<Response | null> {
  const catalog = await modelCatalog.listModels();
  const known = new Set(catalog.models.map((m) => m.id));
  const unknown = models.filter((m) => !known.has(m));
  if (unknown.length > 0) return jsonError(c, `unknown model(s): ${unknown.slice(0, 3).join(", ")}`, 400);
  return null;
}

app.put("/v1/model-preferences", async (c) => {
  try {
    if (isTokenRequest(c)) return jsonError(c, "personal access tokens cannot use model preferences", 401);
    const input = setActivatedModelsInputSchema.parse(await c.req.json());
    const rejected = await rejectUnknownModels(c, input.models);
    if (rejected) return rejected;
    const activated = await withTenant(c, ({ actor, orgId, database }) =>
      setUserActivatedModels({ actor, orgId, models: input.models, database }),
    );
    return c.json({ activated });
  } catch (error) {
    return jsonError(c, error);
  }
});

app.put("/v1/org-model-preferences", async (c) => {
  try {
    if (isTokenRequest(c)) return jsonError(c, "personal access tokens cannot use model preferences", 401);
    const input = setActivatedModelsInputSchema.parse(await c.req.json());
    const rejected = await rejectUnknownModels(c, input.models);
    if (rejected) return rejected;
    const activated = await withTenant(c, ({ actor, orgId, database }) =>
      setOrgActivatedModels({ actor, orgId, models: input.models, database }),
    );
    return c.json({ activated });
  } catch (error) {
    return jsonError(c, error);
  }
});

app.get("/v1/provider-connections", async (c) => {
  try {
    if (isTokenRequest(c)) return jsonError(c, "personal access tokens cannot use provider connections", 401);
    const connections = await withTenant(c, ({ actor, orgId, database }) =>
      listProviderConnections({ actor, orgId, database }),
    );
    return c.json({ connections });
  } catch (error) {
    return jsonError(c, error, 401);
  }
});

app.put("/v1/provider-connections", async (c) => {
  let masterKey: Buffer | null = null;
  try {
    if (isTokenRequest(c)) return jsonError(c, "personal access tokens cannot use provider connections", 401);
    const input = setModelProviderConnectionInputSchema.parse(await c.req.json());
    const catalog = await modelCatalog.listModels();
    const provider = catalog.providers.find((candidate) => candidate.id === input.provider);
    if (!provider || !provider.env_keys.includes(input.key_name)) {
      return jsonError(c, "the model provider or key name is unavailable", 422);
    }
    masterKey = loadSecretsMasterKey();
    const connection = await withTenant(c, ({ actor, orgId, database }) =>
      setProviderConnection({
        actor,
        orgId,
        provider: input.provider,
        keyName: input.key_name,
        apiKey: input.api_key,
        masterKey: masterKey!,
        database,
      }),
    );
    return c.json({ connection });
  } catch (error) {
    return jsonError(c, error);
  } finally {
    masterKey?.fill(0);
  }
});

app.delete("/v1/provider-connections/:provider", async (c) => {
  try {
    if (isTokenRequest(c)) return jsonError(c, "personal access tokens cannot use provider connections", 401);
    await withTenant(c, ({ actor, orgId, database }) =>
      deleteProviderConnection({ actor, orgId, provider: c.req.param("provider"), database }),
    );
    return c.json({ ok: true });
  } catch (error) {
    return jsonError(c, error);
  }
});

/* ---- Workspace-shared provider connections (owner/admin write; any member reads) ---- */

app.get("/v1/org-provider-connections", async (c) => {
  try {
    if (isTokenRequest(c)) return jsonError(c, "personal access tokens cannot use provider connections", 401);
    const connections = await withTenant(c, ({ actor, orgId, database }) =>
      listOrgProviderConnections({ actor, orgId, database }),
    );
    return c.json({ connections });
  } catch (error) {
    return jsonError(c, error, 401);
  }
});

app.put("/v1/org-provider-connections", async (c) => {
  let masterKey: Buffer | null = null;
  try {
    if (isTokenRequest(c)) return jsonError(c, "personal access tokens cannot use provider connections", 401);
    const input = setModelProviderConnectionInputSchema.parse(await c.req.json());
    const catalog = await modelCatalog.listModels();
    const provider = catalog.providers.find((candidate) => candidate.id === input.provider);
    if (!provider || !provider.env_keys.includes(input.key_name)) {
      return jsonError(c, "the model provider or key name is unavailable", 422);
    }
    masterKey = loadSecretsMasterKey();
    const connection = await withTenant(c, ({ actor, orgId, database }) =>
      setOrgProviderConnection({
        actor,
        orgId,
        provider: input.provider,
        keyName: input.key_name,
        apiKey: input.api_key,
        masterKey: masterKey!,
        database,
      }),
    );
    return c.json({ connection });
  } catch (error) {
    return jsonError(c, error);
  } finally {
    masterKey?.fill(0);
  }
});

app.delete("/v1/org-provider-connections/:provider", async (c) => {
  try {
    if (isTokenRequest(c)) return jsonError(c, "personal access tokens cannot use provider connections", 401);
    await withTenant(c, ({ actor, orgId, database }) =>
      deleteOrgProviderConnection({ actor, orgId, provider: c.req.param("provider"), database }),
    );
    return c.json({ ok: true });
  } catch (error) {
    return jsonError(c, error);
  }
});

/* ---- Projects (creator-private; session-only) ---------------------------------------------- */

class ProjectsFeatureDisabledError extends Error {}
class ProjectsSessionOnlyError extends Error {}
class InternalProductAccessRequiredError extends Error {}

function projectsFeatureEnabled(): boolean {
  const setting = process.env.COMPANION_PROJECTS_ENABLED?.trim().toLowerCase();
  return setting === "true" || setting === "1";
}

function assertProjectSession(c: Context): void {
  if (!projectsFeatureEnabled()) throw new ProjectsFeatureDisabledError();
  if (isTokenRequest(c) || isAgentRequest(c)) {
    throw new ProjectsSessionOnlyError("only authenticated browser sessions can use projects");
  }
  const actor = actorFromContext(c);
  if (!hasInternalProductAccess(actor.email)) {
    throw new InternalProductAccessRequiredError();
  }
}

function projectError(c: Context, error: unknown): Response {
  if (error instanceof ProjectsFeatureDisabledError) return jsonError(c, "not found", 404);
  if (error instanceof InternalProductAccessRequiredError) return jsonError(c, "not found", 404);
  if (error instanceof ProjectsSessionOnlyError) return jsonError(c, error, 401);
  if (error instanceof ProjectNotFoundError) return jsonError(c, error, 404);
  if (error instanceof ProjectConflictError) return jsonError(c, error, 409);
  if (error instanceof ProjectValidationError) {
    return jsonError(c, error, error.code === "runtime_unavailable" ? 503 : 422);
  }
  if (error instanceof RunValidationError) {
    if (error.code.endsWith("not_found")) return jsonError(c, error, 404);
    return jsonError(c, error, 422);
  }
  const message = error instanceof Error ? error.message : "";
  if (message === "not authenticated" || message.startsWith("personal access tokens")) {
    return jsonError(c, error, 401);
  }
  return jsonError(c, error);
}

async function projectRuntimeStatus(database: Db): Promise<{
  available: boolean;
  message: string | null;
}> {
  // Provider credentials, golden snapshot ids, and the secrets master key are worker-only. The
  // supervisor publishes a heartbeat only after validating its complete runtime configuration.
  if (!(await isProjectWorkerReady({ database }))) {
    return { available: false, message: "Project runtime is starting." };
  }
  return { available: true, message: null };
}

async function assertProjectRuntimeAvailable(database: Db): Promise<void> {
  const runtime = await projectRuntimeStatus(database);
  if (!runtime.available) {
    throw new ProjectValidationError(
      runtime.message ?? "Project runtime is unavailable.",
      "runtime_unavailable",
    );
  }
}

async function assertProjectModelAvailable(input: {
  actor: ReturnType<typeof actorFromContext>;
  orgId: string;
  model: string;
  database: Db;
}): Promise<{ provider: string; envKeys: string[] }> {
  const [catalog, personalConnections, orgConnections, activated] = await Promise.all([
    modelCatalog.listModels(),
    listProviderConnections(input),
    listOrgProviderConnections(input),
    getActivatedModels(input),
  ]);
  const row = catalog.models.find((candidate) => candidate.id === input.model);
  const active = new Set([...activated.personal, ...activated.org]);
  const effectiveConnection =
    personalConnections.find((connection) => connection.provider === row?.provider)
    ?? orgConnections.find((connection) => connection.provider === row?.provider);
  const credentialReady =
    row?.env_keys.length === 0
    || Boolean(effectiveConnection && row?.env_keys.includes(effectiveConnection.key_name));
  if (!row || !active.has(row.id) || !credentialReady) {
    throw new ProjectValidationError(
      "The selected model is not active with a connected provider.",
      "model_unavailable",
    );
  }
  return { provider: row.provider, envKeys: [...row.env_keys] };
}

async function projectAttachmentsFromForm(input: {
  actor: ReturnType<typeof actorFromContext>;
  orgId: string;
  projectId: string;
  idempotencyKey: string;
  entries: unknown[];
}): Promise<Array<{
  id: string;
  fileName: string;
  contentType: string;
  byteSize: number;
  checksum: string;
  storageKey: string;
  workspacePath: string;
}>> {
  const files = input.entries.filter(isRunUploadFile);
  if (files.length > PROJECT_ATTACHMENT_MAX_FILES) {
    throw new ProjectValidationError(
      `A prompt can have at most ${PROJECT_ATTACHMENT_MAX_FILES} files.`,
      "too_many_attachments",
    );
  }
  const names = new Map<string, number>();
  const attachments: Array<{
    id: string;
    fileName: string;
    contentType: string;
    byteSize: number;
    checksum: string;
    storageKey: string;
    workspacePath: string;
  }> = [];
  const uploads: Array<{ key: string; body: Buffer; contentType: string }> = [];
  for (const [index, file] of files.entries()) {
    if (file.size === 0) {
      throw new ProjectValidationError("An attached file is empty.", "empty_attachment");
    }
    if (file.size > PROJECT_ATTACHMENT_MAX_BYTES) {
      throw new ProjectValidationError(
        "Each attached file must be 10 MB or smaller.",
        "attachment_too_large",
      );
    }
    const body = Buffer.from(await file.arrayBuffer());
    const contentType = file.type || "application/octet-stream";
    const cleanName = sanitizeAttachmentName(file.name || `attachment-${index + 1}`);
    const occurrence = (names.get(cleanName) ?? 0) + 1;
    names.set(cleanName, occurrence);
    const dot = cleanName.lastIndexOf(".");
    const uniqueName =
      occurrence === 1
        ? cleanName
        : dot > 0
          ? `${cleanName.slice(0, dot)}-${occurrence}${cleanName.slice(dot)}`
          : `${cleanName}-${occurrence}`;
    const id = deterministicProjectAttachmentId({
      orgId: input.orgId,
      actorId: input.actor.id,
      projectId: input.projectId,
      idempotencyKey: input.idempotencyKey,
      index,
      fileName: uniqueName,
      contentType,
      bytes: body,
    });
    const storageKey = projectAttachmentKey({
      orgId: input.orgId,
      projectId: input.projectId,
      attachmentId: id,
    });
    uploads.push({ key: storageKey, body, contentType });
    attachments.push({
      id,
      fileName: uniqueName,
      contentType,
      byteSize: body.length,
      checksum: `sha256:${createHash("sha256").update(body).digest("hex")}`,
      storageKey,
      workspacePath: `files/${uniqueName}`,
    });
  }
  if (attachments.length > 0) {
    await withTenantContext({ orgId: input.orgId, userId: input.actor.id }, (database) =>
      reserveProjectAttachmentUploads({
        actor: input.actor,
        orgId: input.orgId,
        projectId: input.projectId,
        storageKeys: attachments.map((attachment) => attachment.storageKey),
        database,
      }),
    );
  }
  for (const upload of uploads) await putProjectAttachmentOnce(upload);
  return attachments;
}

async function projectFilesFromForm(input: {
  actor: ReturnType<typeof actorFromContext>;
  orgId: string;
  projectId: string;
  entries: unknown[];
}): Promise<Array<{
  path: string;
  contentType: string;
  byteSize: number;
  checksum: string;
  storageKey: string;
}>> {
  const files = input.entries.filter(isRunUploadFile);
  if (files.length < 1 || files.length > PROJECT_ATTACHMENT_MAX_FILES) {
    throw new ProjectValidationError(
      `Choose between 1 and ${PROJECT_ATTACHMENT_MAX_FILES} files.`,
      "invalid_file_count",
    );
  }
  const names = new Map<string, number>();
  const uploads: Array<{
    path: string;
    contentType: string;
    byteSize: number;
    checksum: string;
    storageKey: string;
    body: Buffer;
  }> = [];
  for (const [index, file] of files.entries()) {
    if (file.size === 0) {
      throw new ProjectValidationError("A Project file is empty.", "empty_file");
    }
    if (file.size > PROJECT_ATTACHMENT_MAX_BYTES) {
      throw new ProjectValidationError(
        "Each Project file must be 10 MB or smaller.",
        "file_too_large",
      );
    }
    const body = Buffer.from(await file.arrayBuffer());
    const contentType = file.type || "application/octet-stream";
    const cleanName = sanitizeAttachmentName(file.name || `file-${index + 1}`);
    const occurrence = (names.get(cleanName) ?? 0) + 1;
    names.set(cleanName, occurrence);
    const dot = cleanName.lastIndexOf(".");
    const uniqueName =
      occurrence === 1
        ? cleanName
        : dot > 0
          ? `${cleanName.slice(0, dot)}-${occurrence}${cleanName.slice(dot)}`
          : `${cleanName}-${occurrence}`;
    const checksum = `sha256:${createHash("sha256").update(body).digest("hex")}`;
    uploads.push({
      path: `files/${uniqueName}`,
      contentType,
      byteSize: body.length,
      checksum,
      storageKey: projectFileCacheKey({
        orgId: input.orgId,
        projectId: input.projectId,
        checksum,
      }),
      body,
    });
  }
  await withTenantContext({ orgId: input.orgId, userId: input.actor.id }, (database) =>
    reserveProjectFileUploads({
      actor: input.actor,
      orgId: input.orgId,
      projectId: input.projectId,
      storageKeys: uploads.map((upload) => upload.storageKey),
      database,
    }),
  );
  for (const upload of uploads) {
    try {
      await putSkillArchive({
        key: upload.storageKey,
        body: upload.body,
        contentType: upload.contentType,
        preventOverwrite: true,
      });
    } catch (error) {
      if (!isStoragePreconditionFailure(error)) throw error;
      const existing = await getSkillArchive({ key: upload.storageKey });
      const checksum = `sha256:${createHash("sha256").update(existing).digest("hex")}`;
      if (checksum !== upload.checksum || existing.length !== upload.body.length) {
        throw new ProjectValidationError(
          "The stored Project file failed its integrity check.",
          "file_integrity_failed",
        );
      }
    }
  }
  return uploads.map(({ body: _, ...upload }) => upload);
}

const projectEventSubscribers = new Map<string, Set<(sequence: number) => void>>();
let projectEventListenerPromise: Promise<void> | null = null;

async function subscribeProjectEventCursor(
  sessionId: string,
  callback: (sequence: number) => void,
): Promise<() => void> {
  if (!projectEventListenerPromise) {
    projectEventListenerPromise = postgresSql
      .listen("project_session_events", (payload) => {
        const notification = parseProjectEventNotification(payload);
        if (!notification) return;
        for (const subscriber of projectEventSubscribers.get(notification.sessionId) ?? []) {
          subscriber(notification.sequence);
        }
      })
      .then(() => undefined)
      .catch((error) => {
        projectEventListenerPromise = null;
        throw error;
      });
  }
  await projectEventListenerPromise;
  const subscribers =
    projectEventSubscribers.get(sessionId) ?? new Set<(sequence: number) => void>();
  subscribers.add(callback);
  projectEventSubscribers.set(sessionId, subscribers);
  return () => {
    subscribers.delete(callback);
    if (subscribers.size === 0) projectEventSubscribers.delete(sessionId);
  };
}

app.get("/v1/projects", async (c) => {
  try {
    assertProjectSession(c);
    const query = listProjectsQuerySchema.parse({
      view: c.req.query("view") ?? undefined,
    });
    const result = await withTenant(c, async ({ actor, orgId, database }) => ({
      projects: await listProjects({
        actor,
        orgId,
        view: query.view,
        database,
      }),
      runtime: await projectRuntimeStatus(database),
    }));
    return c.json(result);
  } catch (error) {
    return projectError(c, error);
  }
});

app.post("/v1/projects", async (c) => {
  try {
    assertProjectSession(c);
    const requestKey = idempotencyKey(c);
    const value = createProjectInputSchema.parse(await c.req.json());
    const replay = await withTenant(c, ({ actor, orgId, database }) =>
      getProjectCreateReplay({
        actor,
        orgId,
        value,
        idempotencyKey: requestKey,
        database,
      }),
    );
    if (replay) return c.json(replay, 201);
    const project = await withTenant(c, async ({ actor, orgId, database }) => {
      await assertProjectRuntimeAvailable(database);
      await assertProjectModelAvailable({
        actor,
        orgId,
        model: value.default_model,
        database,
      });
      return createProject({
        actor,
        orgId,
        value,
        idempotencyKey: requestKey,
        database,
      });
    });
    return c.json(project, 201);
  } catch (error) {
    return projectError(c, error);
  }
});

app.get("/v1/projects/:id", async (c) => {
  try {
    assertProjectSession(c);
    const project = await withTenant(c, ({ actor, orgId, database }) =>
      getProject({ actor, orgId, projectId: c.req.param("id"), database }),
    );
    return c.json(project);
  } catch (error) {
    return projectError(c, error);
  }
});

app.patch("/v1/projects/:id", async (c) => {
  try {
    assertProjectSession(c);
    const value = updateProjectInputSchema.parse(await c.req.json());
    const project = await withTenant(c, async ({ actor, orgId, database }) => {
      if (value.default_model) {
        await assertProjectModelAvailable({
          actor,
          orgId,
          model: value.default_model,
          database,
        });
      }
      return updateProject({ actor, orgId, projectId: c.req.param("id"), value, database });
    });
    return c.json(project);
  } catch (error) {
    return projectError(c, error);
  }
});

app.post("/v1/projects/:id/retry", async (c) => {
  try {
    assertProjectSession(c);
    const project = await withTenant(c, ({ actor, orgId, database }) =>
      retryProjectWorkspace({
        actor,
        orgId,
        projectId: c.req.param("id"),
        database,
      }),
    );
    return c.json(project, 202);
  } catch (error) {
    return projectError(c, error);
  }
});

app.delete("/v1/projects/:id", async (c) => {
  try {
    assertProjectSession(c);
    await withTenant(c, ({ actor, orgId, database }) =>
      requestProjectDeletion({
        actor,
        orgId,
        projectId: c.req.param("id"),
        database,
      }),
    );
    return c.json({ ok: true }, 202);
  } catch (error) {
    return projectError(c, error);
  }
});

app.put("/v1/projects/:id/skills", async (c) => {
  try {
    assertProjectSession(c);
    const value = setProjectSkillsInputSchema.parse(await c.req.json());
    const project = await withTenant(c, ({ actor, orgId, database }) =>
      setProjectSkills({
        actor,
        orgId,
        projectId: c.req.param("id"),
        value,
        database,
      }),
    );
    return c.json(project);
  } catch (error) {
    return projectError(c, error);
  }
});

app.get("/v1/projects/:id/sessions", async (c) => {
  try {
    assertProjectSession(c);
    const query = listProjectSessionsQuerySchema.parse({
      q: c.req.query("q") ?? undefined,
      view: c.req.query("view") ?? undefined,
      cursor: c.req.query("cursor") ?? undefined,
      limit: c.req.query("limit") ?? undefined,
    });
    const result = await withTenant(c, ({ actor, orgId, database }) =>
      listProjectSessions({
        actor,
        orgId,
        projectId: c.req.param("id"),
        query,
        database,
      }),
    );
    return c.json(result);
  } catch (error) {
    return projectError(c, error);
  }
});

app.post(
  "/v1/projects/:id/sessions",
  // Authenticate before bodyLimit so an unauthenticated caller cannot make the server consume or
  // measure a large multipart body.
  async (c, next) => {
    try {
      assertProjectSession(c);
    } catch (error) {
      return projectError(c, error);
    }
    await next();
  },
  bodyLimit({
    maxSize: 64 * 1024 * 1024,
    onError: (c) => jsonError(c, "Project upload exceeds the 64 MB limit.", 413),
  }),
  async (c) => {
    try {
      assertProjectSession(c);
      if (!c.req.header("content-type")?.toLowerCase().startsWith("multipart/form-data")) {
        return jsonError(c, "Project sessions require multipart/form-data.", 415);
      }
      const actor = actorFromContext(c);
      const orgId = await orgIdFromContext(c);
      const projectId = c.req.param("id");
      const requestKey = idempotencyKey(c);
      const form = await c.req.formData();
      const fields = createProjectSessionFieldsSchema.parse({
        prompt: typeof form.get("prompt") === "string" ? form.get("prompt") : "",
        model:
          typeof form.get("model") === "string" && form.get("model") !== ""
            ? form.get("model")
            : undefined,
        title:
          typeof form.get("title") === "string" && form.get("title") !== ""
            ? form.get("title")
            : undefined,
      });
      let modelProvider: string | null = null;
      let modelCredentialEnvKeys: string[] | null = null;
      await withTenantContext(
        { orgId, userId: actor.id },
        async (database) => {
          if (
            await hasProjectPromptIdempotencyKey({
              actor,
              orgId,
              idempotencyKey: requestKey,
              database,
            })
          ) {
            return;
          }
          await assertProjectRuntimeAvailable(database);
          const detail = await getProject({ actor, orgId, projectId, database });
          const model = fields.model ?? detail.default_model;
          const admission = await assertProjectModelAvailable({
            actor,
            orgId,
            model,
            database,
          });
          modelProvider = admission.provider;
          modelCredentialEnvKeys = admission.envKeys;
        },
      );
      const attachments = await projectAttachmentsFromForm({
        actor,
        orgId,
        projectId,
        idempotencyKey: requestKey,
        entries: form.getAll("file"),
      });
      const session = await withTenantContext(
        { orgId, userId: actor.id },
        (database) =>
          createProjectSession({
            actor,
            orgId,
            projectId,
            prompt: fields.prompt,
            model: fields.model,
            modelProvider,
            modelCredentialEnvKeys,
            title: fields.title,
            idempotencyKey: requestKey,
            attachments,
            database,
          }),
      );
      return c.json(session, 201);
    } catch (error) {
      return projectError(c, error);
    }
  },
);

app.get("/v1/projects/:id/sessions/:sessionId", async (c) => {
  try {
    assertProjectSession(c);
    const session = await withTenant(c, ({ actor, orgId, database }) =>
      getProjectSession({
        actor,
        orgId,
        projectId: c.req.param("id"),
        sessionId: c.req.param("sessionId"),
        database,
      }),
    );
    return c.json(session);
  } catch (error) {
    return projectError(c, error);
  }
});

app.patch("/v1/projects/:id/sessions/:sessionId", async (c) => {
  try {
    assertProjectSession(c);
    const value = updateProjectSessionInputSchema.parse(await c.req.json());
    const session = await withTenant(c, async ({ actor, orgId, database }) => {
      const projectId = c.req.param("id");
      const sessionId = c.req.param("sessionId");
      await updateProjectSession({
        actor,
        orgId,
        projectId,
        sessionId,
        value,
        database,
      });
      return getProjectSession({
        actor,
        orgId,
        projectId,
        sessionId,
        database,
      });
    });
    return c.json(session, value.stop_active ? 202 : 200);
  } catch (error) {
    return projectError(c, error);
  }
});

app.get(
  "/v1/projects/:id/sessions/:sessionId/attachments/:attachmentId",
  async (c) => {
    try {
      assertProjectSession(c);
      const loadAttachment = async (): Promise<RunDownloadAsset> => {
        const attachment = await withTenant(
          c,
          ({ actor, orgId, database }) =>
            getProjectPromptAttachment({
              actor,
              orgId,
              projectId: c.req.param("id"),
              sessionId: c.req.param("sessionId"),
              attachmentId: c.req.param("attachmentId"),
              database,
            }),
        );
        return {
          fileName: attachment.fileName,
          contentType: attachment.contentType,
          previewContentType: RUN_INLINE_MEDIA_TYPES.has(
            attachment.contentType,
          )
            ? attachment.contentType
            : null,
          byteSize: attachment.byteSize,
          storageKey: attachment.storageKey,
        };
      };
      return await streamRunDownload(
        c,
        await loadAttachment(),
        loadAttachment,
      );
    } catch (error) {
      return projectError(c, error);
    }
  },
);

app.post(
  "/v1/projects/:id/sessions/:sessionId/prompts",
  async (c, next) => {
    try {
      assertProjectSession(c);
    } catch (error) {
      return projectError(c, error);
    }
    await next();
  },
  bodyLimit({
    maxSize: 64 * 1024 * 1024,
    onError: (c) => jsonError(c, "Project upload exceeds the 64 MB limit.", 413),
  }),
  async (c) => {
    try {
      assertProjectSession(c);
      if (!c.req.header("content-type")?.toLowerCase().startsWith("multipart/form-data")) {
        return jsonError(c, "Project prompts require multipart/form-data.", 415);
      }
      const actor = actorFromContext(c);
      const orgId = await orgIdFromContext(c);
      const projectId = c.req.param("id");
      const sessionId = c.req.param("sessionId");
      const requestKey = idempotencyKey(c);
      const form = await c.req.formData();
      const fields = projectPromptFieldsSchema.parse({
        prompt: typeof form.get("prompt") === "string" ? form.get("prompt") : "",
        model:
          typeof form.get("model") === "string" && form.get("model") !== ""
            ? form.get("model")
            : undefined,
      });
      await withTenantContext({ orgId, userId: actor.id }, async (database) => {
        if (
          await hasProjectPromptIdempotencyKey({
            actor,
            orgId,
            idempotencyKey: requestKey,
            database,
          })
        ) {
          return;
        }
        await assertProjectRuntimeAvailable(database);
        const session = await getProjectSession({
          actor,
          orgId,
          projectId,
          sessionId,
          database,
        });
        if (fields.model && fields.model !== session.model) {
          throw new ProjectConflictError("A session's model cannot change.");
        }
        await assertProjectModelAvailable({
          actor,
          orgId,
          model: session.model,
          database,
        });
      });
      const attachments = await projectAttachmentsFromForm({
        actor,
        orgId,
        projectId,
        idempotencyKey: requestKey,
        entries: form.getAll("file"),
      });
      const session = await withTenantContext(
        { orgId, userId: actor.id },
        async (database) => {
          await enqueueProjectPrompt({
            actor,
            orgId,
            projectId,
            sessionId,
            text: fields.prompt,
            model: fields.model,
            idempotencyKey: requestKey,
            attachments,
            database,
          });
          return getProjectSession({
            actor,
            orgId,
            projectId,
            sessionId,
            database,
          });
        },
      );
      return c.json(session, 202);
    } catch (error) {
      return projectError(c, error);
    }
  },
);

app.post("/v1/projects/:id/sessions/:sessionId/stop", async (c) => {
  try {
    assertProjectSession(c);
    const session = await withTenant(c, async ({ actor, orgId, database }) => {
      await requestProjectSessionStop({
        actor,
        orgId,
        projectId: c.req.param("id"),
        sessionId: c.req.param("sessionId"),
        database,
      });
      return getProjectSession({
        actor,
        orgId,
        projectId: c.req.param("id"),
        sessionId: c.req.param("sessionId"),
        database,
      });
    });
    return c.json(session, 202);
  } catch (error) {
    return projectError(c, error);
  }
});

app.get("/v1/projects/:id/sessions/:sessionId/events", async (c) => {
  try {
    assertProjectSession(c);
    const projectId = c.req.param("id");
    const sessionId = c.req.param("sessionId");
    const actor = actorFromContext(c);
    const orgId = await orgIdFromContext(c);
    await withTenantContext({ orgId, userId: actor.id }, (database) =>
      getProjectSession({ actor, orgId, projectId, sessionId, database }),
    );
    let cursor = parseProjectLastEventId(
      c.req.header("Last-Event-ID") ?? c.req.query("last_event_id"),
    );
    const encoder = new TextEncoder();
    let closed = false;
    let notified = false;
    let readySent = false;
    let terminalObserved = false;
    let wake: (() => void) | null = null;
    let unsubscribe: () => void = () => undefined;
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (frame: string) => {
          if (!closed) controller.enqueue(encoder.encode(frame));
        };
        const waitForWake = () =>
          new Promise<void>((resolve) => {
            let settled = false;
            const finish = () => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              resolve();
            };
            const timer = setTimeout(finish, 15_000);
            timer.unref();
            wake = finish;
            if (notified) finish();
          });
        unsubscribe = await subscribeProjectEventCursor(sessionId, (sequence) => {
          if (sequence <= cursor) return;
          notified = true;
          wake?.();
        });
        c.req.raw.signal.addEventListener(
          "abort",
          () => {
            closed = true;
            wake?.();
          },
          { once: true },
        );
        try {
          while (!closed) {
            notified = false;
            const events = await withTenantContext(
              { orgId, userId: actor.id },
              (database) =>
                listProjectSessionEvents({
                  actor,
                  orgId,
                  projectId,
                  sessionId,
                  after: cursor,
                  limit: 500,
                  database,
                }),
            );
            for (const envelope of events) {
              if (envelope.sequence <= cursor) continue;
              cursor = envelope.sequence;
              send(projectEventFrame(envelope));
            }
            if (events.length >= 500 || notified) continue;
            const session = await withTenantContext(
              { orgId, userId: actor.id },
              (database) =>
                getProjectSession({ actor, orgId, projectId, sessionId, database }),
            );
            const terminal = ["stopped", "completed", "error"].includes(session.status);
            if (terminal && terminalObserved) break;
            if (terminal) {
              terminalObserved = true;
              continue;
            }
            if (!readySent) {
              send(projectReadyFrame(sessionId));
              readySent = true;
            }
            send(": keepalive\n\n");
            await waitForWake();
            wake = null;
          }
        } catch {
          // EventSource reconnects with Last-Event-ID and replays from durable creator-scoped rows.
        } finally {
          closed = true;
          unsubscribe();
          try {
            controller.close();
          } catch {
            // Already closed by the client.
          }
        }
      },
      cancel() {
        closed = true;
        wake?.();
        unsubscribe();
      },
    });
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache, no-transform",
        "x-accel-buffering": "no",
        connection: "keep-alive",
      },
    });
  } catch (error) {
    return projectError(c, error);
  }
});

app.post(
  "/v1/projects/:id/files",
  async (c, next) => {
    try {
      assertProjectSession(c);
    } catch (error) {
      return projectError(c, error);
    }
    await next();
  },
  bodyLimit({
    maxSize: 64 * 1024 * 1024,
    onError: (c) => jsonError(c, "Project upload exceeds the 64 MB limit.", 413),
  }),
  async (c) => {
    try {
      assertProjectSession(c);
      if (!c.req.header("content-type")?.toLowerCase().startsWith("multipart/form-data")) {
        return jsonError(c, "Project files require multipart/form-data.", 415);
      }
      const actor = actorFromContext(c);
      const orgId = await orgIdFromContext(c);
      const projectId = c.req.param("id");
      const form = await c.req.formData();
      const uploads = await projectFilesFromForm({
        actor,
        orgId,
        projectId,
        entries: form.getAll("file"),
      });
      const files = await withTenantContext(
        { orgId, userId: actor.id },
        (database) =>
          commitProjectFileUploads({
            actor,
            orgId,
            projectId,
            files: uploads,
            database,
          }),
      );
      return c.json({ files }, 201);
    } catch (error) {
      return projectError(c, error);
    }
  },
);

app.get("/v1/projects/:id/files", async (c) => {
  try {
    assertProjectSession(c);
    const files = await withTenant(c, ({ actor, orgId, database }) =>
      listProjectFiles({
        actor,
        orgId,
        projectId: c.req.param("id"),
        database,
      }),
    );
    return c.json({ files });
  } catch (error) {
    return projectError(c, error);
  }
});

app.get("/v1/projects/:id/files/:fileId/versions", async (c) => {
  try {
    assertProjectSession(c);
    const versions = await withTenant(c, ({ actor, orgId, database }) =>
      listProjectFileVersions({
        actor,
        orgId,
        projectId: c.req.param("id"),
        fileId: c.req.param("fileId"),
        database,
      }),
    );
    return c.json({ versions });
  } catch (error) {
    return projectError(c, error);
  }
});

app.get("/v1/projects/:id/files/:fileId/versions/:version", async (c) => {
  try {
    assertProjectSession(c);
    const version = Number(c.req.param("version"));
    const loadFile = async (): Promise<RunDownloadAsset> => {
      const file = await withTenant(c, ({ actor, orgId, database }) =>
        getProjectFileVersion({
          actor,
          orgId,
          projectId: c.req.param("id"),
          fileId: c.req.param("fileId"),
          version,
          database,
        }),
      );
      return {
        fileName: file.path.split("/").pop() || "file",
        contentType: file.content_type,
        previewContentType: RUN_INLINE_MEDIA_TYPES.has(file.content_type)
          ? file.content_type
          : null,
        byteSize: file.byte_size,
        storageKey: file.storage_key,
        generation: `${file.version}:${file.checksum}`,
      };
    };
    return await streamRunDownload(c, await loadFile(), loadFile);
  } catch (error) {
    return projectError(c, error);
  }
});

app.get("/v1/projects/:id/files/:fileId", async (c) => {
  try {
    assertProjectSession(c);
    const loadFile = async (): Promise<RunDownloadAsset> => {
      const file = await withTenant(c, ({ actor, orgId, database }) =>
        getProjectFile({
          actor,
          orgId,
          projectId: c.req.param("id"),
          fileId: c.req.param("fileId"),
          database,
        }),
      );
      return {
        fileName: file.path.split("/").pop() || "file",
        contentType: file.content_type,
        previewContentType: RUN_INLINE_MEDIA_TYPES.has(file.content_type)
          ? file.content_type
          : null,
        byteSize: file.byte_size,
        storageKey: file.storage_key,
        generation: `${file.version}:${file.checksum}`,
      };
    };
    return await streamRunDownload(c, await loadFile(), loadFile);
  } catch (error) {
    return projectError(c, error);
  }
});

/* ---- Skill runs (one-shot sandboxed sessions; session-only, PATs rejected) ------------------ */

function boundedInteger(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function runPrewarmEnabled(): boolean {
  const setting = process.env.COMPANION_RUN_PREWARM_ENABLED?.trim().toLowerCase();
  return setting !== "false" && setting !== "0";
}

/** API-side run context contains catalog/readiness only. Runtime SDKs are composed by apps/worker. */
async function apiRunContext(input: { includeModels?: boolean } = {}): Promise<RunControlContext> {
  let masterKey: Buffer;
  let secretsAvailable = true;
  try {
    masterKey = loadSecretsMasterKey();
  } catch {
    // Options and saved configurations remain readable when execution is disabled. createRun fails
    // closed on runtimeAvailable before this placeholder can ever encrypt anything.
    masterKey = Buffer.alloc(32);
    secretsAvailable = false;
  }
  // Only run-options needs the complete catalog. Launches resolve their selected model lazily after
  // createRun has had a chance to return an already-committed idempotent replay.
  const catalog = input.includeModels ? await modelCatalog.listModels() : null;
  const goldenSnapshotId = process.env.COMPANION_GOLDEN_SNAPSHOT_ID?.trim() || null;
  const enabledSetting = process.env.COMPANION_RUNS_ENABLED?.trim().toLowerCase();
  // The API intentionally does not receive Vercel credentials. Operators enable this only when the
  // separately configured runs worker is ready; absent/invalid flags fail closed instead of queuing
  // work that no worker can execute.
  const enabled = enabledSetting === "true" || enabledSetting === "1";
  const missing = [
    !enabled ? "RunSkill" : null,
    !goldenSnapshotId ? "golden snapshot" : null,
    !secretsAvailable ? "secrets master key" : null,
  ].filter((value): value is string => Boolean(value));
  return {
    masterKey,
    goldenSnapshotId,
    opencodeVersion: process.env.OPENCODE_VERSION?.trim() || null,
    region: process.env.COMPANION_SANDBOX_REGION?.trim() || "iad1",
    timeoutMs: boundedInteger(process.env.COMPANION_SANDBOX_TIMEOUT_MS, 300_000, 10_000, 3_600_000),
    resolveModelKeys: (model) => modelCatalog.resolveModel(model),
    models: catalog?.models,
    runtimeAvailable: missing.length === 0,
    runtimeMessage: missing.length === 0 ? null : `RunSkill is unavailable: configure ${missing.join(", ")}`,
    resolveRuntimeReadiness:
      missing.length === 0
        ? async (database) => {
            const available = await isRunWorkerReady({ database });
            return {
              available,
              message: available
                ? null
                : "RunSkill is unavailable because no configured run worker is currently online.",
            };
          }
        : undefined,
  };
}

async function withApiRunContext<T>(
  fn: (ctx: RunControlContext) => Promise<T>,
  input: { includeModels?: boolean } = {},
): Promise<T> {
  const ctx = await apiRunContext(input);
  try {
    return await fn(ctx);
  } finally {
    ctx.masterKey.fill(0);
  }
}

class RunFeatureDisabledError extends Error {}
class RunSessionOnlyError extends Error {}

function runFeatureEnabled(): boolean {
  const setting = process.env.COMPANION_RUNS_ENABLED?.trim().toLowerCase();
  return setting === "true" || setting === "1";
}

function assertRunSession(c: Context): void {
  if (!runFeatureEnabled()) throw new RunFeatureDisabledError();
  if (isTokenRequest(c) || isAgentRequest(c)) {
    throw new RunSessionOnlyError("only authenticated browser sessions can use skill runs");
  }
  const actor = actorFromContext(c);
  if (!hasInternalProductAccess(actor.email)) {
    throw new InternalProductAccessRequiredError();
  }
}

function idempotencyKey(c: Context): string {
  const value = c.req.header("Idempotency-Key")?.trim();
  if (
    !value
    || value.length < 8
    || value.length > 200
    || !/^[A-Za-z0-9._:-]+$/.test(value)
  ) {
    throw new RunValidationError("a valid Idempotency-Key header is required", "invalid_idempotency_key");
  }
  return value;
}

function isRunUploadFile(value: unknown): value is {
  name: string;
  size: number;
  type: string;
  arrayBuffer(): Promise<ArrayBuffer>;
} {
  return Boolean(
    value
      && typeof value === "object"
      && "name" in value
      && "size" in value
      && "type" in value
      && "arrayBuffer" in value
      && typeof (value as { arrayBuffer?: unknown }).arrayBuffer === "function",
  );
}

/** Map run service failures onto the HTTP statuses the run UI expects. */
function runError(c: Context, error: unknown): Response {
  if (error instanceof RunFeatureDisabledError) return jsonError(c, "not found", 404);
  if (error instanceof InternalProductAccessRequiredError) return jsonError(c, "not found", 404);
  if (error instanceof RunSessionOnlyError) return jsonError(c, error, 401);
  if (error instanceof RunBusyError) return jsonError(c, error, 409);
  if (error instanceof RunValidationError) {
    if (error.code.endsWith("not_found")) return jsonError(c, error, 404);
    if (error.code === "runtime_unavailable") return jsonError(c, error, 503);
    return jsonError(c, error, 422);
  }
  const message = error instanceof Error ? error.message : "";
  if (message === "not authenticated" || message.startsWith("personal access tokens")) {
    return jsonError(c, error, 401);
  }
  return jsonError(c, error);
}

// One process-wide LISTEN connection fans cursor-only notifications out to all active SSE streams.
// A dedicated PostgreSQL connection per browser stream would eventually starve the API pool.
const runEventSubscribers = new Map<string, Set<(sequence: number) => void>>();
let runEventListenerPromise: Promise<void> | null = null;

async function subscribeRunEventCursor(runId: string, callback: (sequence: number) => void): Promise<() => void> {
  if (!runEventListenerPromise) {
    runEventListenerPromise = postgresSql
      .listen("skill_run_events", (payload) => {
        const notification = parseRunEventNotification(payload);
        if (!notification) return;
        for (const subscriber of runEventSubscribers.get(notification.runId) ?? []) {
          subscriber(notification.sequence);
        }
      })
      .then(() => undefined)
      .catch((error) => {
        runEventListenerPromise = null;
        throw error;
      });
  }
  await runEventListenerPromise;
  const subscribers = runEventSubscribers.get(runId) ?? new Set<(sequence: number) => void>();
  subscribers.add(callback);
  runEventSubscribers.set(runId, subscribers);
  return () => {
    subscribers.delete(callback);
    if (subscribers.size === 0) runEventSubscribers.delete(runId);
  };
}

app.get("/v1/skills/:slug/run-options", async (c) => {
  try {
    assertRunSession(c);
    const options = await withApiRunContext(
      (ctx) =>
        withTenant(c, ({ actor, orgId, database }) =>
          getRunOptions({ actor, orgId, slug: c.req.param("slug"), ctx, database }),
        ),
      { includeModels: true },
    );
    return c.json(options);
  } catch (error) {
    return runError(c, error);
  }
});

app.get("/v1/run-preferences", async (c) => {
  try {
    assertRunSession(c);
    const preferences = await withTenant(c, ({ actor, orgId, database }) =>
      getRunPreferences({ actorId: actor.id, orgId, database }),
    );
    return c.json(preferences);
  } catch (error) {
    return runError(c, error);
  }
});

app.patch("/v1/run-preferences", async (c) => {
  try {
    assertRunSession(c);
    const value = runPreferencesSchema.parse(await c.req.json());
    const preferences = await withTenant(c, ({ actor, orgId, database }) =>
      updateRunPreferences({
        actorId: actor.id,
        orgId,
        prewarmEnabled: value.prewarm_enabled,
        database,
      }),
    );
    return c.json(preferences);
  } catch (error) {
    return runError(c, error);
  }
});

app.post("/v1/skills/:slug/run-prewarms", async (c) => {
  try {
    assertRunSession(c);
    if (!runPrewarmEnabled()) {
      return c.json({ prewarm: null }, 200);
    }
    const prewarm = await withApiRunContext((ctx) =>
      withTenant(c, ({ actor, orgId, database }) =>
        createRunPrewarm({ actor, orgId, slug: c.req.param("slug"), ctx, database }),
      ),
    );
    return c.json({ prewarm }, prewarm ? 202 : 200);
  } catch (error) {
    return runError(c, error);
  }
});

app.post("/v1/run-prewarms/:id/heartbeat", async (c) => {
  try {
    assertRunSession(c);
    const prewarm = await withTenant(c, ({ actor, orgId, database }) =>
      heartbeatRunPrewarm({ actor, orgId, prewarmId: c.req.param("id"), database }),
    );
    return prewarm ? c.json({ prewarm }) : jsonError(c, "prewarm not found", 404);
  } catch (error) {
    return runError(c, error);
  }
});

app.post("/v1/run-prewarms/:id/cancel", async (c) => {
  try {
    assertRunSession(c);
    await withTenant(c, ({ actor, orgId, database }) =>
      cancelRunPrewarm({ actor, orgId, prewarmId: c.req.param("id"), database }),
    );
    return c.json({ ok: true }, 202);
  } catch (error) {
    return runError(c, error);
  }
});

app.get("/v1/skills/:slug/run-configurations", async (c) => {
  try {
    assertRunSession(c);
    const configurations = await withApiRunContext((ctx) =>
      withTenant(c, ({ actor, orgId, database }) =>
        listRunConfigurations({ actor, orgId, slug: c.req.param("slug"), ctx, database }),
      ),
    );
    return c.json({ configurations });
  } catch (error) {
    return runError(c, error);
  }
});

app.post("/v1/skills/:slug/run-configurations", async (c) => {
  try {
    assertRunSession(c);
    const value = createRunConfigurationInputSchema.parse(await c.req.json());
    const configuration = await withApiRunContext((ctx) =>
      withTenant(c, ({ actor, orgId, database }) =>
        createRunConfiguration({ actor, orgId, slug: c.req.param("slug"), value, ctx, database }),
      ),
    );
    return c.json(configuration, 201);
  } catch (error) {
    return runError(c, error);
  }
});

app.patch("/v1/run-configurations/:id", async (c) => {
  try {
    assertRunSession(c);
    const value = updateRunConfigurationInputSchema.parse(await c.req.json());
    const configuration = await withApiRunContext((ctx) =>
      withTenant(c, ({ actor, orgId, database }) =>
        updateRunConfiguration({ actor, orgId, configId: c.req.param("id"), value, ctx, database }),
      ),
    );
    return c.json(configuration);
  } catch (error) {
    return runError(c, error);
  }
});

app.delete("/v1/run-configurations/:id", async (c) => {
  try {
    assertRunSession(c);
    const value = deleteRunConfigurationInputSchema.parse(await c.req.json());
    await withTenant(c, ({ actor, orgId, database }) =>
      deleteRunConfiguration({ actor, orgId, configId: c.req.param("id"), value, database }),
    );
    return c.json({ ok: true });
  } catch (error) {
    return runError(c, error);
  }
});

app.post(
  "/v1/skills/:slug/runs",
  // Authenticate before the body-reading bodyLimit middleware, so an unauthenticated caller can't
  // make the server read or measure a large upload body.
  async (c, next) => {
    try {
      assertRunSession(c);
    } catch (error) {
      return runError(c, error);
    }
    await next();
  },
  // 5 files x 10 MB + form overhead.
  bodyLimit({ maxSize: 64 * 1024 * 1024, onError: (c) => jsonError(c, "run upload exceeds the 64 MB limit", 413) }),
  async (c) => {
    try {
      const slug = c.req.param("slug");
      const actor = actorFromContext(c);
      const orgId = await orgIdFromContext(c);
      const requestKey = idempotencyKey(c);

      const form = await c.req.formData();
      const fields = launchRunFieldsSchema.parse({
        prompt: typeof form.get("prompt") === "string" ? form.get("prompt") : "",
        model: typeof form.get("model") === "string" ? form.get("model") : "",
        skill_version_id: typeof form.get("skill_version_id") === "string" ? form.get("skill_version_id") : "",
        dependency_pins: typeof form.get("dependency_pins") === "string" ? form.get("dependency_pins") : "",
        inputs: typeof form.get("inputs") === "string" ? form.get("inputs") : "",
        model_provider_connection_id:
          typeof form.get("model_provider_connection_id") === "string" && form.get("model_provider_connection_id") !== ""
            ? form.get("model_provider_connection_id")
            : undefined,
        model_provider_credential_version:
          typeof form.get("model_provider_credential_version") === "string" && form.get("model_provider_credential_version") !== ""
            ? form.get("model_provider_credential_version")
            : undefined,
        prewarm_id:
          typeof form.get("prewarm_id") === "string" && form.get("prewarm_id") !== ""
            ? form.get("prewarm_id")
            : undefined,
        run_config_id:
          typeof form.get("run_config_id") === "string" && form.get("run_config_id") !== ""
            ? form.get("run_config_id")
            : undefined,
      });
      // File entries only (the other branch of FormDataEntryValue is `string`).
      const files = form.getAll("file").filter((f): f is Exclude<typeof f, string> => typeof f !== "string");
      if (files.length > RUN_ATTACHMENT_MAX_FILES) {
        throw new Error(`a run can have at most ${RUN_ATTACHMENT_MAX_FILES} attachments`);
      }
      for (const file of files) {
        if (file.size === 0) throw new Error("an attached file is empty");
        if (file.size > RUN_ATTACHMENT_MAX_BYTES) throw new Error("each attachment must be 10 MB or smaller");
      }

      // Upload the bytes to object storage OUTSIDE any DB transaction (slow uploads must not hold a
      // pooled connection idle-in-transaction); createRun below persists metadata only.
      const attachments: Array<{
        id: string;
        fileName: string;
        contentType: string;
        previewContentType: string | null;
        previewKind: RunFilePreviewKind | null;
        byteSize: number;
        storageKey: string;
      }> = [];
      try {
        for (const file of files) {
          const buf = Buffer.from(await file.arrayBuffer());
          const attachmentId = deterministicRunAttachmentId({
            orgId,
            actorId: actor.id,
            idempotencyKey: requestKey,
            index: attachments.length,
            fileName: file.name,
            contentType: file.type || "application/octet-stream",
            bytes: buf,
          });
          const key = runAttachmentKey({ orgId, attachmentId });
          const contentType = file.type || "application/octet-stream";
          await withTenantContext({ orgId, userId: actor.id }, (database) =>
            reserveRunAttachmentUploads({ actor, orgId, storageKeys: [key], database }),
          );
          await putRunAttachmentOnce({ key, body: buf, contentType });
          const detected = detectRunFileType(file.name, buf);
          attachments.push({
            id: attachmentId,
            fileName: sanitizeAttachmentName(file.name || `attachment-${attachments.length + 1}`),
            contentType,
            previewContentType: detected.previewContentType,
            previewKind: detected.previewKind,
            byteSize: buf.length,
            storageKey: key,
          });
        }
        const detail = await withApiRunContext((ctx) =>
          withTenantContext({ orgId, userId: actor.id }, (database) =>
            createRun({
              actor,
              orgId,
              slug,
              skillVersionId: fields.skill_version_id,
              dependencyPins: fields.dependency_pins,
              prompt: fields.prompt,
              model: fields.model,
              inputs: fields.inputs,
              modelProviderConnectionId: fields.model_provider_connection_id,
              modelProviderCredentialVersion: fields.model_provider_credential_version,
              // Disabling prewarming is an immediate rollback boundary for every uncommitted run.
              // Existing tickets may still be canceled/cleaned, but cannot be newly adopted.
              prewarmId: runPrewarmEnabled() ? fields.prewarm_id : undefined,
              runConfigId: fields.run_config_id,
              idempotencyKey: requestKey,
              attachments,
              ctx,
              database,
            }),
          ),
        );
        return c.json(detail, 201);
      } catch (e) {
        // Never delete synchronously after an ambiguous or failed transaction: a concurrent retry
        // can be committing the same deterministic object key but remain invisible to this request.
        // Unreferenced objects are intentionally retained for a delayed orphan sweep.
        throw e;
      }
    } catch (error) {
      return runError(c, error);
    }
  },
);

app.get("/v1/skills/:slug/runs", async (c) => {
  try {
    assertRunSession(c);
    const runs = await withTenant(c, ({ actor, orgId, database }) =>
      listRuns({ actor, orgId, slug: c.req.param("slug"), database }),
    );
    return c.json({ runs });
  } catch (error) {
    return runError(c, error);
  }
});

app.get("/v1/runs/:id", async (c) => {
  try {
    assertRunSession(c);
    const detail = await withTenant(c, ({ actor, orgId, database }) =>
      getRun({ actor, orgId, runId: c.req.param("id"), database }),
    );
    return c.json(detail);
  } catch (error) {
    return runError(c, error);
  }
});

app.post(
  "/v1/runs/:id/prompt",
  async (c, next) => {
    try {
      assertRunSession(c);
    } catch (error) {
      return runError(c, error);
    }
    await next();
  },
  bodyLimit({ maxSize: 64 * 1024 * 1024, onError: (c) => jsonError(c, "run upload exceeds the 64 MB limit", 413) }),
  async (c) => {
    try {
      const actor = actorFromContext(c);
      const orgId = await orgIdFromContext(c);
      const runId = c.req.param("id");
      const requestKey = idempotencyKey(c);
      const multipart = c.req.header("content-type")?.toLowerCase().startsWith("multipart/form-data") ?? false;
      let text = "";
      let files: unknown[] = [];
      if (multipart) {
        const form = await c.req.formData();
        const fields = runPromptFieldsSchema.parse({
          text: typeof form.get("text") === "string" ? form.get("text") : "",
        });
        text = fields.text;
        files = form.getAll("file");
      } else {
        text = runPromptInputSchema.parse(await c.req.json()).text;
      }
      const fileCount = files.filter(isRunUploadFile).length;
      if (fileCount > RUN_ATTACHMENT_MAX_FILES) {
        throw new RunValidationError(`a message can have at most ${RUN_ATTACHMENT_MAX_FILES} attachments`, "too_many_attachments");
      }
      for (const file of files) {
        if (!isRunUploadFile(file)) continue;
        if (file.size === 0) throw new RunValidationError("an attached file is empty", "empty_attachment");
        if (file.size > RUN_ATTACHMENT_MAX_BYTES) {
          throw new RunValidationError("each attachment must be 10 MB or smaller", "attachment_too_large");
        }
      }

      const attachments: Array<{
        id: string;
        fileName: string;
        contentType: string;
        previewContentType: string | null;
        previewKind: RunFilePreviewKind | null;
        byteSize: number;
        storageKey: string;
      }> = [];
      try {
        const reactivationAvailable = await withApiRunContext((ctx) =>
          withTenantContext({ orgId, userId: actor.id }, async (database) => {
            const readiness = ctx.runtimeAvailable
              ? await ctx.resolveRuntimeReadiness?.(database)
              : { available: false, message: ctx.runtimeMessage };
            return readiness?.available ?? ctx.runtimeAvailable;
          }),
        );
        const attachmentBodies: Array<{ key: string; body: Buffer; contentType: string }> = [];
        for (const file of files) {
          if (!isRunUploadFile(file)) continue;
          const buf = Buffer.from(await file.arrayBuffer());
          const contentType = file.type || "application/octet-stream";
          const attachmentId = deterministicRunAttachmentId({
            orgId,
            actorId: actor.id,
            idempotencyKey: `${runId}:${requestKey}`,
            index: attachments.length,
            fileName: file.name,
            contentType,
            bytes: buf,
          });
          const key = runAttachmentKey({ orgId, attachmentId });
          attachmentBodies.push({ key, body: buf, contentType });
          const detected = detectRunFileType(file.name, buf);
          attachments.push({
            id: attachmentId,
            fileName: sanitizeAttachmentName(file.name || `attachment-${attachments.length + 1}`),
            contentType,
            previewContentType: detected.previewContentType,
            previewKind: detected.previewKind,
            byteSize: buf.length,
            storageKey: key,
          });
        }
        if (attachments.length > 0) {
          await withTenantContext({ orgId, userId: actor.id }, (database) =>
            preflightRunPromptUpload({
              actor,
              orgId,
              runId,
              text,
              attachments,
              idempotencyKey: requestKey,
              reactivationAvailable,
              database,
            }),
          );
          await withTenantContext({ orgId, userId: actor.id }, (database) =>
            reserveRunAttachmentUploads({
              actor,
              orgId,
              storageKeys: attachments.map((attachment) => attachment.storageKey),
              database,
            }),
          );
        }
        for (const attachment of attachmentBodies) await putRunAttachmentOnce(attachment);
        const prompt = await withTenantContext({ orgId, userId: actor.id }, (database) =>
          enqueueRunPrompt({
            actor,
            orgId,
            runId,
            text,
            attachments,
            idempotencyKey: requestKey,
            reactivationAvailable,
            database,
          }),
        );
        return c.json({
          accepted: true as const,
          prompt_id: prompt.id,
          message_id: prompt.messageId,
          ordinal: prompt.ordinal,
          status: prompt.status,
          attachments: prompt.attachments,
          reactivated: prompt.reactivated,
        }, 202);
      } catch (error) {
        // See the launch path above: deterministic keys make immediate cleanup race with a
        // concurrent retry. Retain unreferenced bytes until a delayed orphan sweep can prove age.
        throw error;
      }
    } catch (error) {
      return runError(c, error);
    }
  },
);

app.post("/v1/runs/:id/cancel", async (c) => {
  try {
    assertRunSession(c);
    const run = await withTenant(c, ({ actor, orgId, database }) =>
      requestRunCancellation({ actor, orgId, runId: c.req.param("id"), database }),
    );
    return c.json(run, 202);
  } catch (error) {
    return runError(c, error);
  }
});

/** Cancel a queued follow-up or request a turn-level stop without ending the run session. */
app.post("/v1/runs/:id/prompts/:promptId/cancel", async (c) => {
  try {
    assertRunSession(c);
    const prompt = await withTenant(c, ({ actor, orgId, database }) =>
      requestRunPromptCancellation({
        actor,
        orgId,
        runId: c.req.param("id"),
        promptId: c.req.param("promptId"),
        database,
      }),
    );
    return c.json(prompt, 202);
  } catch (error) {
    return runError(c, error);
  }
});

/** Replay durable redacted events, then follow PostgreSQL cursor notifications without a race. */
app.get("/v1/runs/:id/events", async (c) => {
  try {
    assertRunSession(c);
    const runId = c.req.param("id");
    const actor = actorFromContext(c);
    const orgId = await orgIdFromContext(c);
    // Fail before opening a stream, with the same creator-only not-found behavior as GET /runs/:id.
    await withTenantContext({ orgId, userId: actor.id }, (database) =>
      getRun({ actor, orgId, runId, database }),
    );
    let cursor = parseLastEventId(c.req.header("Last-Event-ID") ?? c.req.query("last_event_id"));
    const encoder = new TextEncoder();
    let closed = false;
    let unsubscribe: () => void = () => undefined;
    let wake: (() => void) | null = null;
    let notified = false;
    let readySent = false;
    let terminalObserved = false;
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (payload: string) => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(payload));
          } catch {
            closed = true;
          }
        };
        const waitForWake = () =>
          new Promise<void>((resolve) => {
            let settled = false;
            const finish = () => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              resolve();
            };
            const timer = setTimeout(finish, 15_000);
            timer.unref();
            wake = finish;
            // Close the tiny gap between deciding to wait and installing this resolver. LISTEN was
            // established before replay, so the flag is the durable cursor wake-up barrier.
            if (notified) finish();
          });
        unsubscribe = await subscribeRunEventCursor(runId, (sequence) => {
          if (sequence <= cursor) return;
          notified = true;
          wake?.();
        });
        if (c.req.raw.signal.aborted) {
          closed = true;
          unsubscribe();
          controller.close();
          return;
        }
        c.req.raw.signal.addEventListener("abort", () => {
          closed = true;
          wake?.();
        }, { once: true });

        try {
          while (!closed) {
            notified = false;
            const events = await withTenantContext({ orgId, userId: actor.id }, (database) =>
              listRunEvents({ actor, orgId, runId, afterSequence: cursor, limit: 500, database }),
            );
            for (const envelope of events) {
              if (envelope.sequence <= cursor) continue;
              cursor = envelope.sequence;
              send(runEventFrame(envelope));
            }
            if (events.length >= 500 || notified) continue;
            const run = await withTenantContext({ orgId, userId: actor.id }, (database) =>
              getRun({ actor, orgId, runId, database }),
            );
            const terminal = ["frozen", "interrupted", "error", "canceled"].includes(run.status);
            const action = runDrainAction({
              eventCount: events.length,
              pageSize: 500,
              notified,
              terminal,
              terminalObserved,
              readySent,
            });
            terminalObserved = terminal;
            if (action === "continue") continue;
            // `runDrainAction` requires a second durable replay after observing terminal state, so
            // a terminal event is not lost when its NOTIFY callback arrives behind the DB commit.
            if (action === "close") break;
            if (action === "ready") {
              send(runReadyFrame());
              readySent = true;
            }
            send(": keepalive\n\n");
            await waitForWake();
            wake = null;
          }
        } catch {
          // Network/database failures close the response; EventSource reconnects with Last-Event-ID.
        } finally {
          closed = true;
          unsubscribe();
          try { controller.close(); } catch { /* already closed */ }
        }
      },
      async cancel() {
        closed = true;
        wake?.();
        unsubscribe();
      },
    });
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache, no-transform",
        "x-accel-buffering": "no",
        connection: "keep-alive",
      },
    });
  } catch (error) {
    return runError(c, error);
  }
});

const RUN_INLINE_MEDIA_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "video/mp4",
  "video/webm",
  "application/pdf",
  "application/json",
  "text/plain",
  "text/markdown",
  "text/csv",
]);

interface RunDownloadAsset {
  fileName: string;
  contentType: string;
  storageKey: string;
  previewContentType: string | null;
  byteSize?: number;
  /** Present for replaceable artifacts; attachments are immutable after their row commits. */
  generation?: string;
}

function sameRunDownloadGeneration(left: RunDownloadAsset, right: RunDownloadAsset): boolean {
  return left.fileName === right.fileName
    && left.contentType === right.contentType
    && left.storageKey === right.storageKey
    && left.previewContentType === right.previewContentType
    && left.byteSize === right.byteSize
    && left.generation === right.generation;
}

function safeRunAssetContentType(asset: RunDownloadAsset): string {
  if (asset.previewContentType && RUN_INLINE_MEDIA_TYPES.has(asset.previewContentType)) {
    return asset.previewContentType;
  }
  // Non-preview files are always attachments. Preserve a conventional stored MIME for download
  // clients, but reject control characters and exotic parameters from legacy/user-provided rows.
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*(?:;\s*charset=[a-z0-9._-]+)?$/i.test(asset.contentType)
    ? asset.contentType
    : "application/octet-stream";
}

function runDownloadHeaders(input: {
  asset: RunDownloadAsset;
  disposition: "inline" | "attachment";
  etag?: string;
  length?: number;
  contentRange?: string;
}): Headers {
  const fileName = input.asset.fileName.replace(/[^\w. -]/g, "_");
  const headers = new Headers({
    "Content-Type": safeRunAssetContentType(input.asset),
    "Content-Disposition": `${input.disposition}; filename="${fileName}"`,
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Content-Security-Policy": "default-src 'none'; sandbox",
    "Accept-Ranges": "bytes",
  });
  if (input.etag) headers.set("ETag", input.etag);
  if (input.length !== undefined) headers.set("Content-Length", String(input.length));
  if (input.contentRange) headers.set("Content-Range", input.contentRange);
  return headers;
}

/**
 * If-Range only permits a partial response when its strong entity-tag matches the selected
 * representation. Run assets do not expose a Last-Modified validator, so dates, weak tags and
 * malformed validators deliberately fall back to a complete 200 response.
 */
function ifRangeMatchesStrongETag(ifRange: string, currentETag: string): boolean {
  const validator = ifRange.trim();
  const etag = currentETag.trim();
  return validator === etag
    && validator.startsWith('"')
    && validator.endsWith('"')
    && !validator.startsWith("W/")
    && !etag.startsWith("W/");
}

async function streamRunDownload(
  c: Context,
  initialAsset: RunDownloadAsset,
  reloadAsset?: () => Promise<RunDownloadAsset>,
): Promise<Response> {
  const download = c.req.query("download") === "1";
  const rangeHeader = c.req.header("range");
  const ifRangeHeader = c.req.header("if-range");
  let asset = initialAsset;

  // A ranged video read needs the total length. Pin the subsequent GET to this HEAD's ETag so a
  // worker replacing an artifact at the same stable key cannot splice two object generations.
  // Replaceable artifacts also re-read their creator-scoped metadata after HEAD: ready=false or a
  // changed generation restarts the fence before any bytes are exposed.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt > 0 && reloadAsset) asset = await reloadAsset();
    const inline = !download
      && asset.previewContentType !== null
      && RUN_INLINE_MEDIA_TYPES.has(asset.previewContentType);
    const head = await headSkillArchive({ key: asset.storageKey, signal: c.req.raw.signal });
    if (!head || head.contentLength === undefined) throw new Error("run asset not found");
    if (asset.byteSize !== undefined && head.contentLength !== asset.byteSize) {
      if (reloadAsset && attempt < 2) continue;
      throw new Error("run asset generation does not match its metadata");
    }
    if (reloadAsset) {
      const confirmed = await reloadAsset();
      if (!sameRunDownloadGeneration(asset, confirmed)) {
        asset = confirmed;
        if (attempt < 2) continue;
        throw new Error("run asset metadata changed while opening it");
      }
    }
    let range: ReturnType<typeof resolveSkillArchiveByteRange> | null = null;
    // RFC 9110 evaluates If-Range before applying Range. A stale/weak/unsupported validator makes
    // the request an unconditional full representation, even when the Range field itself is
    // malformed. Only parse and potentially reject Range when its validator permits a partial.
    if (rangeHeader && (ifRangeHeader === undefined || ifRangeMatchesStrongETag(ifRangeHeader, head.etag))) {
      try {
        range = resolveSkillArchiveByteRange(rangeHeader, head.contentLength);
      } catch (error) {
        if (!(error instanceof InvalidSkillArchiveRangeError)) throw error;
        return new Response(null, {
          status: 416,
          headers: runDownloadHeaders({
            asset,
            disposition: inline ? "inline" : "attachment",
            etag: head.etag,
            contentRange: `bytes */${head.contentLength}`,
          }),
        });
      }
    }

    try {
      const object = await streamSkillArchive({
        key: asset.storageKey,
        range: range?.header,
        ifMatch: head.etag,
        signal: c.req.raw.signal,
      });
      const expectedContentRange = range
        ? `bytes ${range.start}-${range.end}/${head.contentLength}`
        : null;
      const invalidObjectGeneration = (object.etag !== null && object.etag !== head.etag)
        || (range !== null && object.contentLength !== range.length)
        || (range !== null && object.contentRange !== expectedContentRange)
        || (range === null && object.contentLength !== null && object.contentLength !== head.contentLength);
      if (invalidObjectGeneration) {
        await object.body.cancel().catch(() => undefined);
        throw new Error("object storage returned an inconsistent run asset generation");
      }
      const length = range?.length ?? object.contentLength ?? head.contentLength;
      return new Response(object.body, {
        status: range ? 206 : 200,
        headers: runDownloadHeaders({
          asset,
          disposition: inline ? "inline" : "attachment",
          etag: object.etag ?? head.etag,
          length,
          contentRange: expectedContentRange ?? undefined,
        }),
      });
    } catch (error) {
      if (attempt < 2 && isStoragePreconditionFailure(error)) continue;
      throw error;
    }
  }
  throw new Error("run asset changed while opening it");
}

/** Stream a run attachment back to its creator. */
app.get("/v1/runs/:id/attachments/:attachmentId", async (c) => {
  try {
    assertRunSession(c);
    const asset = await withTenant(c, ({ actor, orgId, database }) =>
      getRunAttachment({
        actor,
        orgId,
        runId: c.req.param("id"),
        attachmentId: c.req.param("attachmentId"),
        database,
      }),
    );
    return await streamRunDownload(c, {
      ...asset,
      previewContentType: asset.previewContentType,
    });
  } catch (error) {
    if (
      error instanceof InternalProductAccessRequiredError
      || error instanceof RunSessionOnlyError
      || (error instanceof Error && error.message === "not authenticated")
    ) {
      return runError(c, error);
    }
    // Not-visible run / unknown attachment / cross-tenant all surface as a 404.
    return jsonError(c, error, 404);
  }
});

/** Serve creator-private cached outputs without exposing S3 or the retained sandbox. */
app.get("/v1/runs/:id/artifacts/:artifactId", async (c) => {
  try {
    assertRunSession(c);
    const loadAsset = async (): Promise<RunDownloadAsset> => {
      const asset = await withTenant(c, ({ actor, orgId, database }) =>
        getRunArtifact({
          actor,
          orgId,
          runId: c.req.param("id"),
          artifactId: c.req.param("artifactId"),
          database,
        }),
      );
      return {
        ...asset,
        previewContentType: asset.previewable ? asset.contentType : null,
      };
    };
    const asset = await loadAsset();
    return await streamRunDownload(c, asset, loadAsset);
  } catch (error) {
    if (
      error instanceof InternalProductAccessRequiredError
      || error instanceof RunSessionOnlyError
      || (error instanceof Error && error.message === "not authenticated")
    ) {
      return runError(c, error);
    }
    // Expired, missing and unauthorized artifacts are intentionally indistinguishable.
    return jsonError(c, error, 404);
  }
});

/** Keep attachment names path-safe inside the sandbox (written under attachments/<name>). */
function sanitizeAttachmentName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() || "attachment";
  const clean = base.replace(/[^\w. ()\[\]-]/g, "_").slice(0, 120);
  return clean.startsWith(".") ? `_${clean}` : clean || "attachment";
}

const port = Number(process.env.COMPANION_API_PORT ?? process.env.PORT ?? 3001);
const hostname = process.env.COMPANION_API_HOST;
assertBillingEnvironmentConfigured();
serve({ fetch: app.fetch, port, ...(hostname ? { hostname } : {}) }, (info) => {
  console.log(`Companion API listening on ${hostname ? `http://${hostname}:${info.port}` : `port ${info.port}`}`);
});
