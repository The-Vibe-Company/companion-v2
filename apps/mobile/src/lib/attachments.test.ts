import { describe, expect, it } from "vitest";

import { acceptAttachments, readableSize } from "./attachments";

const picked = (over: Partial<{ uri: string; name: string; type: string; byteSize: number }> = {}) => ({
  uri: "file:///tmp/a.png",
  name: "a.png",
  type: "image/png",
  byteSize: 1024,
  ...over,
});

describe("acceptAttachments", () => {
  it("accepts a supported file and normalizes its declared type", () => {
    const result = acceptAttachments([], [picked({ name: "notes.md", type: "", byteSize: 10 })]);
    expect(result.error).toBeNull();
    expect(result.files).toEqual([
      { uri: "file:///tmp/a.png", name: "notes.md", type: "text/markdown", byteSize: 10 },
    ]);
  });

  it("refuses a sixth file and says so", () => {
    const staged = Array.from({ length: 5 }, (_, index) =>
      ({ uri: `file:///tmp/${index}`, name: `${index}.png`, type: "image/png", byteSize: 1 }));
    const result = acceptAttachments(staged, [picked()]);
    expect(result.files).toHaveLength(5);
    expect(result.error).toContain("at most 5 files");
  });

  it("refuses empty, oversized, and unsupported files while keeping the good ones", () => {
    const result = acceptAttachments([], [
      picked({ name: "empty.png", byteSize: 0 }),
      picked({ name: "big.png", byteSize: 11 * 1024 * 1024 }),
      picked({ name: "app.exe", type: "application/octet-stream" }),
      picked({ name: "ok.pdf", type: "application/pdf" }),
    ]);
    expect(result.files.map((file) => file.name)).toEqual(["ok.pdf"]);
    expect(result.error).toContain("app.exe");
  });
});

describe("readableSize", () => {
  it("names bytes, kilobytes, and megabytes", () => {
    expect(readableSize(512)).toBe("512 B");
    expect(readableSize(2048)).toBe("2 KB");
    expect(readableSize(10 * 1024 * 1024)).toBe("10.0 MB");
  });
});
