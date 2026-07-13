import { describe, expect, it } from "vitest";
import { safeArtifactHref } from "./ArtifactsStrip";

describe("artifact links", () => {
  it("accepts HTTPS and local development HTTP only", () => {
    expect(safeArtifactHref("https://vanish.sh/f/report")).toBe("https://vanish.sh/f/report");
    expect(safeArtifactHref("http://localhost:3000/f/report")).toBe("http://localhost:3000/f/report");
    expect(safeArtifactHref("http://example.com/report")).toBeNull();
    expect(safeArtifactHref("javascript:alert(1)")).toBeNull();
    expect(safeArtifactHref("https://user:pass@example.com/report")).toBeNull();
  });
});
