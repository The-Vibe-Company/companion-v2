import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, type Db } from "@companion/db";

export type RunArtifactType = {
  contentType: string;
  previewable: boolean;
  previewContentType: string | null;
};

const EXTENSION_TYPES: Record<string, string> = {
  ".csv": "text/csv; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".json": "application/json",
  ".md": "text/markdown; charset=utf-8",
  ".pdf": "application/pdf",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
  ".zip": "application/zip",
};

function hasPrefix(data: Buffer, bytes: number[]): boolean {
  return data.length >= bytes.length && bytes.every((byte, index) => data[index] === byte);
}

function detectedPreview(contentType: string): RunArtifactType {
  return { contentType, previewable: true, previewContentType: contentType };
}

function downloadOnly(contentType: string): RunArtifactType {
  return { contentType, previewable: false, previewContentType: null };
}

function isoBmffBrands(data: Buffer): string[] {
  if (data.length < 16 || data.subarray(4, 8).toString("ascii") !== "ftyp") return [];
  const boxSize = data.readUInt32BE(0);
  if (boxSize < 16) return [];
  const end = Math.min(data.length, boxSize, 256);
  const brands: string[] = [];
  for (let offset = 8; offset + 4 <= end; offset += 4) {
    // Bytes 12..15 are the minor version, not a compatible brand.
    if (offset === 12) continue;
    brands.push(data.subarray(offset, offset + 4).toString("ascii"));
  }
  return brands;
}

function readEbmlVint(data: Buffer, offset: number): { length: number; value: number } | null {
  const first = data[offset];
  if (first === undefined || first === 0) return null;
  let length = 1;
  let marker = 0x80;
  while ((first & marker) === 0 && length < 8) {
    marker >>= 1;
    length += 1;
  }
  if (offset + length > data.length) return null;
  let value = first & (marker - 1);
  for (let index = 1; index < length; index += 1) value = (value * 256) + data[offset + index]!;
  return Number.isSafeInteger(value) ? { length, value } : null;
}

function hasWebmDocType(data: Buffer): boolean {
  if (!hasPrefix(data, [0x1a, 0x45, 0xdf, 0xa3])) return false;
  // DocType (0x4282) lives in the small EBML header. Parse its VINT length instead of accepting
  // any Matroska-family payload that happens to carry a .webm extension.
  const limit = Math.min(data.length, 4096);
  for (let offset = 4; offset + 3 <= limit; offset += 1) {
    if (data[offset] !== 0x42 || data[offset + 1] !== 0x82) continue;
    const size = readEbmlVint(data, offset + 2);
    if (!size || size.value < 1 || size.value > 16) return false;
    const start = offset + 2 + size.length;
    if (start + size.value > limit) return false;
    return data.subarray(start, start + size.value).toString("ascii").toLowerCase() === "webm";
  }
  return false;
}

/** Browser previews are trusted only after a binary signature check, never from a filename/MIME hint. */
export function detectRunFileType(path: string, data: Buffer): RunArtifactType {
  if (hasPrefix(data, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return detectedPreview("image/png");
  }
  if (hasPrefix(data, [0xff, 0xd8, 0xff])) return detectedPreview("image/jpeg");
  const ascii = data.subarray(0, 16).toString("ascii");
  if (ascii.startsWith("GIF87a") || ascii.startsWith("GIF89a")) {
    return detectedPreview("image/gif");
  }
  if (ascii.startsWith("RIFF") && ascii.slice(8, 12) === "WEBP") {
    return detectedPreview("image/webp");
  }
  const brands = isoBmffBrands(data);
  if (brands.some((brand) => brand === "avif" || brand === "avis")) return detectedPreview("image/avif");
  if (brands.some((brand) => ["isom", "iso2", "iso3", "iso4", "iso5", "iso6", "avc1", "mp41", "mp42", "M4V ", "MSNV", "dash"].includes(brand))) {
    return detectedPreview("video/mp4");
  }
  if (hasWebmDocType(data)) return detectedPreview("video/webm");
  const dot = path.lastIndexOf(".");
  const extension = dot >= 0 ? path.slice(dot).toLowerCase() : "";
  return downloadOnly(EXTENSION_TYPES[extension] ?? "application/octet-stream");
}

/** Artifact-facing name retained for the worker and existing callers. */
export const detectRunArtifactType = detectRunFileType;

/** Stable UUID-shaped id makes replacing one run/path an idempotent overwrite. */
export function runArtifactId(runId: string, path: string): string {
  const bytes = createHash("sha256").update("companion-run-artifact:v1\0").update(runId).update("\0").update(path).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function putRunArtifactMetadata(input: {
  orgId: string;
  runId: string;
  creatorId: string;
  workerId: string;
  id: string;
  path: string;
  fileName: string;
  contentType: string;
  byteSize: number;
  previewable: boolean;
  storageKey: string;
  ready: boolean;
  expiresAt: Date;
  database?: Db;
}): Promise<boolean> {
  const database = input.database ?? db;
  const result = await database.execute(sql`
    select companion_put_skill_run_artifact_metadata(
      ${input.orgId}::uuid, ${input.runId}::uuid, ${input.creatorId}, ${input.workerId},
      ${input.id}::uuid, ${input.path}, ${input.fileName}, ${input.contentType}, ${input.byteSize},
      ${input.previewable}, ${input.storageKey}, ${input.ready}, ${input.expiresAt.toISOString()}::timestamp with time zone
    ) as stored
  `);
  return Array.from(result as unknown as Iterable<{ stored: boolean }>)[0]?.stored ?? false;
}

export type ExpiredRunArtifact = { id: string; storageKey: string };

export async function listExpiredRunArtifacts(input: {
  staleBefore: Date;
  limit?: number;
  database?: Db;
}): Promise<ExpiredRunArtifact[]> {
  const result = await (input.database ?? db).execute(sql`
    select "id", "storage_key" as "storageKey"
    from companion_list_expired_skill_run_artifacts(
      ${input.staleBefore.toISOString()}::timestamp with time zone,
      ${input.limit ?? 250}
    )
  `);
  return Array.from(result as unknown as Iterable<ExpiredRunArtifact>);
}

/** Hold the row lock through object deletion, then remove metadata after the object is gone. */
export async function deleteExpiredRunArtifact(input: {
  artifact: ExpiredRunArtifact;
  staleBefore: Date;
  deleteObject: () => Promise<void>;
  database?: Db;
}): Promise<boolean> {
  const database = input.database ?? db;
  return database.transaction(async (transaction) => {
    const scoped = transaction as unknown as Db;
    const result = await scoped.execute(sql`
      select companion_lock_expired_skill_run_artifact(
        ${input.artifact.id}::uuid,
        ${input.artifact.storageKey},
        ${input.staleBefore.toISOString()}::timestamp with time zone
      ) as locked
    `);
    if (Array.from(result as unknown as Iterable<{ locked: boolean }>)[0]?.locked !== true) return false;
    await input.deleteObject();
    await scoped.execute(sql`
      select companion_complete_expired_skill_run_artifact(
        ${input.artifact.id}::uuid,
        ${input.artifact.storageKey}
      )
    `);
    return true;
  });
}
