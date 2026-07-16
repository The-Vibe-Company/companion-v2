import { describe, expect, it } from "vitest";
import { detectRunArtifactType, runArtifactId } from "../src/runArtifacts";

describe("run artifact content detection", () => {
  it("previews only binary-signature validated raster images", () => {
    expect(detectRunArtifactType("cat.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
      .toEqual({ contentType: "image/png", previewable: true });
    expect(detectRunArtifactType("fake.png", Buffer.from("<script>alert(1)</script>")))
      .toEqual({ contentType: "application/octet-stream", previewable: false });
    expect(detectRunArtifactType("drawing.svg", Buffer.from("<svg/>")))
      .toEqual({ contentType: "image/svg+xml", previewable: false });
    expect(detectRunArtifactType("page.html", Buffer.from("<html/>")))
      .toEqual({ contentType: "text/html; charset=utf-8", previewable: false });
  });

  it("uses a stable id per run/path and changes it across paths", () => {
    const first = runArtifactId("11111111-1111-4111-8111-111111111111", "artifacts/report.txt");
    expect(first).toBe(runArtifactId("11111111-1111-4111-8111-111111111111", "artifacts/report.txt"));
    expect(first).not.toBe(runArtifactId("11111111-1111-4111-8111-111111111111", "artifacts/other.txt"));
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
  });
});
