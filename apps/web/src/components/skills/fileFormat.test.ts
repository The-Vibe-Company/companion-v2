import { describe, expect, it } from "vitest";
import { collectHeadings } from "./fileFormat";

describe("collectHeadings", () => {
  it("keeps setext and ATX headings in rendered order", () => {
    expect(collectHeadings("Overview\n---\n\n## API")).toEqual([
      { level: 2, text: "Overview", id: "overview" },
      { level: 2, text: "API", id: "api" },
    ]);
  });

  it("ignores headings inside tilde fences", () => {
    expect(collectHeadings("~~~md\n# Hidden\nOverview\n---\n~~~\n# Visible")).toEqual([
      { level: 1, text: "Visible", id: "visible" },
    ]);
  });

  it("deduplicates ids across heading styles", () => {
    expect(collectHeadings("Intro\n=====\n\n# Intro\n\nIntro\n---")).toEqual([
      { level: 1, text: "Intro", id: "intro" },
      { level: 1, text: "Intro", id: "intro-1" },
      { level: 2, text: "Intro", id: "intro-2" },
    ]);
  });

  it("does not treat block starts before thematic breaks as setext headings", () => {
    expect(collectHeadings("- item\n---\n\n## Real")).toEqual([
      { level: 2, text: "Real", id: "real" },
    ]);
  });
});
