// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";
import {
  RUN_ATTACHMENT_MAX_BYTES,
  RUN_ATTACHMENT_MAX_FILES,
  RUN_ATTACHMENT_MAX_TOTAL_BYTES,
} from "@companion/contracts";
import { appendRunAttachmentFiles } from "./runAttachmentDraft";

function sizedFile(name: string, size: number): File {
  return new File([new Uint8Array(size)], name, { type: "application/octet-stream" });
}

describe("appendRunAttachmentFiles", () => {
  it("adds valid files", () => {
    const file = sizedFile("brief.pdf", 42);

    expect(appendRunAttachmentFiles({ files: [], incoming: [file] })).toEqual({ files: [file], error: null });
  });

  it("rejects empty and oversized files without discarding valid files", () => {
    const valid = sizedFile("notes.txt", 12);
    const result = appendRunAttachmentFiles({
      files: [valid],
      incoming: [sizedFile("empty.txt", 0), sizedFile("archive.zip", RUN_ATTACHMENT_MAX_BYTES + 1)],
    });

    expect(result.files).toEqual([valid]);
    expect(result.error).toBe("archive.zip is larger than 10 MB.");
  });

  it("stops at five files", () => {
    const existing = Array.from({ length: RUN_ATTACHMENT_MAX_FILES }, (_, index) => sizedFile(`${index}.txt`, 1));
    const result = appendRunAttachmentFiles({ files: existing, incoming: [sizedFile("sixth.txt", 1)] });

    expect(result.files).toEqual(existing);
    expect(result.error).toBe("You can attach at most 5 files.");
  });

  it("enforces the total persisted run quota", () => {
    const result = appendRunAttachmentFiles({
      files: [],
      incoming: [sizedFile("over-quota.txt", 2)],
      persistedBytes: RUN_ATTACHMENT_MAX_TOTAL_BYTES - 1,
    });

    expect(result.files).toEqual([]);
    expect(result.error).toBe("This run can store at most 100 MB of attachments.");
  });
});
