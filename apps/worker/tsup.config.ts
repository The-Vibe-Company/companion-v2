import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  noExternal: [/^@companion\//],
  external: ["drizzle-orm", "postgres", "stripe"],
  sourcemap: true,
  clean: true,
  target: "node20",
});
