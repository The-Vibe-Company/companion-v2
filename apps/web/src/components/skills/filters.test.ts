import { describe, expect, it } from "vitest";
import type { SkillVM } from "@/lib/types";
import { BUILTIN_VIEWS, filtersKey, makeFilter, matchFilters, type Filter } from "./filters";

const platform = { id: "team-platform", slug: "platform", name: "Platform" };
const data = { id: "team-data", slug: "data", name: "Data" };

function mk(p: Partial<SkillVM> & { id: string }): SkillVM {
  return {
    uuid: p.id,
    ownerId: "user-1",
    visibility: { everyone: true, teams: [] },
    version: "1.0.0",
    validation: "valid",
    description: "",
    error: null,
    owner: {
      kind: "user",
      id: "user-1",
      userId: "user-1",
      teamId: null,
      name: "Alice Nardon",
      initials: "AN",
      handle: "alice",
      team: null,
    },
    tools: [],
    size: "1 KB",
    license: null,
    checksum: null,
    created: "",
    updated: "",
    stars: 0,
    starred: false,
    teams: [],
    teamSlugs: [],
    ...p,
    compatibility: p.compatibility ?? null,
    metadata: p.metadata ?? {},
  };
}

const registry: SkillVM[] = [
  mk({ id: "jira-triage", visibility: { everyone: false, teams: [platform] }, teams: [platform], teamSlugs: ["platform"] }),
  mk({
    id: "k8s-logs",
    visibility: { everyone: false, teams: [platform, data] },
    teams: [platform, data],
    teamSlugs: ["platform", "data"],
  }),
  mk({ id: "sql-query", visibility: { everyone: false, teams: [data] }, teams: [data], teamSlugs: ["data"], validation: "validating" }),
  mk({ id: "pdf-extract", visibility: { everyone: true, teams: [] }, starred: true }),
  mk({
    id: "web-fetch",
    visibility: { everyone: true, teams: [platform] },
    teams: [platform],
    teamSlugs: ["platform"],
    owner: {
      kind: "user",
      id: "user-2",
      userId: "user-2",
      teamId: null,
      name: "Marek Doan",
      initials: "MD",
      handle: "marek",
      team: null,
    },
  }),
  mk({
    id: "image-ocr",
    visibility: { everyone: false, teams: [] },
    validation: "invalid",
    owner: {
      kind: "user",
      id: "user-3",
      userId: "user-3",
      teamId: null,
      name: "Tomas Okabe",
      initials: "TO",
      handle: "tomas",
      team: null,
    },
  }),
];

const run = (filters: Filter[]) => registry.filter((s) => matchFilters(s, filters)).map((s) => s.id);

describe("matchFilters — teams", () => {
  it("no filters returns everything", () => {
    expect(run([]).length).toBe(registry.length);
  });

  it("team filter matches any assigned team slug", () => {
    expect(run([{ type: "team", value: "platform" }])).toEqual(["jira-triage", "k8s-logs", "web-fetch"]);
    expect(run([{ type: "team", value: "data" }])).toEqual(["k8s-logs", "sql-query"]);
  });

  it("a team filter excludes other teams and non-team skills", () => {
    const platform = run([{ type: "team", value: "platform" }]);
    expect(platform).not.toContain("sql-query"); // data team
    expect(platform).not.toContain("pdf-extract"); // everyone, no team
  });

  it("multiple team values are OR-ed within the team type", () => {
    expect(run([
      { type: "team", value: "platform" },
      { type: "team", value: "data" },
    ]).sort()).toEqual(["jira-triage", "k8s-logs", "sql-query", "web-fetch"]);
  });
});

describe("matchFilters — other dimensions", () => {
  it("visibility", () => {
    expect(run([{ type: "visibility", value: "everyone" }])).toEqual(["pdf-extract", "web-fetch"]);
    expect(run([{ type: "visibility", value: "team" }])).toEqual(["jira-triage", "k8s-logs", "sql-query", "web-fetch"]);
    expect(run([{ type: "visibility", value: "private" }])).toEqual(["image-ocr"]);
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
  it("only ships the All view", () => {
    expect(BUILTIN_VIEWS.map((v) => v.id)).toEqual(["all"]);
    expect(BUILTIN_VIEWS[0]?.filters).toEqual([]);
  });
  it("Needs attention = invalid OR validating", () => {
    expect(
      run([
        { type: "status", value: "invalid" },
        { type: "status", value: "validating" },
      ]).sort(),
    ).toEqual(["image-ocr", "sql-query"]);
  });
  it("Everyone view = visibility everyone", () => {
    expect(run([{ type: "visibility", value: "everyone" }])).toEqual(["pdf-extract", "web-fetch"]);
  });
  it("filtersKey is order-independent", () => {
    expect(filtersKey([
      { type: "visibility", value: "everyone" },
      { type: "team", value: "platform" },
    ])).toBe(
      filtersKey([
        { type: "team", value: "platform" },
        { type: "visibility", value: "everyone" },
      ]),
    );
  });
});

describe("makeFilter", () => {
  it("returns typed filters for valid pairs", () => {
    expect(makeFilter("visibility", "everyone")).toEqual({ type: "visibility", value: "everyone" });
    expect(makeFilter("starred", "true")).toEqual({ type: "starred", value: "true" });
  });

  it("rejects invalid type/value pairs", () => {
    expect(makeFilter("visibility", "public")).toBeNull();
    expect(makeFilter("starred", "false")).toBeNull();
  });
});
