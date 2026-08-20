import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * How long a rewrite proxied to the API may run before Next aborts the socket. Next defaults this to
 * 30 seconds in both dev and production, which is shorter than a legitimate send: a message that
 * wakes an asleep Companion persists first and then holds the request open for the wake, ~45–65s and
 * up to the API's three-minute start budget. At 30s the browser's POST died mid-wake and surfaced as
 * a `500` toast while the turn was already durable, so the composer neither cleared nor stopped
 * offering to send the same draft again. This is sized to sit just past that start budget (three
 * minutes plus the half-minute the failure path spends recording its reason) so the send outlives a
 * normal wake and still returns the API's own answer — delivered or the durable-but-pending turn —
 * rather than a proxy timeout. It is a bounded ceiling, not an unbounded wait: every step of a wake
 * already bounds itself against that budget, so a stalled upstream still returns well inside this.
 */
const API_PROXY_TIMEOUT_MS = 3 * 60_000 + 30_000;

const config: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: repoRoot,
  // Internal workspace packages ship TypeScript source; transpile them.
  transpilePackages: ["@companion/contracts", "@companion/skills", "@companion/core"],
  experimental: {
    // Rewrites to the API must outlive a wake the send request is waiting on; see the constant above.
    proxyTimeout: API_PROXY_TIMEOUT_MS,
  },
  async rewrites() {
    const api = process.env.COMPANION_API_URL ?? "http://127.0.0.1:3001";
    return [
      // Agent Auth discovery must live at the public instance root. In local development Web and
      // API use separate origins, so expose the API document through the same URL users copy.
      { source: "/.well-known/agent-configuration", destination: `${api}/.well-known/agent-configuration` },
      { source: "/auth/:path*", destination: `${api}/auth/:path*` },
      { source: "/v1/:path*", destination: `${api}/v1/:path*` },
      { source: "/trpc/:path*", destination: `${api}/trpc/:path*` },
    ];
  },
};

export default withSentryConfig(config, {
  silent: true,
  telemetry: false,
});

