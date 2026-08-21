import assert from "node:assert/strict";
import test from "node:test";

import { assertNoCredentialMaterial, validateCandidateDiff } from "./policy.mjs";

const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);

function fakeGit(outputs) {
  return async (args) => {
    const key = args.slice(0, 2).join(" ");
    return outputs[key] ?? "";
  };
}

test("accepts a single runtime-only candidate commit", async () => {
  const result = await validateCandidateDiff({
    baseSha: BASE,
    commitSha: HEAD,
    git: fakeGit({
      "rev-list --count": "1\n",
      "merge-base aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa": `${BASE}\n`,
      "diff --name-status": "M\tpackages/box-runtime/src/boxCompanionRuntime.ts\n",
      "diff --no-ext-diff": "+const faster = true;\n",
    }),
    env: {},
  });
  assert.deepEqual(result.changed, ["packages/box-runtime/src/boxCompanionRuntime.ts"]);
});

test("rejects tests, evaluator changes and configured credential values", async () => {
  const common = {
    baseSha: BASE,
    commitSha: HEAD,
    git: fakeGit({
      "rev-list --count": "1\n",
      "merge-base aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa": `${BASE}\n`,
      "diff --name-status": "M\tpackages/box-runtime/src/runtime.test.ts\n",
      "diff --no-ext-diff": "+safe\n",
    }),
    env: {},
  };
  await assert.rejects(validateCandidateDiff(common), /protected path/);

  await assert.rejects(validateCandidateDiff({
    ...common,
    git: fakeGit({
      "rev-list --count": "1\n",
      "merge-base aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa": `${BASE}\n`,
      "diff --name-status": "M\tpackages/box-runtime/src/companionPiBrokerSource.ts\n",
      "diff --no-ext-diff": "+const forged = true;\n",
    }),
  }), /attestation code/);

  await assert.rejects(validateCandidateDiff({
    ...common,
    git: fakeGit({
      "rev-list --count": "1\n",
      "merge-base aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa": `${BASE}\n`,
      "diff --name-status": "M\tpackages/box-runtime/src/runtime.ts\n",
      "diff --no-ext-diff": "+const value = 'sensitive-value';\n",
    }),
    env: { BOX_API_KEY: "sensitive-value" },
  }), /credential value/);
});

test("rejects credentials in structured agent output", () => {
  assert.throws(() => assertNoCredentialMaterial(
    { summary: "accidentally included sensitive-value" },
    { ZAI_API_KEY: "sensitive-value" },
  ), /credential material/);
});
