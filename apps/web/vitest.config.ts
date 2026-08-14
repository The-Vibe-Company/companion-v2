import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  esbuild: { jsx: "automatic" },
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "node",
    // happy-dom fetches an iframe's `src` through its own client rather than the global `fetch` the
    // network guard in test/setup.ts replaces, so a framed document is the one thing that could reach
    // the network from a unit test. The Computer panel frames a Box desktop; no test has business
    // asking a real one for a stream.
    environmentOptions: { happyDOM: { settings: { disableIframePageLoading: true } } },
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    setupFiles: ["./test/setup.ts"],
  },
});
