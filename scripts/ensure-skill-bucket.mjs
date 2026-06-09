#!/usr/bin/env node
// Ensure the skill-archives S3 bucket exists on the local MinIO.
// Reuses @aws-sdk/client-s3 from packages/storage (resolved via createRequire)
// so we don't depend on the `mc` CLI (which collides with midnight-commander).
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(resolve(here, "../packages/storage/package.json"));
const { S3Client, CreateBucketCommand } = require("@aws-sdk/client-s3");

const bucket = process.env.S3_BUCKET_SKILL_ARCHIVES ?? "skill-archives";
const client = new S3Client({
  endpoint: process.env.S3_ENDPOINT ?? "http://127.0.0.1:9000",
  region: process.env.S3_REGION ?? "us-east-1",
  forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== "false",
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID ?? "companion",
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? "companion-secret",
  },
});

try {
  await client.send(new CreateBucketCommand({ Bucket: bucket }));
  console.log(`created bucket ${bucket}`);
} catch (err) {
  const code = err?.name ?? err?.Code;
  if (code === "BucketAlreadyOwnedByYou" || code === "BucketAlreadyExists") {
    console.log(`bucket ${bucket} already exists`);
  } else {
    console.error(`failed to ensure bucket ${bucket}: ${err?.message ?? err}`);
    process.exit(1);
  }
}
