import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export interface StorageConfig {
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  forcePathStyle: boolean;
}

export function getStorageConfig(): StorageConfig {
  const endpoint = process.env.S3_ENDPOINT ?? "http://127.0.0.1:9000";
  const accessKeyId = process.env.S3_ACCESS_KEY_ID ?? "companion";
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY ?? "companion-secret";
  const bucket = process.env.S3_BUCKET_SKILL_ARCHIVES ?? "skill-archives";
  if (!endpoint || !accessKeyId || !secretAccessKey || !bucket) {
    throw new Error("S3_ENDPOINT, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, and S3_BUCKET_SKILL_ARCHIVES are required");
  }
  return {
    endpoint,
    accessKeyId,
    secretAccessKey,
    bucket,
    region: process.env.S3_REGION ?? "us-east-1",
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== "false",
  };
}

export function createStorageClient(config = getStorageConfig()): S3Client {
  return new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    forcePathStyle: config.forcePathStyle,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });
}

export function skillArchiveKey(input: { orgId: string; slug: string; version: string }): string {
  return `${input.orgId}/${input.slug}/${input.version}.tar.gz`;
}

export async function putSkillArchive(input: {
  key: string;
  body: Uint8Array;
  contentType?: string;
  preventOverwrite?: boolean;
  client?: S3Client;
  config?: StorageConfig;
}): Promise<void> {
  const config = input.config ?? getStorageConfig();
  const client = input.client ?? createStorageClient(config);
  await client.send(
    new PutObjectCommand({
      Bucket: config.bucket,
      Key: input.key,
      Body: input.body,
      ContentType: input.contentType ?? "application/gzip",
      IfNoneMatch: input.preventOverwrite ? "*" : undefined,
    }),
  );
}

export async function deleteSkillArchive(input: {
  key: string;
  client?: S3Client;
  config?: StorageConfig;
}): Promise<void> {
  const config = input.config ?? getStorageConfig();
  const client = input.client ?? createStorageClient(config);
  await client.send(
    new DeleteObjectCommand({
      Bucket: config.bucket,
      Key: input.key,
    }),
  );
}

export async function signedSkillArchiveUrl(input: {
  key: string;
  expiresIn?: number;
  client?: S3Client;
  config?: StorageConfig;
}): Promise<string> {
  const config = input.config ?? getStorageConfig();
  const client = input.client ?? createStorageClient(config);
  return getSignedUrl(
    client,
    new GetObjectCommand({
      Bucket: config.bucket,
      Key: input.key,
    }),
    { expiresIn: input.expiresIn ?? 300 },
  );
}
