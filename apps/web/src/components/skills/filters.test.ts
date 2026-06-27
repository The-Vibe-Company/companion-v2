import { describe, expect, it } from "vitest";
import type { SkillVM } from "@/lib/types";
import { chipParts, filtersKey, makeFilter, matchFilters, type Filter } from "./filters";

function mk(p: Partial<SkillVM> & { id: string }): SkillVM {
  return {
    uuid: p.id,
    shareToken: "share-" + p.id,
    version: "1.0.0",
    validation: "valid",
    description: "",
    notes: null,
    error: null,
    scope: "org",
    source: null,
    labels: [],
    authorId: "user-1",
    authorName: "Alice Nardon",
    authorInitials: "AN",
    authorAvatarUrl: null,
    updaterId: "user-1",
    updaterName: "Alice Nardon",
    updaterInitials: "AN",
    updaterAvatarUrl: null,
    modifiers: [],
    tools: [],
    requirements: [],
    compatibility: null,
    metadata: {},
    size: "1 KB",
    license: null,
    checksum: null,
    created: "",
    updated: "",
    stars: 0,
    starred: false,
    installStatus: "none",
    installedVersion: null,
    requiresCount: 0,
    usedByCount: 0,
    depWarn: false,
    archived: false,
    ...p,
  };
}

const registry: SkillVM[] = [
  mk({ id: "jira-triage", requiresCount: 2 }),
  mk({ id: "k8s-logs", usedByCount: 3 }),
  mk({ id: "sql-query", validation: "validating" }),
  mk({ id: "pdf-extract", starred: true }),
  mk({ id: "web-fetch" }),
  mk({ id: "image-ocr", validation: "invalid" }),
];

const run = (filters: Filter[]) => registry.filter((s) => matchFilters(s, filters)).map((s) => s.id);

describe("matchFilters", () => {
  it("no filters returns everything", () => {
    expect(run([]).length).toBe(registry.length);
  });

  it("status narrows by validation state", () => {
    expect(run([{ type: "status", value: "invalid" }])).toEqual(["image-ocr"]);
    expect(run([{ type: "status", value: "validating" }])).toEqual(["sql-query"]);
  });

  it("starred selects starred skills", () => {
    expect(run([{ type: "starred", value: "true" }])).toEqual(["pdf-extract"]);
  });

  it("deps 'has' matches skills that declare dependencies", () => {
    expect(run([{ type: "deps", value: "has" }])).toEqual(["jira-triage"]);
  });

  it("deps 'used' matches skills depended on by others", () => {
    expect(run([{ type: "deps", value: "used" }])).toEqual(["k8s-logs"]);
  });

  it("the same type is OR-ed", () => {
    expect(
      run([
        { type: "status", value: "invalid" },
        { type: "status", value: "validating" },
      ]).sort(),
    ).toEqual(["image-ocr", "sql-query"]);
  });

  it("different types are AND-ed", () => {
    expect(
      run([
        { type: "deps", value: "has" },
        { type: "status", value: "valid" },
      ]),
    ).toEqual(["jira-triage"]);
    expect(
      run([
        { type: "deps", value: "has" },
        { type: "status", value: "invalid" },
      ]),
    ).toEqual([]);
  });
});

describe("filtersKey", () => {
  it("is order-independent", () => {
    expect(
      filtersKey([
        { type: "status", value: "valid" },
        { type: "starred", value: "true" },
      ]),
    ).toBe(
      filtersKey([
        { type: "starred", value: "true" },
        { type: "status", value: "valid" },
      ]),
    );
  });
});

describe("chipParts", () => {
  it("renders status / starred / deps chips", () => {
    expect(chipParts({ type: "status", value: "invalid" })).toEqual({
      icon: "alert-triangle",
      key: "status",
      val: "invalid",
    });
    expect(chipParts({ type: "starred", value: "true" })).toEqual({ icon: "star", key: "", val: "starred" });
    expect(chipParts({ type: "deps", value: "used" })).toEqual({
      icon: "corner-down-right",
      key: "deps",
      val: "used as dependency",
    });
  });
});

describe("makeFilter", () => {
  it("returns typed filters for valid pairs", () => {
    expect(makeFilter("status", "valid")).toEqual({ type: "status", value: "valid" });
    expect(makeFilter("starred", "true")).toEqual({ type: "starred", value: "true" });
    expect(makeFilter("deps", "has")).toEqual({ type: "deps", value: "has" });
  });

  it("rejects invalid type/value pairs", () => {
    expect(makeFilter("status", "everyone")).toBeNull();
    expect(makeFilter("starred", "false")).toBeNull();
    expect(makeFilter("deps", "nope")).toBeNull();
  });
});
