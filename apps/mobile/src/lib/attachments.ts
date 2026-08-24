import type { PickedAttachment } from "./api";
import {
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_MAX_COUNT,
  declaredAttachmentContentType,
} from "./types";

/** One file's size as a reader should see it, shared by the thread and the composer chips. */
export function readableSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** MIME types the document picker offers; the same set the control plane accepts. */
export const PICKABLE_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "application/pdf",
  "text/csv",
  "text/plain",
  "text/markdown",
  "application/json",
];

/**
 * Decide which picked files the composer will carry, and say why the rest were refused — the same
 * bounds the control plane enforces, applied before any bytes leave the phone. A mixed batch keeps
 * the good files and still names a refusal.
 */
export function acceptAttachments(
  staged: readonly PickedAttachment[],
  incoming: readonly { uri: string; name: string; type: string; byteSize: number }[],
) {
  const files = [...staged];
  let error: string | null = null;
  for (const file of incoming) {
    if (files.length >= ATTACHMENT_MAX_COUNT) {
      error = `A message can carry at most ${ATTACHMENT_MAX_COUNT} files.`;
      break;
    }
    if (file.byteSize === 0) {
      error = `${file.name} is empty.`;
      continue;
    }
    if (file.byteSize > ATTACHMENT_MAX_BYTES) {
      error = `${file.name} is larger than ${readableSize(ATTACHMENT_MAX_BYTES)}.`;
      continue;
    }
    const contentType = declaredAttachmentContentType(file);
    if (!contentType) {
      error = `${file.name} is not an image, PDF, CSV, text, Markdown, or JSON file.`;
      continue;
    }
    files.push({ uri: file.uri, name: file.name, type: contentType, byteSize: file.byteSize });
  }
  return { files, error };
}
