import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  banner: {
    js: 'import { createRequire as __companionCreateRequire } from "node:module"; const require = __companionCreateRequire(import.meta.url);',
  },
  format: ["esm"],
  noExternal: [/^@companion\//],
  external: ["drizzle-orm", "postgres", "stripe"],
  sourcemap: true,
  clean: true,
  target: "node20",
});
