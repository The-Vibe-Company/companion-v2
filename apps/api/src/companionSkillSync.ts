import {
  claimCompanionRuntimeStart,
  listCompanionRuntimeSkillPackages,
  listOnlineCompanionsForSkillSync,
  resolveCompanionPluginInjection,
  resolveCompanionProviderAuth,
  updateCompanionRuntime,
} from "@companion/core";
import type { ActorContext } from "@companion/core/services";
import { COMPANION_SKILL_KEY, companionSkillDir } from "@companion/companion-skill";
import { withTenantContext } from "@companion/db";
import { packDir, skillChecksum, toTar } from "@companion/skills";
import { getSkillArchive } from "@companion/storage";
import {
  AsciiBoxCompanionRuntime,
  COMPANION_PI_DISK_LAYOUT_VERSION,
  type CompanionBoxRuntime,
} from "./boxCompanionRuntime";
import { getCompanionSkillPackage } from "./companionSkillPackage";

/**
 * After a Skills Hub publish/update, push the new package onto every Online Box that has that skill
 * selected. Recycles Pi only — never recreates the Box. Asleep Companions pick it up on next wake.
 */
export async function syncPublishedSkillToOnlineCompanions(input: {
  orgId: string;
  skillId: string;
  actor: ActorContext;
  env?: NodeJS.ProcessEnv;
  runtimeFactory?: () => CompanionBoxRuntime;
}): Promise<void> {
  const env = input.env ?? process.env;
  const targets = await withTenantContext(
    { orgId: input.orgId, userId: input.actor.id },
    (database) => listOnlineCompanionsForSkillSync({
      orgId: input.orgId,
      skillId: input.skillId,
      database,
    }),
  );
  if (!targets.length) return;

  const runtimeFactory = input.runtimeFactory ?? (() => new AsciiBoxCompanionRuntime(env));
  const apiUrl = (env.COMPANION_API_URL ?? "http://127.0.0.1:3001").replace(/\/+$/, "");

  for (const target of targets) {
    try {
      await withTenantContext({ orgId: input.orgId, userId: input.actor.id }, async (database) => {
        const provider = await resolveCompanionProviderAuth({
          actor: input.actor,
          orgId: input.orgId,
          companionId: target.id,
          database,
        });
        const plugins = await resolveCompanionPluginInjection({
          actor: input.actor,
          orgId: input.orgId,
          companionId: target.id,
          database,
        });
        const companion = await claimCompanionRuntimeStart({
          actor: input.actor,
          orgId: input.orgId,
          companionId: target.id,
          database,
        });
        if (!companion.model_id || !companion.runtime.box_id) return;
        const skillPackages = await listCompanionRuntimeSkillPackages({
          actor: input.actor,
          orgId: input.orgId,
          companionId: target.id,
          database,
        });
        const librarySkills = await Promise.all(skillPackages.map(async (skill) => {
          const archive = await getSkillArchive({ key: skill.storagePath });
          if (skillChecksum(toTar(archive)) !== skill.checksum) {
            throw new Error(`stored skill package no longer matches ${skill.slug}@${skill.version}`);
          }
          return {
            slug: skill.slug,
            version: skill.version,
            checksum: skill.checksum,
            archive,
          };
        }));
        const bundled = await getCompanionSkillPackage();
        const packed = await packDir(companionSkillDir());
        const skills = [
          {
            slug: COMPANION_SKILL_KEY,
            version: bundled.version,
            checksum: packed.checksum,
            archive: packed.archive,
          },
          ...librarySkills.filter((skill) => skill.slug !== COMPANION_SKILL_KEY),
        ];
        const hubEnv: Record<string, string> = {
          COMPANION_API_URL: apiUrl,
          COMPANION_WORKSPACE_ID: input.orgId,
        };
        const runtime = runtimeFactory();
        const observed = await runtime.start({
          companionId: target.id,
          orgId: input.orgId,
          boxId: companion.runtime.box_id,
          clientSurface: "web",
          providerAuth: { [provider.providerId]: provider.authEntry },
          modelId: companion.model_id,
          instructions: companion.persona,
          replaceProviderAuth: companion.runtime.provider_credential_generation
            !== provider.credentialGeneration,
          restartPi: true,
          refreshRuntimeLayout:
            companion.runtime.disk_layout_version !== COMPANION_PI_DISK_LAYOUT_VERSION,
          allowBoxWake: false,
          mcpCredentials: plugins.credentials,
          mcpAccounts: plugins.accounts,
          skills,
          hubEnv,
          onBoxAssigned: async () => undefined,
        });
        if (observed.runtimeState !== "running" || observed.daemonState !== "running") return;
        await updateCompanionRuntime({
          actor: input.actor,
          orgId: input.orgId,
          companionId: target.id,
          patch: {
            boxId: observed.boxId,
            runtimeState: observed.runtimeState,
            daemonState: observed.daemonState,
            desktopAvailable: observed.desktopAvailable,
            diskLayoutVersion: COMPANION_PI_DISK_LAYOUT_VERSION,
            providerCredentialGeneration: provider.credentialGeneration,
          },
          database,
        });
      });
    } catch {
      // Best-effort: a failed Box sync must not fail the Skills Hub publish that already committed.
    }
  }
}
