import type { NextConfig } from "next";

const config: NextConfig = {
  // Internal workspace packages ship TypeScript source; transpile them.
  transpilePackages: ["@companion/contracts", "@companion/skills", "@companion/core"],
  async rewrites() {
    const api = process.env.COMPANION_API_URL ?? "http://127.0.0.1:3001";
    return [
      { source: "/auth/:path*", destination: `${api}/auth/:path*` },
      { source: "/v1/:path*", destination: `${api}/v1/:path*` },
      { source: "/trpc/:path*", destination: `${api}/trpc/:path*` },
    ];
  },
};

export default config;
