import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import test from "node:test";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

async function runCleanupScenario(mode) {
  const source = `
    import { BoxRuntimeProviderError } from "../../packages/box-runtime/src/index";
    import { cleanupResearchResources } from "../../scripts/box-startup-research/cleanup.ts";
    void (async () => {
    const deleted: string[] = [];
    const result = await cleanupResearchResources({
      lifecycle: {
        findGenerationBoxes: async () => ({
          name: "ignored",
          canonical: { id: "bx_23456789" },
          duplicates: [{ id: "bx_abcdefgh" }],
        }),
        deletePermanentlyAndWait: async ({ boxId }) => { deleted.push(boxId); },
        getNamedSnapshot: async () => null,
        deleteNamedSnapshot: async () => undefined,
      },
      runtime: {
        clearPersistedProviderAuth: async () => undefined,
        existingBoxStatus: async ({ boxId }) => {
          if (${JSON.stringify(mode)} === "not-found") throw new BoxRuntimeProviderError("gone", 404);
          return { boxId, state: "ready" };
        },
      },
      companionIds: ["11111111-1111-4111-a111-111111111111"],
      snapshotNames: [],
    });
    console.log(JSON.stringify({ result, deleted }));
    })();
  `;
  const { stdout } = await execFile("pnpm", [
    "--filter", "@companion/runtime", "exec", "tsx", "--eval", source,
  ], { cwd: process.cwd(), maxBuffer: 1024 * 1024 });
  return JSON.parse(stdout.trim().split(/\r?\n/).at(-1));
}

test("cleanup expands canonical discovery plus duplicates and requires a provider 404", async () => {
  const removed = await runCleanupScenario("not-found");
  assert.deepEqual(removed.deleted, ["bx_23456789", "bx_abcdefgh"]);
  assert.equal(removed.result.complete, true);
  assert.deepEqual(removed.result.boxes.map((box) => box.deleted), [true, true]);

  const stillVisible = await runCleanupScenario("visible");
  assert.equal(stillVisible.result.complete, false);
  assert.deepEqual(stillVisible.result.boxes.map((box) => box.deleted), [false, false]);
});
