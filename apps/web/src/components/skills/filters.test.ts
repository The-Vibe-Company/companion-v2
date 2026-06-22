import { describe, expect, it } from "vitest";
import type { SkillVM } from "@/lib/types";
import { BUILTIN_VIEWS, filtersKey, makeFilter, matchFilters, type Filter } from "./filters";

function userOwner(p: { id?: string; name?: string; initials?: string; handle?: string | null }): SkillVM["owner"] {
  return {
    kind: "user",
    id: p.id ?? "user-1",
    userId: p.id ?? "user-1",
    teamId: null,
    name: p.name ?? "Alice Nardon",
    initials: p.initials ?? "AN",
    handle: p.handle ?? "alice",
    team: null,
  };
}

function teamOwner(p: { id: string; name: string; handle: string }): SkillVM["owner"] {
  return {
    kind: "team",
    id: p.id,
    userId: "user-1",
    teamId: p.id,
    name: p.name,
    initials: p.name.slice(0, 2).toUpperCase(),
    handle: p.handle,
    team: p.name,
  };
}

function mk(p: Partial<SkillVM> & { id: string }): SkillVM {
  const owner = p.owner ?? userOwner({});
  return {
    uuid: p.id,
    ownerId: owner.id,
    version: "1.0.0",
    validation: "valid",
    description: "",
    error: null,
    owner,
    tools: [],
    requirements: [],
    size: "1 KB",
    license: null,
    checksum: null,
    created: "",
    updated: "",
    stars: 0,
    starred: false,
    installStatus: "none",
    installedVersion: null,
    teamSlugs: owner.kind === "team" && owner.handle ? [owner.handle] : [],
    requiresCount: 0,
    usedByCount: 0,
    depWarn: false,
    archived: false,
    ...p,
    compatibility: p.compatibility ?? null,
    metadata: p.metadata ?? {},
  };
}

const registry: SkillVM[] = [
  mk({ id: "jira-triage", owner: teamOwner({ id: "team-platform", name: "Platform", handle: "platform" }) }),
  mk({ id: "k8s-logs", owner: teamOwner({ id: "team-platform", name: "Platform", handle: "platform" }) }),
  mk({
    id: "sql-query",
    owner: teamOwner({ id: "team-data", name: "Data", handle: "data" }),
    validation: "validating",
  }),
  mk({ id: "pdf-extract", starred: true }),
  mk({ id: "web-fetch", owner: userOwner({ id: "user-2", name: "Marek Doan", initials: "MD", handle: "marek" }) }),
  mk({
    id: "image-ocr",
    validation: "invalid",
    owner: userOwner({ id: "user-3", name: "Tomas Okabe", initials: "TO", handle: "tomas" }),
  }),
];

const run = (filters: Filter[]) => registry.filter((s) => matchFilters(s, filters)).map((s) => s.id);

describe("matchFilters — teams", () => {
  it("no filters returns everything", () => {
    expect(run([]).length).toBe(registry.length);
  });

  it("team filter matches the owning team slug", () => {
    expect(run([{ type: "team", value: "platform" }])).toEqual(["jira-triage", "k8s-logs"]);
    expect(run([{ type: "team", value: "data" }])).toEqual(["sql-query"]);
  });

  it("a team filter excludes other teams and personal skills", () => {
    const platform = run([{ type: "team", value: "platform" }]);
    expect(platform).not.toContain("sql-query"); // data team
    expect(platform).not.toContain("pdf-extract"); // personal, no team
  });

  it("multiple team values are OR-ed within the team type", () => {
    expect(run([
      { type: "team", value: "platform" },
      { type: "team", value: "data" },
    ]).sort()).toEqual(["jira-triage", "k8s-logs", "sql-query"]);
  });
});

describe("matchFilters — other dimensions", () => {
  it("visibility (owner kind)", () => {
    expect(run([{ type: "visibility", value: "team" }])).toEqual(["jira-triage", "k8s-logs", "sql-query"]);
    expect(run([{ type: "visibility", value: "personal" }])).toEqual(["pdf-extract", "web-fetch", "image-ocr"]);
  });
  it("status", () => {
    expect(run([{ type: "status", value: "invalid" }])).toEqual(["image-ocr"]);
  });
  it("starred", () => {
    expect(run([{ type: "starred", value: "true" }])).toEqual(["pdf-extract"]);
  });
  it("owner matches by principal id", () => {
    expect(run([{ type: "owner", value: "user-2" }])).toEqual(["web-fetch"]);
    // Team-owned skills are keyed by the team principal id.
    expect(run([{ type: "owner", value: "team-platform" }])).toEqual(["jira-triage", "k8s-logs"]);
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
  it("Team view = visibility team", () => {
    expect(run([{ type: "visibility", value: "team" }])).toEqual(["jira-triage", "k8s-logs", "sql-query"]);
  });
  it("filtersKey is order-independent", () => {
    expect(filtersKey([
      { type: "visibility", value: "team" },
      { type: "team", value: "platform" },
    ])).toBe(
      filtersKey([
        { type: "team", value: "platform" },
        { type: "visibility", value: "team" },
      ]),
    );
  });
});

describe("makeFilter", () => {
  it("returns typed filters for valid pairs", () => {
    expect(makeFilter("visibility", "team")).toEqual({ type: "visibility", value: "team" });
    expect(makeFilter("starred", "true")).toEqual({ type: "starred", value: "true" });
  });

  it("rejects invalid type/value pairs", () => {
    expect(makeFilter("visibility", "everyone")).toBeNull();
    expect(makeFilter("starred", "false")).toBeNull();
  });
});
