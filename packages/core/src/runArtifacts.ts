import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, type Db } from "@companion/db";

export type RunArtifactType = { contentType: string; previewable: boolean };

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

/** Raster previews are trusted only after a binary signature check, never from a filename/MIME hint. */
export function detectRunArtifactType(path: string, data: Buffer): RunArtifactType {
  if (hasPrefix(data, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { contentType: "image/png", previewable: true };
  }
  if (hasPrefix(data, [0xff, 0xd8, 0xff])) return { contentType: "image/jpeg", previewable: true };
  const ascii = data.subarray(0, 16).toString("ascii");
  if (ascii.startsWith("GIF87a") || ascii.startsWith("GIF89a")) {
    return { contentType: "image/gif", previewable: true };
  }
  if (ascii.startsWith("RIFF") && ascii.slice(8, 12) === "WEBP") {
    return { contentType: "image/webp", previewable: true };
  }
  if (data.length >= 16 && ascii.slice(4, 8) === "ftyp") {
    const boxSize = data.readUInt32BE(0);
    const end = Math.min(data.length, boxSize, 256);
    for (let offset = 8; boxSize >= 16 && offset + 4 <= end; offset += 4) {
      const brand = data.subarray(offset, offset + 4).toString("ascii");
      if (brand === "avif" || brand === "avis") return { contentType: "image/avif", previewable: true };
    }
  }
  const dot = path.lastIndexOf(".");
  const extension = dot >= 0 ? path.slice(dot).toLowerCase() : "";
  return { contentType: EXTENSION_TYPES[extension] ?? "application/octet-stream", previewable: false };
}

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
