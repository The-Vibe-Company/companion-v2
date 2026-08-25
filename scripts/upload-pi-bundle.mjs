#!/usr/bin/env node
// Publish a built Pi bundle tarball to the public bundle bucket at its content-addressed key.
//
// Reuses @aws-sdk/client-s3 from packages/storage (resolved via createRequire) so it does not depend
// on the `mc` CLI (which collides with midnight-commander), mirroring scripts/ensure-skill-bucket.mjs.
//
// The read side of the contract is COMPANION_PI_BUNDLE_BASE_URL (never hardcoded); the write side is
// the standard S3_* credentials plus S3_BUCKET_PI_BUNDLES. The object is written public-read so a Box
// can fetch it with a plain HTTPS GET and verify it against the pinned checksum.
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { readFileSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(resolve(here, "../packages/storage/package.json"));
const { S3Client, PutObjectCommand, HeadObjectCommand } = require("@aws-sdk/client-s3");

const [tarballPath, objectKey] = process.argv.slice(2);
if (!tarballPath || !objectKey) {
  console.error("usage: upload-pi-bundle.mjs <tarball-path> <object-key>");
  process.exit(2);
}

const bucket = process.env.S3_BUCKET_PI_BUNDLES ?? "companion-pi-bundles";
const client = new S3Client({
  endpoint: process.env.S3_ENDPOINT,
  region: process.env.S3_REGION ?? "auto",
  forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
  credentials: process.env.S3_ACCESS_KEY_ID && process.env.S3_SECRET_ACCESS_KEY
    ? {
        accessKeyId: process.env.S3_ACCESS_KEY_ID,
        secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
      }
    : undefined,
});

// The key is content-addressed, so an existing object is already the identical artifact.
try {
  await client.send(new HeadObjectCommand({ Bucket: bucket, Key: objectKey }));
  console.log(`bundle ${objectKey} is already published in ${bucket}`);
  process.exit(0);
} catch (err) {
  const status = err?.$metadata?.httpStatusCode;
  if (status !== 404 && err?.name !== "NotFound" && err?.name !== "NoSuchKey") {
    // A non-404 (auth, network) is a real failure, not "publish it".
    if (status && status !== 404) {
      console.error(`failed to check ${objectKey}: ${err?.message ?? err}`);
      process.exit(1);
    }
  }
}

await client.send(new PutObjectCommand({
  Bucket: bucket,
  Key: objectKey,
  Body: readFileSync(tarballPath),
  ContentType: "application/gzip",
  ACL: "public-read",
  CacheControl: "public, max-age=31536000, immutable",
}));
console.log(`published ${objectKey} to ${bucket}`);
