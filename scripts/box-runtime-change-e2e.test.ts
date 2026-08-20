import assert from "node:assert/strict";
import test from "node:test";

import {
  BoxRuntimeAdapterError,
  type BoxGenerationCreateInput,
  type BoxRuntimeLifecycleClient,
} from "../packages/box-runtime/src/index";
import { createGenerationBoxWithImageFallback } from "./box-runtime-change-e2e";

const input = {
  companionId: "11111111-1111-4111-8111-111111111111",
  generation: 1,
  ttlSeconds: 300,
  deadlineAt: Date.now() + 30_000,
} satisfies Omit<BoxGenerationCreateInput, "from">;

function missingImageError(): BoxRuntimeAdapterError {
  return new BoxRuntimeAdapterError({
    stableCode: "box_not_found",
    message: "The configured Box image no longer exists",
    status: 404,
    providerCode: "box_not_found",
    retryable: false,
    outcomeUnknown: false,
  });
}

test("retries a generation Box create without a stale configured image", async () => {
  const calls: BoxGenerationCreateInput[] = [];
  const lifecycle = {
    async createOrRecoverGenerationBox(createInput: BoxGenerationCreateInput) {
      calls.push(createInput);
      if (calls.length === 1) throw missingImageError();
      return {
        outcome: "created" as const,
        boxId: "bx_23456789",
        name: "Companion 11111111-1111-4111-8111-111111111111 g1",
      };
    },
  } satisfies Pick<BoxRuntimeLifecycleClient, "createOrRecoverGenerationBox">;

  await assert.doesNotReject(
    createGenerationBoxWithImageFallback(lifecycle, input, "companion-l14-stale"),
  );
  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.from, "companion-l14-stale");
  assert.equal(calls[1]?.from, undefined);
});

test("does not retry a Box create failure unrelated to the configured image", async () => {
  const providerError = new BoxRuntimeAdapterError({
    stableCode: "box_authentication_failed",
    message: "The Box credential was rejected",
    status: 401,
    providerCode: "unauthorized",
    retryable: false,
    outcomeUnknown: false,
  });
  let attempts = 0;
  const lifecycle = {
    async createOrRecoverGenerationBox(): Promise<never> {
      attempts += 1;
      throw providerError;
    },
  } satisfies Pick<BoxRuntimeLifecycleClient, "createOrRecoverGenerationBox">;

  await assert.rejects(
    createGenerationBoxWithImageFallback(lifecycle, input, "companion-l14-current"),
    providerError,
  );
  assert.equal(attempts, 1);
});
