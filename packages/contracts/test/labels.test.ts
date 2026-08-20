import { describe, expect, it } from "vitest";
import {
  assignLabelInputSchema,
  createLabelInputSchema,
  deleteLabelInputSchema,
  LABEL_COLORS,
  LABEL_DISPLAY_NAME_MAX,
  LABEL_ICONS,
  LABEL_PATH_MAX,
  LABEL_PATH_MAX_DEPTH,
  labelColorSchema,
  labelDisplayNameSchema,
  labelDisplayNameToPath,
  labelIconSchema,
  labelMutationResultSchema,
  labelPathSchema,
  labelsResponseSchema,
  labelTreeNodeSchema,
  labelVMSchema,
  renameLabelInputSchema,
  setLabelColorInputSchema,
  setLabelIconInputSchema,
} from "../src/index";

describe("labelPathSchema", () => {
  it("accepts kebab segments joined by '/'", () => {
    for (const ok of ["marketing", "marketing/seo", "growth/paid-ads/q3", "a", "a1/b2-c3"]) {
      expect(labelPathSchema.parse(ok)).toBe(ok);
    }
  });

  it("rejects leading / trailing / empty slashes", () => {
    for (const bad of ["/marketing", "marketing/", "marketing//seo", "/", ""]) {
      expect(() => labelPathSchema.parse(bad)).toThrow();
    }
  });

  it("rejects non-kebab segments (uppercase, spaces, underscores, leading/trailing hyphen)", () => {
    for (const bad of ["Marketing", "marketing/SEO", "with space", "snake_case", "-lead", "trail-", "a--b"]) {
      expect(() => labelPathSchema.parse(bad)).toThrow();
    }
  });

  it("enforces the max depth and max length", () => {
    const tooDeep = Array.from({ length: LABEL_PATH_MAX_DEPTH + 1 }, (_, i) => `s${i}`).join("/");
    expect(() => labelPathSchema.parse(tooDeep)).toThrow();
    const okDeep = Array.from({ length: LABEL_PATH_MAX_DEPTH }, (_, i) => `s${i}`).join("/");
    expect(labelPathSchema.parse(okDeep)).toBe(okDeep);

    const tooLong = "a".repeat(LABEL_PATH_MAX + 1);
    expect(() => labelPathSchema.parse(tooLong)).toThrow();
  });
});

describe("labelDisplayNameSchema / labelDisplayNameToPath", () => {
  it("accepts human label names and slugifies them to canonical paths", () => {
    expect(labelDisplayNameSchema.parse("Dev")).toBe("Dev");
    expect(labelDisplayNameToPath("Dev")).toBe("dev");
    expect(labelDisplayNameToPath("Dev Tools/QA")).toBe("dev-tools/qa");
  });

  it("rejects empty or overlong display names", () => {
    expect(() => labelDisplayNameSchema.parse("   ")).toThrow();
    expect(() => labelDisplayNameSchema.parse("x".repeat(LABEL_DISPLAY_NAME_MAX + 1))).toThrow();
  });
});

describe("labelColorSchema / labelIconSchema", () => {
  it("accepts each design swatch and null", () => {
    for (const color of LABEL_COLORS) expect(labelColorSchema.parse(color)).toBe(color);
    expect(labelColorSchema.parse(null)).toBeNull();
    expect(() => labelColorSchema.parse("oklch(0.5 0 0)")).toThrow();
    expect(() => labelColorSchema.parse("#fff")).toThrow();
  });

  it("exposes twelve concrete swatches", () => {
    expect(LABEL_COLORS).toHaveLength(12);
    for (const color of ["oklch(0.58 0.14 340)", "oklch(0.58 0.11 220)", "oklch(0.50 0.035 265)"]) {
      expect(LABEL_COLORS).toContain(color);
    }
  });

  it("accepts each allowed icon glyph and null; rejects unknown glyphs", () => {
    for (const icon of LABEL_ICONS) expect(labelIconSchema.parse(icon)).toBe(icon);
    expect(labelIconSchema.parse(null)).toBeNull();
    expect(() => labelIconSchema.parse("nope")).toThrow();
  });

  it("exposes the full 32-glyph allowlist including the expanded menu icons", () => {
    expect(LABEL_ICONS).toHaveLength(32);
    for (const glyph of ["megaphone", "code", "rocket", "package", "heart", "zap", "flame", "pen-tool"]) {
      expect(LABEL_ICONS).toContain(glyph);
    }
    for (const glyph of ["archive", "calendar", "shield", "terminal", "building-2"]) {
      expect(LABEL_ICONS).toContain(glyph);
    }
  });
});

describe("labelVMSchema", () => {
  it("defaults color/icon to null when omitted", () => {
    expect(labelVMSchema.parse({ path: "marketing" })).toEqual({
      path: "marketing",
      displayName: null,
      color: null,
      icon: null,
    });
    expect(labelVMSchema.parse({ path: "marketing/seo", color: LABEL_COLORS[0], icon: "tag" })).toEqual({
      path: "marketing/seo",
      displayName: null,
      color: LABEL_COLORS[0],
      icon: "tag",
    });
  });
});

describe("labelTreeNodeSchema (recursive)", () => {
  it("parses a nested tree with roll-up counts and an empty explicit folder", () => {
    const tree = labelTreeNodeSchema.parse({
      path: "marketing",
      name: "marketing",
      displayName: "Marketing",
      color: null,
      icon: "megaphone",
      count: 3,
      explicit: true,
      children: [
        {
          path: "marketing/seo",
          name: "seo",
          displayName: "SEO",
          color: LABEL_COLORS[1],
          icon: null,
          count: 2,
          explicit: true,
          children: [],
        },
        // Empty explicit folder: in the tree, count 0, explicit true, no children.
        {
          path: "marketing/paid",
          name: "paid",
          displayName: null,
          color: null,
          icon: null,
          count: 0,
          explicit: true,
          children: [],
        },
      ],
    });
    expect(tree.children).toHaveLength(2);
    expect(tree.children[1]!.count).toBe(0);
  });

  it("rejects a negative count", () => {
    expect(() =>
      labelTreeNodeSchema.parse({
        path: "x",
        name: "x",
        displayName: null,
        color: null,
        icon: null,
        count: -1,
        explicit: false,
        children: [],
      }),
    ).toThrow();
  });
});

describe("labelsResponseSchema", () => {
  it("parses { tree, flat }", () => {
    const parsed = labelsResponseSchema.parse({
      tree: [
        {
          path: "growth",
          name: "growth",
          displayName: "Growth",
          color: null,
          icon: null,
          count: 0,
          explicit: true,
          children: [],
        },
      ],
      flat: [{ path: "growth", displayName: "Growth", color: null, icon: null }],
    });
    expect(parsed.tree).toHaveLength(1);
    expect(parsed.flat[0]!.path).toBe("growth");
  });
});

describe("label mutation inputs", () => {
  it("createLabelInputSchema: path required, color/icon optional", () => {
    expect(createLabelInputSchema.parse({ path: "marketing/seo" })).toEqual({ path: "marketing/seo" });
    expect(createLabelInputSchema.parse({ path: "growth", color: LABEL_COLORS[0], icon: "rocket" })).toEqual({
      path: "growth",
      color: LABEL_COLORS[0],
      icon: "rocket",
    });
    expect(createLabelInputSchema.parse({ path: "dev", displayName: "Dev" })).toEqual({
      path: "dev",
      displayName: "Dev",
    });
    expect(() => createLabelInputSchema.parse({ path: "Bad Path" })).toThrow();
  });

  it("renameLabelInputSchema requires both from and to", () => {
    expect(renameLabelInputSchema.parse({ from: "marketing", to: "growth", displayName: "Growth" })).toEqual({
      from: "marketing",
      to: "growth",
      displayName: "Growth",
    });
    expect(() => renameLabelInputSchema.parse({ from: "marketing" })).toThrow();
  });

  it("setLabelColorInputSchema / setLabelIconInputSchema accept null to clear", () => {
    expect(setLabelColorInputSchema.parse({ path: "growth", color: null })).toEqual({ path: "growth", color: null });
    expect(setLabelColorInputSchema.parse({ path: "growth", color: LABEL_COLORS[2] })).toEqual({
      path: "growth",
      color: LABEL_COLORS[2],
    });
    expect(setLabelIconInputSchema.parse({ path: "growth", icon: null })).toEqual({ path: "growth", icon: null });
    expect(setLabelIconInputSchema.parse({ path: "growth", icon: "star" })).toEqual({ path: "growth", icon: "star" });
    // color/icon are required on the dedicated setters (null is explicit, undefined is not allowed).
    expect(() => setLabelColorInputSchema.parse({ path: "growth" })).toThrow();
    expect(() => setLabelIconInputSchema.parse({ path: "growth" })).toThrow();
  });

  it("deleteLabelInputSchema / assignLabelInputSchema carry a validated path in the body", () => {
    expect(deleteLabelInputSchema.parse({ path: "marketing/seo" })).toEqual({ path: "marketing/seo" });
    expect(assignLabelInputSchema.parse({ path: "marketing/seo" })).toEqual({ path: "marketing/seo" });
    expect(() => assignLabelInputSchema.parse({ path: "/leading" })).toThrow();
  });

  it("labelMutationResultSchema only accepts { ok: true }", () => {
    expect(labelMutationResultSchema.parse({ ok: true })).toEqual({ ok: true });
    expect(() => labelMutationResultSchema.parse({ ok: false })).toThrow();
  });
});
