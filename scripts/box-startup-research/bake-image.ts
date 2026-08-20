import {
  AsciiBoxCompanionRuntime,
  AsciiBoxMaintenanceClient,
  createCompanionRuntimeImageBaker,
} from "../../packages/box-runtime/src/index";
import { loadBundledCompanionRuntimeSkill } from "../../apps/runtime/src/materialPipeline";

const SHA_PATTERN = /^[a-f0-9]{40}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SNAPSHOT_PATTERN = /^companion-l14-[a-f0-9]{12}$/;

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

async function main(): Promise<void> {
  const treeSha = required("BOX_STARTUP_RESEARCH_TREE_SHA");
  const bakerCompanionId = required("BOX_STARTUP_RESEARCH_BAKER_COMPANION_ID");
  const snapshotName = required("BOX_STARTUP_RESEARCH_SNAPSHOT_NAME");
  if (!SHA_PATTERN.test(treeSha)) throw new Error("invalid research tree sha");
  if (!UUID_PATTERN.test(bakerCompanionId)) throw new Error("invalid research baker identity");
  if (!SNAPSHOT_PATTERN.test(snapshotName)) throw new Error("invalid research snapshot name");
  const apiKey = process.env.BOX_API_KEY?.trim() || process.env.COMPANION_BOX_API_KEY?.trim();
  if (!apiKey) throw new Error("missing Box research credential");
  const env = { ...process.env, COMPANION_BOX_API_KEY: apiKey };
  const bundledSkill = await loadBundledCompanionRuntimeSkill();
  const timings: Array<{ operation: string; duration_ms: number; ok: boolean }> = [];
  const runtime = () => new AsciiBoxCompanionRuntime(env, {
    companionSkillChecksum: bundledSkill.checksum,
    imageIdentitySalt: treeSha,
    onTiming: (sample) => timings.push({
      operation: sample.operation,
      duration_ms: sample.durationMs,
      ok: sample.ok,
    }),
  });
  const lifecycle = new AsciiBoxMaintenanceClient(env, {
    onTiming: (sample) => timings.push({
      operation: sample.operation,
      duration_ms: sample.durationMs,
      ok: sample.ok,
    }),
  });
  const bakerLifecycle = new Proxy(lifecycle, {
    get(target, property) {
      if (property === "createEphemeralBox") {
        return async (input: Parameters<typeof target.createEphemeralBox>[0]) => {
          const created = await target.createEphemeralBox(input);
          try {
            await target.applyGenerationBoxSettings({
              boxId: created.boxId,
              companionId: bakerCompanionId,
              generation: 1,
              ttlSeconds: input.ttlSeconds,
              deadlineAt: Date.now() + 30_000,
              ...(input.signal ? { signal: input.signal } : {}),
            });
          } catch (error) {
            await target.deletePermanentlyAndWait({
              boxId: created.boxId,
              deadlineAt: Date.now() + 120_000,
            }).catch(() => undefined);
            throw error;
          }
          return created;
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const cleanupErrors: string[] = [];
  const controller = new AbortController();
  const abort = () => controller.abort(new Error("research image bake interrupted"));
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  const timeout = AbortSignal.timeout(15 * 60_000);
  const signal = AbortSignal.any([controller.signal, timeout]);
  const startedAt = Date.now();
  try {
    const firstRuntime = runtime();
    const baker = createCompanionRuntimeImageBaker({
      identity: { ...firstRuntime.layoutIdentity(), imageName: snapshotName },
      lifecycle: bakerLifecycle,
      runtime: {
        existingBoxStatus: (input) => runtime().existingBoxStatus(input),
        refreshPiLayout: (input) => runtime().refreshPiLayout(input),
        refreshTtl: (input) => runtime().refreshTtl(input),
        prepareRuntimeImage: (input) => runtime().prepareRuntimeImage(input),
      },
      bundledSkill,
      onAttemptError: () => undefined,
      onCleanupError: (_error, cleanup) => cleanupErrors.push(cleanup),
    });
    const baked = await baker.ensure(signal);
    if (!baked.ready || cleanupErrors.length > 0) {
      throw new Error(cleanupErrors.length > 0 ? "research image cleanup failed" : "research image failed");
    }
    const snapshot = await lifecycle.getNamedSnapshot({
      name: baked.name,
      signal,
      deadlineAt: Date.now() + 30_000,
    });
    if (!snapshot || snapshot.status !== "ready") {
      throw new Error("research image disappeared after bake");
    }
    process.stdout.write(`${JSON.stringify({
      phase: "research_image",
      status: "succeeded",
      image: baked.name,
      tree_sha: treeSha,
      baked: baked.baked,
      duration_ms: Date.now() - startedAt,
      provider_call_count: timings.length,
      ...(snapshot.sizeBytes === undefined ? {} : { snapshot_size_bytes: snapshot.sizeBytes }),
    })}\n`);
  } finally {
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
  }
}

void main().catch(() => {
  process.stdout.write(`${JSON.stringify({
    phase: "research_image",
    status: "failed",
    code: "research_image_failed",
  })}\n`);
  process.exitCode = 1;
});
