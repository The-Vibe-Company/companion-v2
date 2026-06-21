// @vitest-environment happy-dom

import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SkillsApp } from "./SkillsApp";
import { parseSkillsRoute } from "./route";
import type { LocalSkillRow, SkillListRow } from "@companion/contracts";
import type { MeVM, OrgVM, SkillVM, TeamVM } from "@/lib/types";

const queryMocks = vi.hoisted(() => ({
  fetchArchivedSkills: vi.fn(),
  fetchSkillDetail: vi.fn(),
  fetchSkillDependencies: vi.fn(),
  fetchSkillDownloadUrl: vi.fn(),
  fetchSkillVersionFiles: vi.fn(),
  addComment: vi.fn(),
  archiveSkill: vi.fn(),
  createSkillInline: vi.fn(),
  issueToken: vi.fn(),
  markSkillInstalled: vi.fn(),
  markSkillUninstalled: vi.fn(),
  publishSkillPackage: vi.fn(),
  restoreSkill: vi.fn(),
  saveSkillFilterPreferences: vi.fn(),
  setCommentDeprecated: vi.fn(),
  setSkillVisibility: vi.fn(),
  toggleStar: vi.fn(),
  validateSkillPackage: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
}));

vi.mock("@/lib/queries", () => ({
  apiBase: () => "http://127.0.0.1:3001",
  versionPackageUrl: (slug: string, version: string) => `/v1/skills/${slug}/versions/${version}/package`,
  ...queryMocks,
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
    requirements: [],
    compatibility: null,
    metadata: {},
    size: "1 KB",
    license: "MIT",
    checksum: null,
    created: "Jun 1, 2026",
    updated: "just now",
    stars: 0,
    starred: false,
    installStatus: "none",
    installedVersion: null,
    teams: [],
    teamSlugs: [],
    requiresCount: 0,
    usedByCount: 0,
    depWarn: false,
    archived: false,
    ...overrides,
  };
}

function skillRowFromVM(vm: SkillVM): SkillListRow {
  return {
    id: vm.uuid,
    slug: vm.id,
    org_id: currentOrg.id,
    owner_id: vm.ownerId,
    owner_kind: vm.owner.kind,
    owner_user_id: vm.owner.userId,
    owner_team_id: vm.owner.teamId,
    owner_name: vm.owner.name,
    owner_initials: vm.owner.initials,
    owner_handle: vm.owner.handle,
    visibility: vm.visibility,
    current_version: vm.version,
    validation: vm.validation,
    description: vm.description,
    display: vm.display ?? {},
    validation_error: vm.error,
    tools: vm.tools,
    requirements: vm.requirements,
    compatibility: vm.compatibility,
    metadata: vm.metadata,
    size_bytes: 1024,
    license: vm.license,
    checksum: vm.checksum,
    created_at: "2026-06-01T00:00:00.000Z",
    updated_at: "2026-06-21T00:00:00.000Z",
    star_count: vm.stars,
    starred: vm.starred,
    install_status: vm.installStatus,
    installed_version: vm.installedVersion,
    requires_count: vm.requiresCount,
    used_by_count: vm.usedByCount,
    dep_warn: vm.depWarn,
    archived: vm.archived,
    referenced: vm.referenced ?? false,
  } as SkillListRow;
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

function routeSourceFor(initialRoute: React.ComponentProps<typeof SkillsApp>["initialRoute"]) {
  return initialRoute.kind === "all" && !initialRoute.skill ? "default" : "explicit";
}

function appProps(
  initialRoute: React.ComponentProps<typeof SkillsApp>["initialRoute"],
  overrides: Partial<React.ComponentProps<typeof SkillsApp>> = {},
): React.ComponentProps<typeof SkillsApp> {
  const initialSkills = [
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
  ];
  return {
    initialSkills,
    initialLocalSkills: localSkills,
    initialFilterPreferences: { active_filters: [{ type: "starred", value: "true" }], custom_views: [] },
    me,
    teams,
    orgs: [currentOrg],
    currentOrg,
    initialRoute,
    initialRouteSource: routeSourceFor(initialRoute),
    ...overrides,
  };
}

function render(initialRoute: React.ComponentProps<typeof SkillsApp>["initialRoute"]) {
  return renderToString(
    React.createElement(SkillsApp, appProps(initialRoute)),
  );
}

async function mountSkillsApp(
  initialRoute: React.ComponentProps<typeof SkillsApp>["initialRoute"],
  opts: {
    url?: string;
    routeSource?: React.ComponentProps<typeof SkillsApp>["initialRouteSource"];
    props?: Partial<React.ComponentProps<typeof SkillsApp>>;
  } = {},
) {
  window.history.replaceState({}, "", opts.url ?? "/skills");
  window.matchMedia = vi.fn().mockReturnValue({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mountedRoots.push(root);
  await act(async () => {
    root.render(
      React.createElement(SkillsApp, {
        ...appProps(initialRoute, opts.props),
        initialRouteSource: opts.routeSource ?? routeSourceFor(initialRoute),
      }),
    );
  });
  return { container, root };
}

function clickButton(container: HTMLElement, label: string) {
  const button = Array.from(container.querySelectorAll("button")).find(
    (node) => node.getAttribute("aria-label") === label || node.textContent?.trim() === label,
  );
  if (!button) throw new Error(`Could not find button: ${label}`);
  act(() => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

async function flushEffects() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

let mountedRoots: Root[] = [];

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  queryMocks.fetchArchivedSkills.mockResolvedValue([]);
  queryMocks.fetchSkillDetail.mockResolvedValue({ versions: [], comments: [], frontmatter: null });
  queryMocks.fetchSkillDependencies.mockResolvedValue(null);
  queryMocks.fetchSkillDownloadUrl.mockResolvedValue("/download");
  queryMocks.fetchSkillVersionFiles.mockResolvedValue({ files: [] });
  queryMocks.addComment.mockResolvedValue(null);
  queryMocks.archiveSkill.mockResolvedValue(undefined);
  queryMocks.createSkillInline.mockResolvedValue({});
  queryMocks.issueToken.mockResolvedValue({ token: "cmp_pat_test", id: "token-1", name: "Test" });
  queryMocks.markSkillInstalled.mockResolvedValue({ installed: true, status: "installed", installed_version: "1.0.0" });
  queryMocks.markSkillUninstalled.mockResolvedValue({ installed: false });
  queryMocks.publishSkillPackage.mockResolvedValue({});
  queryMocks.restoreSkill.mockResolvedValue(undefined);
  queryMocks.saveSkillFilterPreferences.mockResolvedValue(undefined);
  queryMocks.setCommentDeprecated.mockResolvedValue(null);
  queryMocks.setSkillVisibility.mockResolvedValue({ cascaded: [] });
  queryMocks.toggleStar.mockResolvedValue(true);
  queryMocks.validateSkillPackage.mockResolvedValue({ result: { ok: true }, dependencyPlan: null });
  mountedRoots = [];
});

afterEach(() => {
  for (const root of mountedRoots) {
    act(() => root.unmount());
  }
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

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

  it("renders a skill detail from a workspace skill route instead of saved filters", () => {
    const html = render({ kind: "all", skill: "owned-skill" });
    expect(html).toContain("Install skill");
    expect(html).toContain("owned-skill");
    expect(html).not.toContain("No skills match");
  });

  it("renders a team skill detail while preserving the team route", () => {
    const html = render({ kind: "team", team: "engineering", skill: "team-skill" });
    expect(html).toContain("Install skill");
    expect(html).toContain("team-skill");
    expect(html).not.toContain("owned-skill");
  });

  it("preserves a skill detail when an unknown team route falls back to workspace skills", () => {
    const html = render({ kind: "team", team: "missing", skill: "other-skill" });
    expect(html).toContain("Install skill");
    expect(html).toContain("other-skill");
    expect(html).not.toContain("owned-skill");
  });

  it("ignores skill detail on the Companion skills route", () => {
    const html = render(parseSkillsRoute("view=local&skill=owned-skill"));
    expect(html).toContain("Companion skills");
    expect(html).toContain("Manage skills locally.");
    expect(html).not.toContain("Install skill");
  });

  it("preserves unsaved filters when browser Back closes a pushed detail", async () => {
    const { container } = await mountSkillsApp({ kind: "all" });
    expect(container.textContent).toContain("No skills match");

    clickButton(container, "Clear");
    await flushEffects();
    expect(container.textContent).toContain("owned-skill");

    clickButton(container, "Open skill owned-skill");
    await flushEffects();
    expect(window.location.search).toBe("?skill=owned-skill");
    expect(container.textContent).toContain("Install skill");

    window.history.replaceState({}, "", "/skills");
    await act(async () => {
      window.dispatchEvent(new PopStateEvent("popstate"));
    });

    expect(window.location.search).toBe("");
    expect(container.textContent).toContain("owned-skill");
    expect(container.textContent).not.toContain("No skills match");
  });

  it("uses browser history when the in-page back closes a pushed detail", async () => {
    const { container } = await mountSkillsApp({ kind: "all" }, { routeSource: "explicit" });
    clickButton(container, "Open skill owned-skill");
    await flushEffects();

    const backSpy = vi.spyOn(window.history, "back").mockImplementation(() => {});
    clickButton(container, "Skills");

    expect(backSpy).toHaveBeenCalledTimes(1);
    expect(window.location.search).toBe("?skill=owned-skill");
  });

  it("falls back to replacing the URL when closing a directly loaded detail", async () => {
    const { container } = await mountSkillsApp(
      { kind: "all", skill: "owned-skill" },
      { url: "/skills?skill=owned-skill" },
    );
    await flushEffects();
    expect(container.textContent).toContain("Install skill");

    clickButton(container, "Skills");
    await flushEffects();

    expect(window.location.pathname + window.location.search).toBe("/skills");
    expect(container.textContent).toContain("owned-skill");
    expect(container.textContent).not.toContain("Install skill");
  });

  it("opens an archived detail after the archived list loads", async () => {
    const archived = skill({
      id: "html-export",
      archived: true,
      referenced: true,
      usedByCount: 1,
      validation: "valid",
    });
    queryMocks.fetchArchivedSkills.mockResolvedValue([skillRowFromVM(archived)]);

    const { container } = await mountSkillsApp(
      { kind: "archived", skill: "html-export" },
      { url: "/skills?view=archived&skill=html-export" },
    );
    await flushEffects();

    expect(window.location.search).toBe("?view=archived&skill=html-export");
    expect(container.textContent).toContain("html-export");
    expect(container.textContent).toContain("Restore");
  });

  it("clears a missing archived skill after archived loading completes", async () => {
    queryMocks.fetchArchivedSkills.mockResolvedValue([]);

    const { container } = await mountSkillsApp(
      { kind: "archived", skill: "missing-skill" },
      { url: "/skills?view=archived&skill=missing-skill" },
    );
    await flushEffects();

    expect(window.location.search).toBe("?view=archived");
    expect(container.textContent).toContain("Archived skills");
    expect(container.textContent).not.toContain("missing-skill");
  });

  it("preserves the open skill when a team slug changes", async () => {
    const { container } = await mountSkillsApp(
      { kind: "team", team: "engineering", skill: "team-skill" },
      { url: "/skills?view=team&team=engineering&skill=team-skill" },
    );
    await flushEffects();

    expect(container.textContent).toContain("team-skill");
    act(() => {
      window.dispatchEvent(
        new CustomEvent("companion:team-updated", {
          detail: {
            id: "team-1",
            slug: "platform",
            name: "Platform",
            color: null,
            icon: null,
          },
        }),
      );
    });

    expect(window.location.search).toBe("?view=team&team=platform&skill=team-skill");
  });
});
