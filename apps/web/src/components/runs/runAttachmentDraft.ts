import {
  RUN_ATTACHMENT_MAX_BYTES,
  RUN_ATTACHMENT_MAX_FILES,
  RUN_ATTACHMENT_MAX_TOTAL_BYTES,
} from "@companion/contracts";

export function appendRunAttachmentFiles(input: {
  files: readonly File[];
  incoming: ArrayLike<File>;
  persistedBytes?: number;
}): { files: File[]; error: string | null } {
  const files = [...input.files];
  const persistedBytes = input.persistedBytes ?? 0;
  let error: string | null = null;

  for (const file of Array.from(input.incoming)) {
    if (files.length >= RUN_ATTACHMENT_MAX_FILES) {
      error = `You can attach at most ${RUN_ATTACHMENT_MAX_FILES} files.`;
      break;
    }
    if (file.size === 0) {
      error = `${file.name} is empty.`;
      continue;
    }
    if (file.size > RUN_ATTACHMENT_MAX_BYTES) {
      error = `${file.name} is larger than 10 MB.`;
      continue;
    }
    const draftBytes = files.reduce((sum, candidate) => sum + candidate.size, 0);
    if (persistedBytes + draftBytes + file.size > RUN_ATTACHMENT_MAX_TOTAL_BYTES) {
      error = "This run can store at most 100 MB of attachments.";
      continue;
    }
    files.push(file);
  }

  return { files, error };
}
