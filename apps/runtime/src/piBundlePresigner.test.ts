import { describe, expect, it } from "vitest";

import { companionPiBundleObjectKey } from "@companion/box-runtime";

import {
  createPiBundleUrlProvider,
  PI_BUNDLE_PRESIGN_EXPIRY_SECONDS,
} from "./piBundlePresigner";

const S3_ENV = {
  S3_ENDPOINT: "https://fly.storage.tigris.dev",
  S3_ACCESS_KEY_ID: "tid_readwrite",
  S3_SECRET_ACCESS_KEY: "tsec_readwrite",
  S3_BUCKET_SKILL_ARCHIVES: "skill-archives",
  S3_REGION: "auto",
};

describe("createPiBundleUrlProvider", () => {
  it("is undefined while bundle mode is off, whatever the S3 configuration says", () => {
    expect(createPiBundleUrlProvider({ ...S3_ENV })).toBeUndefined();
    expect(
      createPiBundleUrlProvider({ ...S3_ENV, COMPANION_PI_BUNDLE_ENABLED: "false" }),
    ).toBeUndefined();
    expect(
      createPiBundleUrlProvider({ ...S3_ENV, COMPANION_PI_BUNDLE_ENABLED: "TRUE" }),
    ).toBeUndefined();
  });

  it("is undefined when any explicit S3 input is missing, never inheriting dev defaults", () => {
    for (const missing of [
      "S3_ENDPOINT",
      "S3_ACCESS_KEY_ID",
      "S3_SECRET_ACCESS_KEY",
      "S3_BUCKET_SKILL_ARCHIVES",
    ] as const) {
      const env: NodeJS.ProcessEnv = { ...S3_ENV, COMPANION_PI_BUNDLE_ENABLED: "true" };
      delete env[missing];
      expect(createPiBundleUrlProvider(env)).toBeUndefined();
      expect(createPiBundleUrlProvider({ ...env, [missing]: "   " })).toBeUndefined();
    }
  });

  it("presigns a GET for the pinned bundle key in the skill-archives bucket, offline", async () => {
    const provider = createPiBundleUrlProvider({
      ...S3_ENV,
      COMPANION_PI_BUNDLE_ENABLED: "true",
    });
    expect(provider).toBeDefined();
    // Presigning is a local signature computation; this await performs no network call.
    const url = new URL(await provider!());
    // Path-style by default (S3_FORCE_PATH_STYLE unset): the bucket leads the path, then the
    // pi-bundles/ prefixed content-addressed key.
    expect(url.origin).toBe("https://fly.storage.tigris.dev");
    expect(url.pathname).toBe(`/skill-archives/${companionPiBundleObjectKey()}`);
    expect(url.pathname).toContain("/pi-bundles/companion-pi-bundle-");
    // A real SigV4 presign with the configured expiry, not a public URL.
    expect(url.searchParams.get("X-Amz-Expires")).toBe(String(PI_BUNDLE_PRESIGN_EXPIRY_SECONDS));
    expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
    expect(url.searchParams.get("X-Amz-Credential")).toContain("tid_readwrite");
    expect(url.searchParams.get("X-Amz-Credential")).toContain("auto");
  });

  it("honors S3_FORCE_PATH_STYLE=false with a virtual-host bucket address", async () => {
    const provider = createPiBundleUrlProvider({
      ...S3_ENV,
      COMPANION_PI_BUNDLE_ENABLED: "true",
      S3_FORCE_PATH_STYLE: "false",
    });
    const url = new URL(await provider!());
    expect(url.hostname).toBe("skill-archives.fly.storage.tigris.dev");
    expect(url.pathname).toBe(`/${companionPiBundleObjectKey()}`);
  });

  it("mints a URL per invocation so every layout script generation gets a fresh one", async () => {
    const provider = createPiBundleUrlProvider({
      ...S3_ENV,
      COMPANION_PI_BUNDLE_ENABLED: "true",
    })!;
    const [first, second] = await Promise.all([provider(), provider()]);
    for (const url of [first, second]) {
      expect(new URL(url).searchParams.get("X-Amz-Signature")).toBeTruthy();
    }
  });
});
