import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    /**
     * These tests pack archives, write temp trees, and run the pinned `skills` CLI as a subprocess,
     * and the Node 20 compatibility job runs them while `turbo` drives lint, typecheck, test, and
     * build across 15 packages on a 4-core runner. Under that contention the default 5s is a
     * measure of how busy the runner is rather than of whether a test hangs, which is what failed
     * the job on 93c728c. Nothing here waits on a network or a timer, so a test that reaches this
     * limit is genuinely stuck and the job's own 20-minute timeout remains the outer bound.
     */
    testTimeout: 30_000,
  },
});
