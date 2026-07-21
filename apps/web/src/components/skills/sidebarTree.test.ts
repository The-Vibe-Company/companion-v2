import { describe, expect, it } from "vitest";
import type { LabelVM } from "@companion/contracts";
import { deriveTreeRows, remapTreeOrder, removeTreeOrderPath, reorderTreeRows } from "./sidebarTree";

const labels: LabelVM[] = [
  { path: "alpha", displayName: null, color: null, icon: null },
  { path: "alpha/one", displayName: null, color: null, icon: null },
  { path: "alpha/two", displayName: null, color: null, icon: null },
  { path: "beta", displayName: null, color: null, icon: null },
  { path: "charlie", displayName: null, color: null, icon: null },
];

describe("personal sidebar category order", () => {
  it("uses alphabetical depth-first order without a preference", () => {
    expect(deriveTreeRows([], labels).map((row) => row.path)).toEqual([
      "alpha",
      "alpha/one",
      "alpha/two",
      "beta",
      "charlie",
    ]);
  });

  it("orders known siblings first and appends unknown siblings alphabetically", () => {
    expect(deriveTreeRows([], labels, ["beta", "alpha", "alpha/two", "alpha/one"]).map((row) => row.path)).toEqual([
      "beta",
      "alpha",
      "alpha/two",
      "alpha/one",
      "charlie",
    ]);
  });

  it("reorders only siblings and returns a complete depth-first preference", () => {
    const rows = deriveTreeRows([], labels);
    expect(reorderTreeRows(rows, "charlie", "alpha", "before")).toEqual([
      "charlie",
      "alpha",
      "alpha/one",
      "alpha/two",
      "beta",
    ]);
    expect(reorderTreeRows(rows, "alpha/two", "alpha/one", "before")).toEqual([
      "alpha",
      "alpha/two",
      "alpha/one",
      "beta",
      "charlie",
    ]);
    expect(reorderTreeRows(rows, "alpha/one", "beta", "before")).toBeNull();
  });

  it("preserves renamed positions, appends reparented subtrees, and prunes deleted subtrees", () => {
    const order = ["alpha", "alpha/one", "alpha/two", "beta", "charlie"];
    expect(remapTreeOrder(order, "beta", "bravo")).toEqual([
      "alpha",
      "alpha/one",
      "alpha/two",
      "bravo",
      "charlie",
    ]);
    expect(remapTreeOrder(order, "charlie", "alpha/charlie", true)).toEqual([
      "alpha",
      "alpha/one",
      "alpha/two",
      "alpha/charlie",
      "beta",
    ]);
    expect(removeTreeOrderPath(order, "alpha")).toEqual(["beta", "charlie"]);
  });
});
