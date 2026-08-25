/**
 * CI guard: a Pi bundle pin may not merge before its artifact is published.
 *
 * The bundle pin (`COMPANION_PI_BUNDLE` in `packages/box-runtime/src/piBundle.ts`) is
 * content-addressed: its sha256 names the S3 object every Box downloads through a presigned URL.
 * This guard HEADs that object with the S3 SDK — the bucket is never public, so an anonymous HTTPS
 * HEAD cannot verify it — so a pin can never reference an artifact that does not exist yet.
 *
 * It skips gracefully in two cases so this lands before the first real publish:
 *   1. the pin is still the placeholder sha (no artifact is expected yet), and
 *   2. the S3 read credentials are not configured (there is nothing to HEAD with).
 *
 * The bucket is the existing skill-archives bucket (`S3_BUCKET_SKILL_ARCHIVES`, or the
 * `S3_BUCKET_PI_BUNDLES` override) and the key carries the `pi-bundles/` prefix.
 */
import {
  COMPANION_PI_BUNDLE,
  companionPiBundleObjectKey,
  isPiBundleShaPlaceholder,
} from "../packages/box-runtime/src/index";
import { createStorageClient, headSkillArchive } from "../packages/storage/src/index";

async function main(): Promise<void> {
  if (isPiBundleShaPlaceholder(COMPANION_PI_BUNDLE.sha256)) {
    console.log(
      "pi-bundle guard: sha256 is still the placeholder; skipping the artifact HEAD until the first"
      + " real bundle is published.",
    );
    return;
  }

  const endpoint = process.env.S3_ENDPOINT?.trim();
  const accessKeyId = process.env.S3_ACCESS_KEY_ID?.trim();
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY?.trim();
  const bucket = (process.env.S3_BUCKET_PI_BUNDLES ?? process.env.S3_BUCKET_SKILL_ARCHIVES)?.trim();
  if (!endpoint || !accessKeyId || !secretAccessKey || !bucket) {
    console.log(
      "pi-bundle guard: S3 credentials are not configured, so the artifact cannot be verified here;"
      + " skipping. Set S3_ENDPOINT, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, and"
      + " S3_BUCKET_SKILL_ARCHIVES (or S3_BUCKET_PI_BUNDLES) as CI variables to enforce the"
      + " pin-has-artifact contract.",
    );
    return;
  }

  const config = {
    endpoint,
    accessKeyId,
    secretAccessKey,
    bucket,
    region: process.env.S3_REGION?.trim() || "us-east-1",
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== "false",
  };
  const client = createStorageClient(config);
  const key = companionPiBundleObjectKey(COMPANION_PI_BUNDLE.sha256);
  try {
    const head = await headSkillArchive({ key, client, config });
    if (!head) {
      console.error(
        `pi-bundle guard: the pinned bundle ${key} is not published in ${bucket}.`
        + " Publish it with .github/workflows/pi-bundle.yml before merging this pin.",
      );
      process.exitCode = 1;
      return;
    }
    console.log(`pi-bundle guard: ${key} is published and reachable.`);
  } finally {
    client.destroy();
  }
}

try {
  await main();
} catch (error) {
  console.error(`pi-bundle guard failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
