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

/** Stored workspace brand logo for an org (content-type is kept on the object). */
export function orgLogoKey(orgId: string): string {
  return `orgs/${orgId}/logo`;
}

/**
 * Stored comment image attachment. `imageId` is globally unique (the `skill_comment_images.id`),
 * so the key needs no comment/skill segment. Content-type is kept on the object. Uploaded with the
 * generic `putSkillArchive` / read with `getSkillArchive` / removed with `deleteSkillArchive`.
 */
export function commentImageKey(input: { orgId: string; imageId: string }): string {
  return `${input.orgId}/comments/${input.imageId}`;
}

export async function putOrgLogo(input: {
  orgId: string;
  body: Uint8Array;
  contentType: string;
  client?: S3Client;
  config?: StorageConfig;
}): Promise<void> {
  const config = input.config ?? getStorageConfig();
  const client = input.client ?? createStorageClient(config);
  await client.send(
    new PutObjectCommand({
      Bucket: config.bucket,
      Key: orgLogoKey(input.orgId),
      Body: input.body,
      ContentType: input.contentType,
    }),
  );
}

export async function getOrgLogo(input: {
  orgId: string;
  client?: S3Client;
  config?: StorageConfig;
}): Promise<{ body: Buffer; contentType: string } | null> {
  const config = input.config ?? getStorageConfig();
  const client = input.client ?? createStorageClient(config);
  try {
    const res = await client.send(
      new GetObjectCommand({
        Bucket: config.bucket,
        Key: orgLogoKey(input.orgId),
      }),
    );
    if (!res.Body) return null;
    const bytes = await res.Body.transformToByteArray();
    return {
      body: Buffer.from(bytes),
      contentType: res.ContentType ?? "application/octet-stream",
    };
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    if (name === "NoSuchKey" || name === "NotFound") return null;
    throw error;
  }
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

export async function getSkillArchive(input: {
  key: string;
  client?: S3Client;
  config?: StorageConfig;
}): Promise<Buffer> {
  const config = input.config ?? getStorageConfig();
  const client = input.client ?? createStorageClient(config);
  const res = await client.send(
    new GetObjectCommand({
      Bucket: config.bucket,
      Key: input.key,
    }),
  );
  if (!res.Body) throw new Error(`object not found: ${input.key}`);
  const bytes = await res.Body.transformToByteArray();
  return Buffer.from(bytes);
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
