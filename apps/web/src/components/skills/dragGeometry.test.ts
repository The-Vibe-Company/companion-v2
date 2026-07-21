// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";
import type { DragItem } from "./SkillsApp";
import {
  DRAG_THRESHOLD_PX,
  exceedsThreshold,
  isDwellCandidate,
  isLabelDropValid,
  isLabelReorderValid,
  isRootDropValid,
  resolveDropTarget,
  sameDropTarget,
  treeRowKey,
} from "./dragGeometry";

const skillDrag: DragItem = { kind: "skill", lib: "org", skillId: "seo-helper", sourceLabel: "marketing" };
const looseSkillDrag: DragItem = { kind: "skill", lib: "org", skillId: "loose-skill", sourceLabel: null };
const labelDrag: DragItem = { kind: "label", lib: "org", path: "marketing", leaf: "marketing" };

/** A fake drop surface carrying the same data attributes the real rows render. */
function surface(attrs: { kind?: string; lib?: string; path?: string }): HTMLElement {
  const el = document.createElement("div");
  if (attrs.kind) el.dataset.skillDropKind = attrs.kind;
  if (attrs.lib) el.dataset.skillDropLib = attrs.lib;
  if (attrs.path) el.dataset.skillDropPath = attrs.path;
  return el;
}

describe("isLabelDropValid", () => {
  it("accepts a same-library skill onto any label", () => {
    expect(isLabelDropValid(skillDrag, "org", "growth")).toBe(true);
  });
  it("rejects a cross-library drop", () => {
    expect(isLabelDropValid(skillDrag, "mine", "growth")).toBe(false);
    expect(isLabelDropValid(null, "org", "growth")).toBe(false);
  });
  it("rejects a label onto itself or its own descendant", () => {
    expect(isLabelDropValid(labelDrag, "org", "marketing")).toBe(false);
    expect(isLabelDropValid(labelDrag, "org", "marketing/seo")).toBe(false);
  });
  it("rejects re-dropping a label onto its current parent (a no-op move)", () => {
    const nested: DragItem = { kind: "label", lib: "org", path: "marketing/seo", leaf: "seo" };
    expect(isLabelDropValid(nested, "org", "marketing")).toBe(false);
  });
  it("accepts a label onto an unrelated folder", () => {
    expect(isLabelDropValid(labelDrag, "org", "growth")).toBe(true);
  });
});

describe("isLabelReorderValid", () => {
  it("accepts only same-library sibling labels", () => {
    expect(isLabelReorderValid(labelDrag, "org", "growth")).toBe(true);
    expect(isLabelReorderValid(labelDrag, "mine", "growth")).toBe(false);
    expect(isLabelReorderValid(labelDrag, "org", "marketing/seo")).toBe(false);
    expect(isLabelReorderValid(skillDrag, "org", "growth")).toBe(false);
  });
});

describe("isRootDropValid", () => {
  it("accepts a filed skill (unfile) but not an already-loose one", () => {
    expect(isRootDropValid(skillDrag, "org")).toBe(true);
    expect(isRootDropValid(looseSkillDrag, "org")).toBe(false);
  });
  it("accepts a nested label (un-nest) but not a root one", () => {
    expect(isRootDropValid({ kind: "label", lib: "org", path: "marketing/seo", leaf: "seo" }, "org")).toBe(true);
    expect(isRootDropValid(labelDrag, "org")).toBe(false);
  });
  it("rejects a cross-library root drop", () => {
    expect(isRootDropValid(skillDrag, "mine")).toBe(false);
  });
});

describe("exceedsThreshold", () => {
  it("stays a click below the threshold", () => {
    expect(exceedsThreshold({ x: 10, y: 10 }, { x: 12, y: 11 })).toBe(false);
    expect(exceedsThreshold({ x: 10, y: 10 }, { x: 10 + DRAG_THRESHOLD_PX - 1, y: 10 })).toBe(false);
  });
  it("becomes a drag at or beyond the threshold on either axis", () => {
    expect(exceedsThreshold({ x: 10, y: 10 }, { x: 14, y: 10 })).toBe(true);
    expect(exceedsThreshold({ x: 10, y: 10 }, { x: 10, y: 6 })).toBe(true);
  });
});

describe("resolveDropTarget", () => {
  it("resolves a valid label surface", () => {
    expect(resolveDropTarget(surface({ kind: "label", lib: "org", path: "growth" }), skillDrag)).toEqual({
      lib: "org",
      kind: "label",
      path: "growth",
    });
  });
  it("resolves a valid root surface", () => {
    expect(resolveDropTarget(surface({ kind: "root", lib: "org" }), skillDrag)).toEqual({ lib: "org", kind: "root" });
  });
  it("walks up to the nearest surface from a nested child", () => {
    const row = surface({ kind: "label", lib: "org", path: "growth" });
    const child = document.createElement("span");
    row.appendChild(child);
    expect(resolveDropTarget(child, skillDrag)).toEqual({ lib: "org", kind: "label", path: "growth" });
  });
  it("returns null for an invalid (cross-library) surface", () => {
    expect(resolveDropTarget(surface({ kind: "label", lib: "mine", path: "drafts" }), skillDrag)).toBeNull();
  });
  it("returns null when there is no surface, no drag, or a missing path", () => {
    expect(resolveDropTarget(document.createElement("div"), skillDrag)).toBeNull();
    expect(resolveDropTarget(surface({ kind: "label", lib: "org", path: "growth" }), null)).toBeNull();
    expect(resolveDropTarget(surface({ kind: "label", lib: "org" }), skillDrag)).toBeNull();
  });
  it("resolves label edge zones as personal sibling reorder targets", () => {
    const target = surface({ kind: "label", lib: "org", path: "growth" });
    target.getBoundingClientRect = () => ({ top: 100, bottom: 140, height: 40 } as DOMRect);
    expect(resolveDropTarget(target, labelDrag, 105)).toEqual({
      lib: "org",
      kind: "reorder",
      path: "growth",
      position: "before",
    });
    expect(resolveDropTarget(target, labelDrag, 135)).toEqual({
      lib: "org",
      kind: "reorder",
      path: "growth",
      position: "after",
    });
    expect(resolveDropTarget(target, labelDrag, 120)).toEqual({ lib: "org", kind: "label", path: "growth" });
  });
  it("does not expose reorder zones to skills or labels from another parent", () => {
    const rootTarget = surface({ kind: "label", lib: "org", path: "growth" });
    rootTarget.getBoundingClientRect = () => ({ top: 100, bottom: 140, height: 40 } as DOMRect);
    expect(resolveDropTarget(rootTarget, skillDrag, 105)).toEqual({ lib: "org", kind: "label", path: "growth" });

    const nestedTarget = surface({ kind: "label", lib: "org", path: "marketing/seo" });
    nestedTarget.getBoundingClientRect = () => ({ top: 100, bottom: 140, height: 40 } as DOMRect);
    expect(resolveDropTarget(nestedTarget, labelDrag, 105)).toBeNull();
  });
});

describe("isDwellCandidate", () => {
  const rows = new Map([
    [treeRowKey("org", "marketing"), { hasChildren: true }],
    [treeRowKey("org", "growth"), { hasChildren: false }],
  ]);
  it("arms only on a collapsed folder-with-children during a skill drag", () => {
    const target = { lib: "org", kind: "label", path: "marketing" } as const;
    expect(isDwellCandidate(target, skillDrag, rows, new Set())).toBe(true);
    expect(isDwellCandidate(target, skillDrag, rows, new Set(["marketing"]))).toBe(false); // already open
    expect(isDwellCandidate(target, labelDrag, rows, new Set())).toBe(false); // label drag
  });
  it("does not arm on a childless folder, a root target, or null", () => {
    expect(isDwellCandidate({ lib: "org", kind: "label", path: "growth" }, skillDrag, rows, new Set())).toBe(false);
    expect(isDwellCandidate({ lib: "org", kind: "root" }, skillDrag, rows, new Set())).toBe(false);
    expect(isDwellCandidate(null, skillDrag, rows, new Set())).toBe(false);
  });
});

describe("sameDropTarget", () => {
  it("compares by value", () => {
    expect(sameDropTarget({ lib: "org", kind: "label", path: "a" }, { lib: "org", kind: "label", path: "a" })).toBe(true);
    expect(sameDropTarget({ lib: "org", kind: "label", path: "a" }, { lib: "org", kind: "label", path: "b" })).toBe(false);
    expect(sameDropTarget({ lib: "org", kind: "root" }, { lib: "org", kind: "root" })).toBe(true);
    expect(sameDropTarget({ lib: "org", kind: "root" }, null)).toBe(false);
    expect(sameDropTarget(
      { lib: "org", kind: "reorder", path: "a", position: "before" },
      { lib: "org", kind: "reorder", path: "a", position: "after" },
    )).toBe(false);
    expect(sameDropTarget(null, null)).toBe(true);
  });
});
