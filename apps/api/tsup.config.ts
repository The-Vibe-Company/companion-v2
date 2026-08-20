import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/migrate.ts", "src/cutover.ts"],
  // Each entry is invoked directly as `node dist/<name>.js`. Code splitting would turn them into
  // re-export shims whose `import.meta.url` no longer matches `process.argv[1]`, so the CLI body
  // would never run and the Railway release job would exit 0 without applying migrations.
  splitting: false,
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
    "@sentry/node",
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
