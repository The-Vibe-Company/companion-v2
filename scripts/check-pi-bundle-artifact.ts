/**
 * CI guard: a Pi bundle pin may not merge before its artifact is published.
 *
 * The bundle pin (`COMPANION_PI_BUNDLE` in `packages/box-runtime/src/piBundle.ts`) is
 * content-addressed: its sha256 names the S3 object every Box downloads. This guard HEADs that
 * object so a pin can never reference an artifact that does not exist yet.
 *
 * It skips gracefully in two cases so this lands before the first real publish:
 *   1. the pin is still the placeholder sha (no artifact is expected yet), and
 *   2. no `COMPANION_PI_BUNDLE_BASE_URL` is configured (there is nothing to HEAD against).
 *
 * The read base URL is never hardcoded: it is supplied by the environment, pointing at the public
 * `companion-pi-bundles` bucket.
 */
import {
  COMPANION_PI_BUNDLE,
  companionPiBundleObjectKey,
  isPiBundleShaPlaceholder,
  piBundleBaseUrl,
} from "../packages/box-runtime/src/index";

async function main(): Promise<void> {
  if (isPiBundleShaPlaceholder(COMPANION_PI_BUNDLE.sha256)) {
    console.log(
      "pi-bundle guard: sha256 is still the placeholder; skipping the artifact HEAD until the first"
      + " real bundle is published.",
    );
    return;
  }

  const baseUrl = piBundleBaseUrl(process.env);
  if (!baseUrl) {
    console.log(
      "pi-bundle guard: COMPANION_PI_BUNDLE_BASE_URL is not set, so the artifact cannot be verified"
      + " here; skipping. Set it as a CI variable to enforce the pin-has-artifact contract.",
    );
    return;
  }

  const key = companionPiBundleObjectKey(COMPANION_PI_BUNDLE.sha256);
  const url = `${baseUrl}/${key}`;
  const response = await fetch(url, { method: "HEAD", redirect: "follow" });
  if (!response.ok) {
    console.error(
      `pi-bundle guard: the pinned bundle ${key} is not published (HTTP ${response.status}).`
      + " Publish it with .github/workflows/pi-bundle.yml before merging this pin.",
    );
    process.exitCode = 1;
    return;
  }
  console.log(`pi-bundle guard: ${key} is published and reachable.`);
}

try {
  await main();
} catch (error) {
  console.error(`pi-bundle guard failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
