import assert from "node:assert/strict";
import test from "node:test";

import { retryTrackedBakerBoxCleanup } from "./baker-cleanup.mjs";
import { evaluatorFiles } from "./evaluator-integrity.mjs";

test("retries cleanup for every exact baker Box and proves completion", async () => {
  const calls = [];
  const signal = new AbortController().signal;
  const complete = await retryTrackedBakerBoxCleanup({
    boxIds: ["bx_23456789", "bx_abcdefgh"],
    lifecycle: {
      deletePermanentlyAndWait: async (input) => {
        calls.push(input);
        return { outcome: "deleted", operation: {} };
      },
    },
    signal,
    now: () => 1_000,
  });

  assert.equal(complete, true);
  assert.deepEqual(calls, [
    { boxId: "bx_23456789", deadlineAt: 121_000, signal },
    { boxId: "bx_abcdefgh", deadlineAt: 121_000, signal },
  ]);
});

test("fails closed after retrying all tracked baker Boxes", async () => {
  const calls = [];
  const complete = await retryTrackedBakerBoxCleanup({
    boxIds: ["bx_23456789", "bx_abcdefgh"],
    lifecycle: {
      deletePermanentlyAndWait: async ({ boxId }) => {
        calls.push(boxId);
        if (boxId === "bx_23456789") throw new Error("still present");
        return { outcome: "already_deleted", boxId };
      },
    },
    signal: new AbortController().signal,
    now: () => 1_000,
  });

  assert.equal(complete, false);
  assert.deepEqual(calls, ["bx_23456789", "bx_abcdefgh"]);
});

test("treats a blocked deletion result as incomplete cleanup", async () => {
  const complete = await retryTrackedBakerBoxCleanup({
    boxIds: ["bx_23456789"],
    lifecycle: {
      deletePermanentlyAndWait: async () => ({ outcome: "blocked", operation: {} }),
    },
    signal: new AbortController().signal,
    now: () => 1_000,
  });

  assert.equal(complete, false);
});

test("keeps the cleanup decision helper inside evaluator integrity", () => {
  assert.equal(evaluatorFiles().includes(
    "scripts/box-startup-research/baker-cleanup.mjs",
  ), true);
});
