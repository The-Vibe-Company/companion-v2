import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // These specs spawn real bash and Pi subprocesses and bind Unix sockets. Vitest's 5s default is
    // a pure-unit budget, so runner contention alone was failing them with no defect present.
    testTimeout: 30_000,
    clearMocks: true,
    restoreMocks: true,
    unstubGlobals: true,
  },
});
