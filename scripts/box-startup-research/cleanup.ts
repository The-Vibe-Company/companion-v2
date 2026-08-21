import {
  AsciiBoxCompanionRuntime,
  AsciiBoxMaintenanceClient,
  BoxRuntimeProviderError,
  type BoxGenerationDiscovery,
  type BoxMaintenanceBox,
} from "../../packages/box-runtime/src/index";
import { loadBundledCompanionRuntimeSkill } from "../../apps/runtime/src/materialPipeline";
import { pathToFileURL } from "node:url";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SNAPSHOT_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

function values(flag: string): string[] {
  const found: string[] = [];
  for (let index = 2; index < process.argv.length; index += 1) {
    if (process.argv[index] === flag && process.argv[index + 1]) found.push(process.argv[++index]!);
  }
  return found;
}

export function generationBoxes(discovery: BoxGenerationDiscovery): BoxMaintenanceBox[] {
  const boxes = new Map<string, BoxMaintenanceBox>();
  if (discovery.canonical) boxes.set(discovery.canonical.id, discovery.canonical);
  for (const duplicate of discovery.duplicates) boxes.set(duplicate.id, duplicate);
  return [...boxes.values()];
}

export function isRequiredDeletedBoxStatus(error: unknown): boolean {
  return error instanceof BoxRuntimeProviderError && error.status === 404;
}

type CleanupLifecycle = Pick<
  AsciiBoxMaintenanceClient,
  "findGenerationBoxes" | "deletePermanentlyAndWait" | "getNamedSnapshot" | "deleteNamedSnapshot"
>;
type CleanupRuntime = Pick<
  AsciiBoxCompanionRuntime,
  "clearPersistedProviderAuth" | "existingBoxStatus"
>;

export async function cleanupResearchResources(input: {
  lifecycle: CleanupLifecycle;
  runtime: CleanupRuntime;
  companionIds: string[];
  snapshotNames: string[];
}): Promise<{
  boxes: Array<{ id: string; deleted: boolean }>;
  snapshots: Array<{ name: string; deleted: boolean }>;
  complete: boolean;
}> {
  const boxes: Array<{ id: string; deleted: boolean }> = [];
  const snapshots: Array<{ name: string; deleted: boolean }> = [];
  let complete = true;

  for (const companionId of input.companionIds) {
    let discovery: BoxGenerationDiscovery;
    try {
      discovery = await input.lifecycle.findGenerationBoxes({
        companionId,
        generation: 1,
        deadlineAt: Date.now() + 60_000,
      });
    } catch {
      complete = false;
      continue;
    }
    for (const box of generationBoxes(discovery)) {
      let deleted = false;
      try {
        await input.runtime.clearPersistedProviderAuth({ boxId: box.id }).catch(() => undefined);
        await input.lifecycle.deletePermanentlyAndWait({
          boxId: box.id,
          deadlineAt: Date.now() + 120_000,
        });
        try {
          await input.runtime.existingBoxStatus({ boxId: box.id });
        } catch (error) {
          deleted = isRequiredDeletedBoxStatus(error);
        }
      } catch {
        deleted = false;
      }
      if (!deleted) complete = false;
      boxes.push({ id: box.id, deleted });
    }
  }

  for (const name of input.snapshotNames) {
    let deleted = false;
    try {
      const snapshot = await input.lifecycle.getNamedSnapshot({ name, deadlineAt: Date.now() + 30_000 });
      if (snapshot) {
        await input.lifecycle.deleteNamedSnapshot({ name, deadlineAt: Date.now() + 30_000 });
      }
      deleted = await input.lifecycle.getNamedSnapshot({
        name,
        deadlineAt: Date.now() + 30_000,
      }) === null;
      if (!deleted) complete = false;
    } catch {
      complete = false;
    }
    snapshots.push({ name, deleted });
  }

  return { boxes, snapshots, complete };
}

async function main(): Promise<void> {
  const apiKey = process.env.BOX_API_KEY?.trim() || process.env.COMPANION_BOX_API_KEY?.trim();
  if (!apiKey) throw new Error("missing Box research credential");
  const companionIds = values("--companion-id");
  const snapshotNames = values("--snapshot");
  const treeShas = values("--tree-sha");
  if (companionIds.some((id) => !UUID_PATTERN.test(id))) throw new Error("invalid companion id");
  if (snapshotNames.some((name) => !SNAPSHOT_PATTERN.test(name))) throw new Error("invalid snapshot name");
  if (treeShas.some((sha) => !/^[a-f0-9]{40}$/.test(sha))) throw new Error("invalid tree sha");
  const env = { ...process.env, COMPANION_BOX_API_KEY: apiKey };
  const lifecycle = new AsciiBoxMaintenanceClient(env);
  const runtime = new AsciiBoxCompanionRuntime(env);
  if (treeShas.length > 0) {
    const bundledSkill = await loadBundledCompanionRuntimeSkill();
    for (const treeSha of treeShas) {
      const isolated = new AsciiBoxCompanionRuntime(env, {
        companionSkillChecksum: bundledSkill.checksum,
        imageIdentitySalt: treeSha,
      }).layoutIdentity().imageName;
      if (!snapshotNames.includes(isolated)) snapshotNames.push(isolated);
    }
  }
  const result = await cleanupResearchResources({
    lifecycle,
    runtime,
    companionIds,
    snapshotNames,
  });

  process.stdout.write(`${JSON.stringify({
    phase: "research_cleanup",
    status: result.complete ? "succeeded" : "failed",
    schemaVersion: 1,
    boxes: result.boxes,
    snapshots: result.snapshots,
    complete: result.complete,
  })}\n`);
  if (!result.complete) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch(() => {
    process.stdout.write(`${JSON.stringify({
      phase: "research_cleanup",
      status: "failed",
      code: "research_cleanup_failed",
    })}\n`);
    process.exitCode = 1;
  });
}
