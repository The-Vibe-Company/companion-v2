import { createHash } from "node:crypto";
import { putSkillArchive } from "@companion/storage";
import { isPreconditionFailed } from "./runAttachments";

export function deterministicProjectAttachmentId(input: {
  orgId: string;
  actorId: string;
  projectId: string;
  idempotencyKey: string;
  index: number;
  fileName: string;
  contentType: string;
  bytes: Buffer;
}): string {
  const digest = createHash("sha256")
    .update("companion-project-attachment:v1\0")
    .update(input.orgId)
    .update("\0")
    .update(input.actorId)
    .update("\0")
    .update(input.projectId)
    .update("\0")
    .update(input.idempotencyKey)
    .update("\0")
    .update(String(input.index))
    .update("\0")
    .update(input.fileName)
    .update("\0")
    .update(input.contentType)
    .update("\0")
    .update(input.bytes)
    .digest();
  digest[6] = (digest[6]! & 0x0f) | 0x50;
  digest[8] = (digest[8]! & 0x3f) | 0x80;
  const hex = digest.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function putProjectAttachmentOnce(input: {
  key: string;
  body: Buffer;
  contentType: string;
  put?: typeof putSkillArchive;
}): Promise<"created" | "existing"> {
  try {
    await (input.put ?? putSkillArchive)({
      key: input.key,
      body: input.body,
      contentType: input.contentType,
      preventOverwrite: true,
    });
    return "created";
  } catch (error) {
    if (isPreconditionFailed(error)) return "existing";
    throw error;
  }
}
