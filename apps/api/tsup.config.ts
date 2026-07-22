import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/migrate.ts"],
  banner: {
    js: 'import { createRequire as __companionCreateRequire } from "node:module"; const require = __companionCreateRequire(import.meta.url);',
  },
  format: ["esm"],
  // Agent Auth depends on Zod 4 (`.meta()`), while the API still uses Zod 3. Bundle each
  // dependency-local copy so the flattened API artifact cannot resolve Agent Auth against Zod 3.
  noExternal: [/^@companion\//, /^zod(?:\/.*)?$/],
  external: [
    "@aws-sdk/client-s3",
    "@aws-sdk/s3-request-presigner",
    "@better-auth/drizzle-adapter",
    "@hono/node-server",
    "@trpc/server",
    "better-auth",
    "drizzle-orm",
    "fflate",
    "hono",
    "postgres",
    "resend",
    "stripe",
    "tar-stream",
    "yaml",
  ],
  sourcemap: true,
  clean: true,
  dts: false,
  target: "node20",
});
