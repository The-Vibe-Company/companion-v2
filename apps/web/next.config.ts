import type { NextConfig } from "next";

const config: NextConfig = {
  // Internal workspace packages ship TypeScript source; transpile them.
  transpilePackages: ["@companion/contracts", "@companion/skills", "@companion/core"],
};

export default config;
