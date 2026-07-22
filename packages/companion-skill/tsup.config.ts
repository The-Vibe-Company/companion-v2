import { defineConfig } from "tsup";

export default defineConfig({
  entry: { "companion-agent-client": "client/index.ts" },
  format: ["esm"],
  platform: "node",
  target: "node20",
  outDir: "skill/scripts",
  outExtension: () => ({ js: ".mjs" }),
  noExternal: ["@auth/agent", "@companion/contracts", "yaml"],
  banner: {
    js: 'import { createRequire as __companionCreateRequire } from "node:module"; const require = __companionCreateRequire(import.meta.url);',
  },
  splitting: false,
  sourcemap: false,
  minify: true,
  clean: false,
});
