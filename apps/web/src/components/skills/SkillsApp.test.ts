// @vitest-environment happy-dom

import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SkillsApp } from "./SkillsApp";
import { parseSkillsRoute } from "./route";
import type { LabelsResponse, LocalSkillRow, SkillListRow } from "@companion/contracts";
import type { MeVM, OrgVM, SkillVM } from "@/lib/types";

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
  toggleStar: vi.fn(),
  validateSkillPackage: vi.fn(),
  // Label RPCs (org-wide shared folders).
  fetchSkillLabels: vi.fn(),
  assignSkillLabel: vi.fn(),
  unassignSkillLabel: vi.fn(),
  createLabel: vi.fn(),
  renameLabel: vi.fn(),
  deleteLabel: vi.fn(),
  setLabelColor: vi.fn(),
  setLabelIcon: vi.fn(),
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

function skill(overrides: Partial<SkillVM> & { id: string }): SkillVM {
  return {
    uuid: "skill-" + overrides.id,
    version: "1.0.0",
    validation: "valid",
    description: "Test skill",
    error: null,
    labels: [],
    authorId: "user-1",
    authorName: "Ada Lovelace",
    authorInitials: "AL",
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
    labels: vm.labels,
    creator_id: vm.authorId,
    creator_name: vm.authorName,
    creator_initials: vm.authorInitials,
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
    installed: vm.installStatus !== "none",
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

// A non-trivial seeded skill set + label tree:
//   - marketing/seo  -> seo-helper (filed in marketing/seo) + brand-kit (filed in marketing only)
//   - growth         -> explicit EMPTY folder (a `labels` row, no skill filed)
//   - loose-skill    -> filed nowhere (No-folder)
function seededSkills(): SkillVM[] {
  return [
    skill({ id: "seo-helper", labels: ["marketing/seo"] }),
    skill({ id: "brand-kit", labels: ["marketing"] }),
    skill({ id: "loose-skill" }),
  ];
}

const seededLabels: LabelsResponse = {
  tree: [],
  // `growth` is an explicit empty folder; the marketing/* paths are derived from assignments but we
  // also include the explicit `marketing` appearance so its color/icon would survive.
  flat: [{ path: "growth", color: null, icon: null }],
};

function emptyLabels(): LabelsResponse {
  return { tree: [], flat: [] };
}

function routeSourceFor(initialRoute: React.ComponentProps<typeof SkillsApp>["initialRoute"]) {
  return initialRoute.kind === "all" && !initialRoute.skill ? "default" : "explicit";
}

function appProps(
  initialRoute: React.ComponentProps<typeof SkillsApp>["initialRoute"],
  overrides: Partial<React.ComponentProps<typeof SkillsApp>> = {},
): React.ComponentProps<typeof SkillsApp> {
  return {
    initialSkills: seededSkills(),
    initialLocalSkills: localSkills,
    // Default to no saved chips so the route selection alone drives the list; individual tests pass
    // their own `initialFilterPreferences` to exercise the saved-filter behavior.
    initialFilterPreferences: { active_filters: [] },
    initialLabels: seededLabels,
    me,
    orgs: [currentOrg],
    currentOrg,
    initialRoute,
    initialRouteSource: routeSourceFor(initialRoute),
    ...overrides,
  };
}

function render(
  initialRoute: React.ComponentProps<typeof SkillsApp>["initialRoute"],
  overrides: Partial<React.ComponentProps<typeof SkillsApp>> = {},
) {
  return renderToString(React.createElement(SkillsApp, appProps(initialRoute, overrides)));
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

function findButton(container: HTMLElement, label: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll("button")).find(
    (node) =>
      node.getAttribute("aria-label") === label ||
      node.getAttribute("title") === label ||
      node.textContent?.trim() === label,
  );
  if (!button) throw new Error(`Could not find button: ${label}`);
  return button;
}

function clickButton(container: HTMLElement, label: string) {
  const button = findButton(container, label);
  act(() => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

// React tracks the input value via the native setter; bypassing it (plain `.value =`) makes the
// synthetic onChange ignore the update. Use the prototype setter so onChange fires.
function setReactInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
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
  queryMocks.toggleStar.mockResolvedValue(true);
  queryMocks.validateSkillPackage.mockResolvedValue({ result: { ok: true }, dependencyPlan: null });
  queryMocks.fetchSkillLabels.mockResolvedValue(emptyLabels());
  queryMocks.assignSkillLabel.mockResolvedValue(undefined);
  queryMocks.unassignSkillLabel.mockResolvedValue(undefined);
  queryMocks.createLabel.mockResolvedValue(undefined);
  queryMocks.renameLabel.mockResolvedValue(undefined);
  queryMocks.deleteLabel.mockResolvedValue(undefined);
  queryMocks.setLabelColor.mockResolvedValue(undefined);
  queryMocks.setLabelIcon.mockResolvedValue(undefined);
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
  it("renders All skills (every org skill, ignoring saved filters) from the default route", () => {
    const html = render({ kind: "all" });
    expect(html).toContain("All skills");
    expect(html).toContain("seo-helper");
    expect(html).toContain("brand-kit");
    expect(html).toContain("loose-skill");
  });

  it("renders the Starred view from the initial route", () => {
    const html = render({ kind: "starred", skill: undefined }, {
      initialSkills: [
        skill({ id: "seo-helper", labels: ["marketing/seo"], starred: true }),
        skill({ id: "brand-kit", labels: ["marketing"] }),
      ],
    });
    expect(html).toContain("Starred");
    expect(html).toContain("seo-helper");
    expect(html).not.toContain("brand-kit");
  });

  it("renders the No-folder view from the initial route", () => {
    const html = render({ kind: "nolabel" });
    // Only the skill filed in no folder shows.
    expect(html).toContain("loose-skill");
    expect(html).not.toContain("Open skill seo-helper");
    expect(html).not.toContain("Open skill brand-kit");
  });

  it("renders a label folder route (skills filed under the path or any descendant)", () => {
    const html = render({ kind: "label", label: "marketing" });
    // marketing rolls up both its own skill and the marketing/seo descendant.
    expect(html).toContain("seo-helper");
    expect(html).toContain("brand-kit");
    expect(html).not.toContain("Open skill loose-skill");
  });

  it("narrows to a nested label path", () => {
    const html = render({ kind: "label", label: "marketing/seo" });
    expect(html).toContain("seo-helper");
    expect(html).not.toContain("Open skill brand-kit");
    expect(html).not.toContain("Open skill loose-skill");
  });

  it("falls back to All skills for an unknown label route", () => {
    const html = render({ kind: "label", label: "does-not-exist" });
    expect(html).toContain("No skills match");
  });

  it("renders Companion skills from the initial route", () => {
    const html = render({ kind: "local" });
    expect(html).toContain("Companion skills");
    expect(html).toContain("Manage skills locally.");
  });

  it("renders a skill detail from a workspace skill route instead of saved filters", () => {
    const html = render({ kind: "all", skill: "seo-helper" });
    expect(html).toContain("Install skill");
    expect(html).toContain("seo-helper");
    expect(html).not.toContain("No skills match");
  });

  it("renders a skill detail while preserving its label route", () => {
    const html = render({ kind: "label", label: "marketing/seo", skill: "seo-helper" });
    expect(html).toContain("Install skill");
    expect(html).toContain("seo-helper");
    expect(html).toContain("Filed in");
    expect(html).not.toContain("Open skill brand-kit");
  });

  it("ignores skill detail on the Companion skills route", () => {
    const html = render(parseSkillsRoute("view=local&skill=seo-helper"));
    expect(html).toContain("Companion skills");
    expect(html).toContain("Manage skills locally.");
    expect(html).not.toContain("Install skill");
  });
});

describe("SkillsApp sidebar label tree derivation", () => {
  // The sidebar tree is derived in the client from skills + explicit labels; assertions read the
  // rendered label rows (leaf name + roll-up count + chevron presence).
  function labelRow(container: HTMLElement, path: string): HTMLElement {
    const more = container.querySelector<HTMLElement>(`button[aria-label="${path} options"]`);
    const row = more?.closest<HTMLElement>(".lblrow");
    if (!row) throw new Error(`Could not find label row for path: ${path}`);
    return row;
  }
  function rowCount(row: HTMLElement): string {
    return row.querySelector(".lblrow__count")?.textContent?.trim() ?? "";
  }

  it("derives intermediate parents and de-duped roll-up counts", async () => {
    const { container } = await mountSkillsApp({ kind: "all" });
    await flushEffects();

    // `marketing` is derived as a parent (only `marketing/seo` + `marketing` are assigned).
    const marketing = labelRow(container, "marketing");
    // Roll-up: brand-kit (marketing) + seo-helper (marketing/seo) = 2, de-duped per skill.
    expect(rowCount(marketing)).toBe("2");
    // The derived parent has children, so it gets a chevron.
    expect(marketing.querySelector(".lblrow__chev:not(.lblrow__chev--leaf)")).not.toBeNull();
    expect(marketing.querySelector(".lblrow__name")?.textContent?.trim()).toBe("marketing");
  });

  it("gates child rows behind their collapsed parent (chevron expand)", async () => {
    const { container } = await mountSkillsApp({ kind: "all" });
    await flushEffects();

    // marketing/seo is a child of marketing; collapsed by default, so its row is hidden.
    expect(container.querySelector('button[aria-label="marketing/seo options"]')).toBeNull();

    // Expanding marketing reveals the child.
    const marketing = labelRow(container, "marketing");
    const chevron = marketing.querySelector<HTMLButtonElement>(".lblrow__chev:not(.lblrow__chev--leaf)");
    act(() => chevron!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flushEffects();

    const seo = labelRow(container, "marketing/seo");
    expect(seo.querySelector(".lblrow__name")?.textContent?.trim()).toBe("seo");
    expect(rowCount(seo)).toBe("1");
    // The leaf has no children: a leaf chevron placeholder, not an expand button.
    expect(seo.querySelector(".lblrow__chev--leaf")).not.toBeNull();
  });

  it("renders an explicit empty folder (a `labels` row with no skills) with a zero count", async () => {
    const { container } = await mountSkillsApp({ kind: "all" });
    await flushEffects();

    const growth = labelRow(container, "growth");
    expect(growth.querySelector(".lblrow__name")?.textContent?.trim()).toBe("growth");
    expect(rowCount(growth)).toBe("0");
    // Empty leaf folder: no chevron expand button.
    expect(growth.querySelector(".lblrow__chev--leaf")).not.toBeNull();
  });

  it("reflects All skills / Starred counts in the sidebar", async () => {
    const { container } = await mountSkillsApp({ kind: "all" }, {
      props: {
        initialSkills: [
          skill({ id: "seo-helper", labels: ["marketing/seo"], starred: true }),
          skill({ id: "brand-kit", labels: ["marketing"] }),
          skill({ id: "loose-skill" }),
        ],
      },
    });
    await flushEffects();

    const all = findButton(container, "All skills");
    expect(all.querySelector(".navitem__count")?.textContent?.trim()).toBe("3");
    const starred = findButton(container, "Starred skills");
    expect(starred.querySelector(".navitem__count")?.textContent?.trim()).toBe("1");
  });
});

describe("SkillsApp optimistic label assignment", () => {
  it("fires exactly one unassign RPC per detail toggle and keeps the detail open (StrictMode-safe)", async () => {
    // From the All-skills scope the skill stays in view after unfiling, so the detail does not close.
    const { container } = await mountSkillsApp(
      { kind: "all", skill: "seo-helper" },
      { url: "/skills?skill=seo-helper" },
    );
    await flushEffects();
    expect(container.textContent).toContain("Install skill");
    expect(container.textContent).toContain("Filed in");
    expect(container.querySelector('button[aria-label="Remove from marketing/seo"]')).not.toBeNull();

    // The "Filed in" chip exposes a remove control per filed folder.
    clickButton(container, "Remove from marketing/seo");
    await flushEffects();

    // Exactly one RPC, the optimistic state removed the chip, and the detail stays open (no refresh).
    expect(queryMocks.unassignSkillLabel).toHaveBeenCalledTimes(1);
    expect(queryMocks.unassignSkillLabel).toHaveBeenCalledWith("seo-helper", "marketing/seo");
    expect(queryMocks.assignSkillLabel).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Install skill");
    expect(container.textContent).toContain("No folders yet");
    expect(container.querySelector('button[aria-label="Remove from marketing/seo"]')).toBeNull();
  });

  it("reverts the optimistic toggle and keeps the detail open when the RPC fails", async () => {
    queryMocks.unassignSkillLabel.mockRejectedValueOnce(new Error("nope"));
    const { container } = await mountSkillsApp(
      { kind: "all", skill: "seo-helper" },
      { url: "/skills?skill=seo-helper" },
    );
    await flushEffects();

    clickButton(container, "Remove from marketing/seo");
    await flushEffects();

    expect(queryMocks.unassignSkillLabel).toHaveBeenCalledTimes(1);
    // The chip is restored after the failure; the detail never closed.
    expect(container.textContent).toContain("Install skill");
    expect(container.querySelector('button[aria-label="Remove from marketing/seo"]')).not.toBeNull();
  });
});

describe("SkillsApp navigation", () => {
  it("preserves unsaved filters when browser Back closes a pushed detail", async () => {
    const { container } = await mountSkillsApp({ kind: "all" });
    await flushEffects();
    // The default route ignores the saved starred filter, so every skill shows.
    expect(container.textContent).toContain("loose-skill");

    clickButton(container, "Open skill loose-skill");
    await flushEffects();
    expect(window.location.search).toBe("?skill=loose-skill");
    expect(container.textContent).toContain("Install skill");

    window.history.replaceState({}, "", "/skills");
    await act(async () => {
      window.dispatchEvent(new PopStateEvent("popstate"));
    });

    expect(window.location.search).toBe("");
    expect(container.textContent).toContain("loose-skill");
    expect(container.textContent).not.toContain("Install skill");
  });

  it("persists a label folder in the URL when opening a skill under it", async () => {
    const { container } = await mountSkillsApp(
      { kind: "label", label: "marketing/seo" },
      { url: "/skills?view=label&label=marketing%2Fseo" },
    );
    await flushEffects();

    clickButton(container, "Open skill seo-helper");
    await flushEffects();

    expect(window.location.search).toBe("?view=label&label=marketing%2Fseo&skill=seo-helper");
    expect(container.textContent).toContain("Install skill");
  });

  it("falls back to replacing the URL when closing a directly loaded detail", async () => {
    const { container } = await mountSkillsApp(
      { kind: "all", skill: "seo-helper" },
      { url: "/skills?skill=seo-helper" },
    );
    await flushEffects();
    expect(container.textContent).toContain("Install skill");

    clickButton(container, "Skills");
    await flushEffects();

    expect(window.location.pathname + window.location.search).toBe("/skills");
    expect(container.textContent).toContain("seo-helper");
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
});

describe("SkillsApp label folder creation", () => {
  it("creates an empty folder from the org-root input and selects it (one createLabel RPC)", async () => {
    const { container } = await mountSkillsApp({ kind: "all" });
    await flushEffects();

    clickButton(container, "New folder");
    await flushEffects();

    const input = container.querySelector<HTMLInputElement>('input[aria-label="New folder path"]');
    expect(input).not.toBeNull();
    setReactInputValue(input!, "campaigns");
    await flushEffects();
    act(() => {
      input!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await flushEffects();

    expect(queryMocks.createLabel).toHaveBeenCalledTimes(1);
    expect(queryMocks.createLabel).toHaveBeenCalledWith("campaigns");
    // The new folder is selected (its scope is now the active label route).
    expect(window.location.search).toBe("?view=label&label=campaigns");
  });

  it("rewrites the URL when renaming the active folder, preserving the open skill", async () => {
    const { container } = await mountSkillsApp(
      { kind: "label", label: "marketing/seo" },
      { url: "/skills?view=label&label=marketing%2Fseo" },
    );
    await flushEffects();

    // Open a skill under the active folder so the route carries both label + skill.
    clickButton(container, "Open skill seo-helper");
    await flushEffects();
    expect(window.location.search).toBe("?view=label&label=marketing%2Fseo&skill=seo-helper");

    // Rename the active leaf folder (marketing/seo → marketing/growth) via its options menu.
    clickButton(container, "marketing/seo options");
    await flushEffects();
    clickButton(container, "Rename");
    await flushEffects();
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Rename folder"]');
    expect(input).not.toBeNull();
    setReactInputValue(input!, "growth");
    await flushEffects();
    act(() => {
      input!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await flushEffects();

    expect(queryMocks.renameLabel).toHaveBeenCalledWith("marketing/seo", "marketing/growth");
    // The URL round-trips the new path and keeps the detail open (reload re-opens the same skill).
    expect(window.location.search).toBe("?view=label&label=marketing%2Fgrowth&skill=seo-helper");
  });
});
