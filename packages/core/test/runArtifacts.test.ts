import { describe, expect, it } from "vitest";
import { detectRunArtifactType, runArtifactId } from "../src/runArtifacts";

describe("run artifact content detection", () => {
  it("previews only binary-signature validated browser media", () => {
    expect(detectRunArtifactType("cat.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
      .toEqual({ contentType: "image/png", previewable: true, previewContentType: "image/png", previewKind: "image" });
    expect(detectRunArtifactType("fake.png", Buffer.from("<script>alert(1)</script>")))
      .toEqual({ contentType: "application/octet-stream", previewable: false, previewContentType: null, previewKind: null });
    expect(detectRunArtifactType("drawing.svg", Buffer.from("<svg/>")))
      .toEqual({ contentType: "image/svg+xml", previewable: false, previewContentType: null, previewKind: null });
    expect(detectRunArtifactType("page.html", Buffer.from("<html/>")))
      .toEqual({ contentType: "text/html; charset=utf-8", previewable: false, previewContentType: null, previewKind: null });

    const signedImages: Array<[string, Buffer, string]> = [
      ["photo.bin", Buffer.from([0xff, 0xd8, 0xff]), "image/jpeg"],
      ["animation.bin", Buffer.from("GIF89a", "ascii"), "image/gif"],
      ["image.bin", Buffer.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]), "image/webp"],
      ["image.bin", Buffer.from([
        0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70,
        0x61, 0x76, 0x69, 0x66, 0x00, 0x00, 0x00, 0x00,
        0x61, 0x76, 0x69, 0x66, 0x6d, 0x69, 0x66, 0x31,
      ]), "image/avif"],
    ];
    for (const [path, bytes, contentType] of signedImages) {
      expect(detectRunArtifactType(path, bytes)).toEqual({
        contentType,
        previewable: true,
        previewContentType: contentType,
        previewKind: "image",
      });
    }

    const mp4 = Buffer.from([
      0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70,
      0x6d, 0x70, 0x34, 0x32, 0x00, 0x00, 0x00, 0x00,
      0x69, 0x73, 0x6f, 0x6d, 0x6d, 0x70, 0x34, 0x32,
    ]);
    expect(detectRunArtifactType("movie.bin", mp4))
      .toEqual({ contentType: "video/mp4", previewable: true, previewContentType: "video/mp4", previewKind: "video" });

    const webm = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d]);
    expect(detectRunArtifactType("movie.bin", webm))
      .toEqual({ contentType: "video/webm", previewable: true, previewContentType: "video/webm", previewKind: "video" });
    expect(detectRunArtifactType("fake.webm", Buffer.from("webm")))
      .toEqual({ contentType: "application/octet-stream", previewable: false, previewContentType: null, previewKind: null });
  });

  it("allows only verified UTF-8 text, PDF, and XLSX previews", () => {
    expect(detectRunArtifactType("notes.md", Buffer.from("# Safe\n"))).toMatchObject({ previewKind: "markdown", previewable: true });
    expect(detectRunArtifactType("data.csv", Buffer.from("a,b\n1,2\n"))).toMatchObject({ previewKind: "csv", previewable: true });
    expect(detectRunArtifactType("bad.txt", Buffer.from([0xc3, 0x28]))).toMatchObject({ previewKind: null, previewable: false });
    expect(detectRunArtifactType("report.pdf", Buffer.from("%PDF-1.7\n"))).toMatchObject({ previewKind: "pdf", previewable: true });
    expect(detectRunArtifactType("fake.pdf", Buffer.from("not a pdf"))).toMatchObject({ previewKind: null, previewable: false });
    const centralEntry = (name: string, compressedSize = 0, uncompressedSize = 0) => {
      const header = Buffer.alloc(46);
      header.writeUInt32LE(0x02014b50, 0);
      header.writeUInt32LE(compressedSize, 20);
      header.writeUInt32LE(uncompressedSize, 24);
      header.writeUInt16LE(Buffer.byteLength(name), 28);
      return Buffer.concat([header, Buffer.from(name)]);
    };
    const local = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
    const directory = Buffer.concat([centralEntry("[Content_Types].xml"), centralEntry("xl/workbook.xml")]);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(2, 8);
    eocd.writeUInt16LE(2, 10);
    eocd.writeUInt32LE(directory.length, 12);
    eocd.writeUInt32LE(local.length, 16);
    const xlsx = Buffer.concat([local, directory, eocd]);
    expect(detectRunArtifactType("book.xlsx", xlsx)).toMatchObject({ previewKind: "xlsx", previewable: true });
    const expandedDirectory = Buffer.concat([
      centralEntry("[Content_Types].xml", 100, 1024),
      centralEntry("xl/workbook.xml", 100, 30 * 1024 * 1024),
    ]);
    const expandedEocd = Buffer.from(eocd);
    expandedEocd.writeUInt32LE(expandedDirectory.length, 12);
    const expandedXlsx = Buffer.concat([local, expandedDirectory, expandedEocd]);
    expect(detectRunArtifactType("bomb.xlsx", expandedXlsx)).toMatchObject({ previewKind: null, previewable: false });
    expect(detectRunArtifactType("archive.xlsx", Buffer.from("PK random zip"))).toMatchObject({ previewKind: null, previewable: false });
  });

  it("uses a stable id per run/path and changes it across paths", () => {
    const first = runArtifactId("11111111-1111-4111-8111-111111111111", "artifacts/report.txt");
    expect(first).toBe(runArtifactId("11111111-1111-4111-8111-111111111111", "artifacts/report.txt"));
    expect(first).not.toBe(runArtifactId("11111111-1111-4111-8111-111111111111", "artifacts/other.txt"));
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
  });
});
