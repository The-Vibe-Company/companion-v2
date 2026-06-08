import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/migrate.ts"],
  banner: {
    js: 'import { createRequire as __companionCreateRequire } from "node:module"; const require = __companionCreateRequire(import.meta.url);',
  },
  format: ["esm"],
  noExternal: [/^@companion\//],
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
    "tar-stream",
    "yaml",
    "zod",
  ],
  sourcemap: true,
  clean: true,
  dts: false,
  target: "node20",
});
