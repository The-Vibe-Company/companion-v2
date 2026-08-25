/**
 * Presigned GET URLs for the self-hosted Pi bundle.
 *
 * The bundle artifact lives in the existing skill-archives bucket under the `pi-bundles/` prefix —
 * never a public bucket. The runtime service already holds the S3 credentials for that bucket, so
 * it mints a short-lived presigned GET URL at staging time and injects it into the Box layout
 * script; the Box holds no S3 credential and the object needs no public ACL. Presigning is a local
 * signature computation: no network call happens here, so a provider call is cheap enough to run
 * once per layout script generation.
 *
 * The provider is `undefined` — and the box runtime falls back to the `COMPANION_PI_INSTALL_COMMAND`
 * escape hatch — when bundle mode is off (`COMPANION_PI_BUNDLE_ENABLED` is not `true`) or when any
 * of the explicit S3 inputs is missing. The storage package's localhost/MinIO defaults are
 * deliberately not inherited: a production deployment that half-configures S3 must degrade to the
 * escape hatch, not sign URLs against a dev endpoint.
 */
import { companionPiBundlePlan } from "@companion/box-runtime";
import {
  createStorageClient,
  signedSkillArchiveUrl,
  type StorageConfig,
} from "@companion/storage";

/**
 * One hour. The layout install itself is bounded at 300 seconds, so the URL comfortably outlives
 * any single download attempt while staying too short to be worth exfiltrating.
 */
export const PI_BUNDLE_PRESIGN_EXPIRY_SECONDS = 3600;

/**
 * Build the bundle URL provider for `AsciiBoxCompanionRuntime`, or `undefined` when bundle mode is
 * off or the S3 configuration is incomplete. Each invocation of the returned function signs a fresh
 * URL for the pinned bundle's content-addressed object key.
 */
export function createPiBundleUrlProvider(
  env: NodeJS.ProcessEnv = process.env,
): (() => Promise<string>) | undefined {
  const plan = companionPiBundlePlan(env);
  if (!plan) return undefined;
  const endpoint = env.S3_ENDPOINT?.trim();
  const accessKeyId = env.S3_ACCESS_KEY_ID?.trim();
  const secretAccessKey = env.S3_SECRET_ACCESS_KEY?.trim();
  const bucket = env.S3_BUCKET_SKILL_ARCHIVES?.trim();
  if (!endpoint || !accessKeyId || !secretAccessKey || !bucket) return undefined;
  const config: StorageConfig = {
    endpoint,
    accessKeyId,
    secretAccessKey,
    bucket,
    region: env.S3_REGION?.trim() || "us-east-1",
    forcePathStyle: env.S3_FORCE_PATH_STYLE !== "false",
  };
  const client = createStorageClient(config);
  return async () =>
    await signedSkillArchiveUrl({
      key: plan.objectKey,
      expiresIn: PI_BUNDLE_PRESIGN_EXPIRY_SECONDS,
      client,
      config,
    });
}
