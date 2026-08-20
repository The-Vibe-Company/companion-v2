import {
  AsciiBoxCompanionRuntime,
  AsciiBoxMaintenanceClient,
} from "../../packages/box-runtime/src/index";
import { loadBundledCompanionRuntimeSkill } from "../../apps/runtime/src/materialPipeline";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SNAPSHOT_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

function values(flag: string): string[] {
  const found: string[] = [];
  for (let index = 2; index < process.argv.length; index += 1) {
    if (process.argv[index] === flag && process.argv[index + 1]) found.push(process.argv[++index]!);
  }
  return found;
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
  const boxes: Array<{ id: string; deleted: boolean }> = [];
  const snapshots: Array<{ name: string; deleted: boolean }> = [];
  let complete = true;

  for (const companionId of companionIds) {
    const matches = await lifecycle.findGenerationBoxes({
      companionId,
      generation: 1,
      deadlineAt: Date.now() + 60_000,
    });
    for (const box of matches) {
      let deleted = false;
      try {
        await runtime.clearPersistedProviderAuth({ boxId: box.id }).catch(() => undefined);
        await lifecycle.deletePermanentlyAndWait({
          boxId: box.id,
          deadlineAt: Date.now() + 120_000,
        });
        deleted = true;
      } catch {
        complete = false;
      }
      boxes.push({ id: box.id, deleted });
    }
  }

  for (const name of snapshotNames) {
    let deleted = false;
    try {
      const snapshot = await lifecycle.getNamedSnapshot({ name, deadlineAt: Date.now() + 30_000 });
      if (snapshot) {
        await lifecycle.deleteNamedSnapshot({ name, deadlineAt: Date.now() + 30_000 });
      }
      deleted = await lifecycle.getNamedSnapshot({
        name,
        deadlineAt: Date.now() + 30_000,
      }) === null;
      if (!deleted) complete = false;
    } catch {
      complete = false;
    }
    snapshots.push({ name, deleted });
  }

  process.stdout.write(`${JSON.stringify({
    phase: "research_cleanup",
    status: complete ? "succeeded" : "failed",
    schemaVersion: 1,
    boxes,
    snapshots,
    complete,
  })}\n`);
  if (!complete) process.exitCode = 1;
}

void main().catch(() => {
  process.stdout.write(`${JSON.stringify({
    phase: "research_cleanup",
    status: "failed",
    code: "research_cleanup_failed",
  })}\n`);
  process.exitCode = 1;
});
