import { describe, expect, it } from "vitest";
import type { SkillVM } from "@/lib/types";
import { BUILTIN_VIEWS, filtersKey, makeFilter, matchFilters, type Filter } from "./filters";

function mk(p: Partial<SkillVM> & { id: string }): SkillVM {
  return {
    uuid: p.id,
    scope: "public",
    version: "1.0.0",
    validation: "valid",
    description: "",
    error: null,
    owner: { name: "Alice Nardon", initials: "AN", handle: "alice", team: null },
    tools: [],
    size: "1 KB",
    license: null,
    checksum: null,
    created: "",
    updated: "",
    stars: 0,
    starred: false,
    team: null,
    teamSlug: null,
    ...p,
  };
}

const registry: SkillVM[] = [
  mk({ id: "jira-triage", scope: "team", team: "Platform", teamSlug: "platform" }),
  mk({ id: "k8s-logs", scope: "team", team: "Platform", teamSlug: "platform" }),
  mk({ id: "sql-query", scope: "team", team: "Data", teamSlug: "data", validation: "validating" }),
  mk({ id: "pdf-extract", scope: "public", starred: true }),
  mk({ id: "web-fetch", scope: "public", owner: { name: "Marek Doan", initials: "MD", handle: "marek", team: null } }),
  mk({ id: "image-ocr", scope: "private", validation: "invalid", owner: { name: "Tomas Okabe", initials: "TO", handle: "tomas", team: null } }),
];

const run = (filters: Filter[]) => registry.filter((s) => matchFilters(s, filters)).map((s) => s.id);

describe("matchFilters — teams", () => {
  it("no filters returns everything", () => {
    expect(run([]).length).toBe(registry.length);
  });

  it("team filter matches the skill's team slug only", () => {
    expect(run([{ type: "team", value: "platform" }])).toEqual(["jira-triage", "k8s-logs"]);
    expect(run([{ type: "team", value: "data" }])).toEqual(["sql-query"]);
  });

  it("a team filter excludes other teams and non-team skills", () => {
    const platform = run([{ type: "team", value: "platform" }]);
    expect(platform).not.toContain("sql-query"); // data team
    expect(platform).not.toContain("pdf-extract"); // public, no team
  });

  it("multiple team values are OR-ed within the team type", () => {
    expect(run([
      { type: "team", value: "platform" },
      { type: "team", value: "data" },
    ]).sort()).toEqual(["jira-triage", "k8s-logs", "sql-query"]);
  });
});

describe("matchFilters — other dimensions", () => {
  it("scope", () => {
    expect(run([{ type: "scope", value: "public" }])).toEqual(["pdf-extract", "web-fetch"]);
    expect(run([{ type: "scope", value: "private" }])).toEqual(["image-ocr"]);
  });
  it("status", () => {
    expect(run([{ type: "status", value: "invalid" }])).toEqual(["image-ocr"]);
  });
  it("starred", () => {
    expect(run([{ type: "starred", value: "true" }])).toEqual(["pdf-extract"]);
  });
  it("owner", () => {
    expect(run([{ type: "owner", value: "Marek Doan" }])).toEqual(["web-fetch"]);
  });
  it("different types are AND-ed (team AND status)", () => {
    expect(run([
      { type: "team", value: "data" },
      { type: "status", value: "validating" },
    ])).toEqual(["sql-query"]);
    expect(run([
      { type: "team", value: "platform" },
      { type: "status", value: "validating" },
    ])).toEqual([]); // platform skills are valid, not validating
  });
});

describe("built-in views", () => {
  it("Needs attention = invalid OR validating", () => {
    const view = BUILTIN_VIEWS.find((v) => v.id === "attention");
    expect(view).toBeTruthy();
    expect(run(view!.filters).sort()).toEqual(["image-ocr", "sql-query"]);
  });
  it("Public view = scope public", () => {
    const view = BUILTIN_VIEWS.find((v) => v.id === "public");
    expect(run(view!.filters)).toEqual(["pdf-extract", "web-fetch"]);
  });
  it("filtersKey is order-independent", () => {
    expect(filtersKey([
      { type: "scope", value: "public" },
      { type: "team", value: "platform" },
    ])).toBe(
      filtersKey([
        { type: "team", value: "platform" },
        { type: "scope", value: "public" },
      ]),
    );
  });
});

describe("makeFilter", () => {
  it("returns typed filters for valid pairs", () => {
    expect(makeFilter("scope", "public")).toEqual({ type: "scope", value: "public" });
    expect(makeFilter("starred", "true")).toEqual({ type: "starred", value: "true" });
  });

  it("rejects invalid type/value pairs", () => {
    expect(makeFilter("scope", "org")).toBeNull();
    expect(makeFilter("starred", "false")).toBeNull();
  });
});
