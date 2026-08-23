import type { ConfigContext, ExpoConfig } from "expo/config";

const variants = {
  development: { suffix: ".dev", scheme: "dev.companion.mobile.dev" },
  production: { suffix: "", scheme: "dev.companion.mobile" },
} as const;

type AppVariant = keyof typeof variants;

function activeVariant(): AppVariant {
  const requested = process.env.APP_VARIANT ?? "development";
  if (Object.hasOwn(variants, requested)) {
    // SAFETY: Object.hasOwn proves the environment value is one of the two AppVariant keys.
    return requested as AppVariant;
  }
  throw new Error(`Unknown APP_VARIANT=${requested}. Use development or production.`);
}

function withSuffix(value: string | undefined, suffix: string): string {
  if (!value) throw new Error("app.json must define production application identifiers.");
  return `${value}${suffix}`;
}

export default ({ config }: ConfigContext): ExpoConfig => {
  const { scheme, suffix } = variants[activeVariant()];
  return {
    ...config,
    name: config.name ?? "Companion",
    slug: config.slug ?? "companion",
    scheme,
    ios: { ...config.ios, bundleIdentifier: withSuffix(config.ios?.bundleIdentifier, suffix) },
    android: { ...config.android, package: withSuffix(config.android?.package, suffix) },
  };
};
