import React from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { SkillsApp } from "./SkillsApp";
import type { LocalSkillRow } from "@companion/contracts";
import type { MeVM, OrgVM, SkillVM, TeamVM } from "@/lib/types";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
}));

const me: MeVM = { id: "user-1", name: "Ada Lovelace", email: "ada@example.com", initials: "AL" };
const currentOrg: OrgVM = {
  id: "org-1",
  name: "Acme",
  slug: "acme",
  kind: "team",
  plan: "team",
  myRole: "owner",
  color: null,
  logoUrl: null,
};
const teams: TeamVM[] = [
  { id: "engineering", dbId: "team-1", name: "Engineering", initial: "E", color: null, icon: null, role: "editor" },
  { id: "support", dbId: "team-2", name: "Support", initial: "S", color: null, icon: null, role: "reader" },
];

function skill(overrides: Partial<SkillVM>): SkillVM {
  return {
    uuid: "skill-" + (overrides.id ?? "base"),
    id: "base",
    ownerId: "user-1",
    visibility: { everyone: false, teams: [] },
    version: "1.0.0",
    validation: "valid",
    description: "Test skill",
    error: null,
    owner: {
      kind: "user",
      id: "user-1",
      userId: "user-1",
      teamId: null,
      name: "Ada Lovelace",
      initials: "AL",
      handle: "ada",
      team: null,
    },
    tools: [],
    compatibility: null,
    metadata: {},
    size: "1 KB",
    license: "MIT",
    checksum: null,
    created: "Jun 1, 2026",
    updated: "just now",
    stars: 0,
    starred: false,
    teams: [],
    teamSlugs: [],
    requiresCount: 0,
    usedByCount: 0,
    depWarn: false,
    archived: false,
    ...overrides,
  };
}

const localSkills: LocalSkillRow[] = [
  {
    key: "companion",
    name: "Companion",
    description: "Manage skills locally.",
    status: "none",
    installedVersion: null,
    availableVersion: "1.0.0",
    lastReportedAt: null,
    agentLabel: null,
    what: "A local helper skill.",
    uses: "Installs and updates skills.",
    why: ["Keeps local skills current."],
    commands: [],
    changes: [],
    prompts: { install: "install", update: "update", use: "use" },
  },
];

function render(initialRoute: React.ComponentProps<typeof SkillsApp>["initialRoute"]) {
  return renderToString(
    React.createElement(SkillsApp, {
      initialSkills: [
        skill({ id: "owned-skill" }),
        skill({
          id: "team-skill",
          ownerId: "team-1",
          owner: {
            kind: "team",
            id: "team-1",
            userId: "user-1",
            teamId: "team-1",
            name: "Engineering",
            initials: "EN",
            handle: "engineering",
            team: "Engineering",
          },
          teams: [{ id: "team-1", slug: "engineering", name: "Engineering", color: null, icon: null }],
          teamSlugs: ["engineering"],
          visibility: {
            everyone: false,
            teams: [{ id: "team-1", slug: "engineering", name: "Engineering", color: null, icon: null }],
          },
        }),
        skill({ id: "other-skill", ownerId: "user-2", owner: { ...skill({}).owner, id: "user-2", userId: "user-2", name: "Grace Hopper" } }),
      ],
      initialLocalSkills: localSkills,
      initialFilterPreferences: { active_filters: [{ type: "starred", value: "true" }], custom_views: [] },
      me,
      teams,
      orgs: [currentOrg],
      currentOrg,
      initialRoute,
      initialRouteSource: initialRoute.kind === "all" ? "default" : "explicit",
    }),
  );
}

describe("SkillsApp initial route", () => {
  it("renders My skills from the initial route instead of saved filters", () => {
    const html = render({ kind: "mine" });
    expect(html).toContain("My skills");
    expect(html).toContain("owned-skill");
    expect(html).toContain("team-skill");
    expect(html).not.toContain("other-skill");
  });

  it("renders a team route from the initial route", () => {
    const html = render({ kind: "team", team: "engineering" });
    expect(html).toContain("team-skill");
    expect(html).not.toContain("owned-skill");
  });

  it("renders Companion skills from the initial route", () => {
    const html = render({ kind: "local" });
    expect(html).toContain("Companion skills");
    expect(html).toContain("Manage skills locally.");
  });

  it("falls back to workspace skills for an unknown team route", () => {
    const html = render({ kind: "team", team: "missing" });
    expect(html).toContain("owned-skill");
    expect(html).toContain("team-skill");
    expect(html).toContain("other-skill");
  });
});
