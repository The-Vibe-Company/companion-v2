import {
  bumpCompanionSkillsRevisionForSkill,
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
  getCompanionSkillPackage,
  type CompanionBoxRuntime,
} from "@companion/box-runtime";

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
  // Every selector — Online or asleep — now needs a restage; the desired-revision bump is what
  // makes the settings UI read "pending" until the package actually lands (on this push for Online
  // Boxes, on the next wake for asleep ones). If the bump itself fails, stop: the publish already
  // committed, and pushing unbumped packages would record nothing either way.
  const targets = await withTenantContext(
    { orgId: input.orgId, userId: input.actor.id },
    async (database) => {
      await bumpCompanionSkillsRevisionForSkill({
        orgId: input.orgId,
        skillId: input.skillId,
        database,
      });
      return listOnlineCompanionsForSkillSync({
        orgId: input.orgId,
        skillId: input.skillId,
        database,
      });
    },
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
        // Captured before staging: a selection change that lands mid-push bumps desired past this
        // value, so the monotonic applied write below leaves the Companion honestly pending.
        const stagedSkillsRevision = companion.runtime.skills_revision;
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
        if (
          (observed.runtimeState === "stopping" || observed.runtimeState === "stopped")
          && observed.daemonState === "stopped"
        ) {
          // Skill publish is apply-only and may not wake a Box. If archival wins the observation
          // race, settle the start claim into the explicit-wake marker instead of leaving the
          // Companion durably provisioning until the stale-claim timeout.
          await updateCompanionRuntime({
            actor: input.actor,
            orgId: input.orgId,
            companionId: target.id,
            patch: {
              boxId: observed.boxId,
              runtimeState: observed.runtimeState,
              daemonState: "stopped",
              desktopAvailable: observed.desktopAvailable,
              observedAt: new Date(),
            },
            database,
          });
          return;
        }
        // This push always recycles Pi (`restartPi: true`), so a real runtime cannot answer warm —
        // but only a start that actually staged may claim the revision as applied.
        if (observed.runtimeState !== "running" || observed.daemonState !== "running") return;
        if (observed.staged === false) return;
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
            skillsAppliedRevision: stagedSkillsRevision,
            skillsLastError: null,
          },
          database,
        });
      });
    } catch (error) {
      // Best-effort: a failed Box sync must not fail the Skills Hub publish that already committed.
      // But it must leave a trace — without it, "not yet effective" and "permanently broken" read
      // identically forever. Never touches runtime_state; applied < desired keeps the row pending.
      await withTenantContext({ orgId: input.orgId, userId: input.actor.id }, (database) =>
        updateCompanionRuntime({
          actor: input.actor,
          orgId: input.orgId,
          companionId: target.id,
          patch: {
            skillsLastError: error instanceof Error && error.message
              ? error.message
              : "Skill sync to the Box failed.",
          },
          database,
        }),
      ).catch(() => undefined);
    }
  }
}
