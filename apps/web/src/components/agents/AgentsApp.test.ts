// @vitest-environment happy-dom

import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AgentDetail,
  AgentListRow,
  AgentModelsResponse,
  AgentsListResponse,
  ProvisionProgress,
} from "@companion/contracts";
import { AgentsApp } from "./AgentsApp";
import type { MeVM, OrgVM } from "@/lib/types";

const agentQueryMocks = vi.hoisted(() => ({
  fetchAgents: vi.fn(),
  fetchAgent: vi.fn(),
  fetchProvision: vi.fn(),
  createAgent: vi.fn(),
  retryProvision: vi.fn(),
  setAgentSecrets: vi.fn(),
  pauseAgent: vi.fn(),
  wakeAgent: vi.fn(),
  destroyAgent: vi.fn(),
  pushAgentSkill: vi.fn(),
  fetchAgentModels: vi.fn(),
}));

vi.mock("@/lib/agentQueries", () => agentQueryMocks);

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
}));

const me: MeVM = { id: "user-1", name: "Ada Lovelace", email: "ada@example.com", initials: "AL", avatarUrl: null };
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

function agentRow({ slug, ...overrides }: Partial<AgentListRow> & { slug: string }): AgentListRow {
  return {
    id: "agent-" + slug,
    org_id: currentOrg.id,
    slug,
    scope: "personal",
    creator_id: me.id,
    client_label: "TVC",
    group_label: null,
    description: "Test agent",
    model: "openai/gpt-5.5",
    region: "cdg1",
    lifecycle: "ready",
    status: "running",
    sandbox_name: "sb-01jb2k",
    skills: [],
    outdated_count: 0,
    sessions_count: 0,
    pending_op: null,
    last_active_at: "2026-07-03T00:00:00.000Z",
    created_at: "2026-06-01T00:00:00.000Z",
    ...overrides,
  };
}

function agentDetailRow(overrides: Partial<AgentDetail> & { slug: string }): AgentDetail {
  return {
    ...agentRow({ slug: overrides.slug }),
    instructions: "Keep it short.",
    sandbox_id: "sb-internal",
    golden_snapshot_id: null,
    opencode_version: null,
    last_resume_ms: null,
    provision: { attempt: 1, steps: [], error: null },
    secrets: [],
    sessions: [],
    ...overrides,
  };
}

function listResponse(agents: AgentListRow[]): AgentsListResponse {
  return {
    agents,
    summary: {
      total: agents.length,
      running: agents.filter((a) => a.status === "running").length,
      sleeping: agents.filter((a) => a.status === "sleeping").length,
      provisioning: agents.filter((a) => a.status === "provisioning").length,
      error: agents.filter((a) => a.status === "error").length,
      outdated: agents.filter((a) => a.outdated_count > 0).length,
    },
    updates: [],
  };
}

const models: AgentModelsResponse = {
  models: [
    {
      id: "openai/gpt-5.5",
      provider: "openai",
      provider_name: "OpenAI",
      name: "GPT-5.5",
      description: "fast, tool-reliable",
      context: 200_000,
      cost_input: null,
      cost_output: null,
      env_keys: ["OPENAI_API_KEY"],
    },
  ],
  providers: [{ id: "openai", name: "OpenAI", env_keys: ["OPENAI_API_KEY"], connected: true }],
};

const PROVISIONING_PROGRESS: ProvisionProgress = {
  lifecycle: "provisioning",
  status: "provisioning",
  attempt: 1,
  steps: [
    { key: "fork", label: "Fork snapshot", detail: "golden-snap-08 → sb-01jb2k", state: "done", duration_ms: 1200 },
    { key: "push", label: "Push 2 skills", detail: "meeting-digest@1.3.0, seo-helper@1.0.0", state: "running", duration_ms: null },
    { key: "serve", label: "Start server", detail: "opencode serve --port 4096", state: "pending", duration_ms: null },
    { key: "health", label: "Health check", detail: "GET /health → 200", state: "pending", duration_ms: null },
  ],
  error: null,
};

function appProps(
  initialRoute: React.ComponentProps<typeof AgentsApp>["initialRoute"],
  overrides: Partial<React.ComponentProps<typeof AgentsApp>> = {},
): React.ComponentProps<typeof AgentsApp> {
  return {
    initialRoute,
    initialMineAgents: listResponse([
      agentRow({ slug: "mail-digest", description: "Summarizes the shared inbox." }),
      agentRow({ slug: "ops-runner", status: "sleeping", last_active_at: "2026-07-01T00:00:00.000Z" }),
    ]),
    initialOrgAgents: listResponse([]),
    initialModels: models,
    registrySkills: [],
    mineSkills: [],
    orgSkills: [],
    initialPersonalLabels: { tree: [], flat: [] },
    initialLabels: { tree: [], flat: [] },
    me,
    orgs: [currentOrg],
    currentOrg,
    appOrigin: "http://test.local",
    ...overrides,
  };
}

let mountedRoots: Root[] = [];

async function mountAgentsApp(
  initialRoute: React.ComponentProps<typeof AgentsApp>["initialRoute"],
  opts: { url?: string; props?: Partial<React.ComponentProps<typeof AgentsApp>> } = {},
) {
  window.history.replaceState({}, "", opts.url ?? "/agents");
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
    root.render(React.createElement(AgentsApp, appProps(initialRoute, opts.props)));
  });
  await flushEffects();
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

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  agentQueryMocks.fetchAgent.mockResolvedValue(agentDetailRow({ slug: "mail-digest" }));
  agentQueryMocks.fetchProvision.mockResolvedValue(PROVISIONING_PROGRESS);
});

afterEach(async () => {
  for (const root of mountedRoots) {
    await act(async () => root.unmount());
  }
  mountedRoots = [];
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

describe("AgentsApp list route", () => {
  it("renders the fleet rows, the summary line, and the sidebar Agents roots", async () => {
    const { container } = await mountAgentsApp({ lib: "mine", kind: "list" });

    // Rows + the mono summary line derived from the library counts.
    expect(findButton(container, "Open agent mail-digest")).toBeTruthy();
    expect(findButton(container, "Open agent ops-runner")).toBeTruthy();
    expect(container.textContent).toContain("Summarizes the shared inbox.");
    expect(container.textContent).toContain("Running 1 · Sleeping 1 · Outdated 0 · Errors 0");

    // Sidebar: the "My Companions" library exposes an Agents root carrying the fleet count.
    expect(findButton(container, "My Companions")).toBeTruthy();
    const agentsRoot = findButton(container, "My Companions agents");
    expect(agentsRoot.querySelector(".lblrow__count")?.textContent).toContain("2");
  });
});

describe("AgentsApp detail route", () => {
  it("renders the provisioning card steps while the agent provisions", async () => {
    const provisioning = agentRow({ slug: "herald", status: "provisioning", lifecycle: "provisioning", last_active_at: null });
    agentQueryMocks.fetchAgent.mockResolvedValue(
      agentDetailRow({
        slug: "herald",
        status: "provisioning",
        lifecycle: "provisioning",
        provision: { attempt: 1, steps: PROVISIONING_PROGRESS.steps, error: null },
      }),
    );

    const { container } = await mountAgentsApp(
      { lib: "mine", kind: "detail", agent: "herald" },
      {
        url: "/agents?agent=herald",
        props: { initialMineAgents: listResponse([provisioning]) },
      },
    );

    expect(container.querySelector('[data-screen-label="Provisioning"]')).toBeTruthy();
    expect(container.textContent).toContain("herald");
    expect(container.textContent).toContain("Fork snapshot");
    expect(container.textContent).toContain("Push 2 skills");
    expect(container.textContent).toContain("Start server");
    expect(container.textContent).toContain("Health check");
    expect(container.textContent).toContain("1.2s");
    expect(agentQueryMocks.fetchProvision).toHaveBeenCalledWith("herald");
  });

  it("renders the Chat URL section and the Properties rail for a ready agent", async () => {
    agentQueryMocks.fetchAgent.mockResolvedValue(
      agentDetailRow({
        slug: "mail-digest",
        secrets: [{ key: "NOTION_TOKEN", set: true, required_by: ["meeting-digest"], required: true }],
      }),
    );

    const { container } = await mountAgentsApp(
      { lib: "mine", kind: "detail", agent: "mail-digest" },
      { url: "/agents?agent=mail-digest" },
    );

    expect(container.querySelector('[data-screen-label="Agent detail"]')).toBeTruthy();
    expect(container.textContent).toContain("Chat URL");
    expect(container.textContent).toContain("http://test.local/agents/mail-digest/chat");
    expect(container.textContent).toContain("Properties");
    expect(container.textContent).toContain("NOTION_TOKEN");
    expect(container.textContent).toContain("cdg1");
    expect(agentQueryMocks.fetchProvision).not.toHaveBeenCalled();
  });

  it("keeps Destroy disabled until the exact agent name is typed", async () => {
    const { container } = await mountAgentsApp(
      { lib: "mine", kind: "detail", agent: "mail-digest" },
      { url: "/agents?agent=mail-digest" },
    );

    const destroy = findButton(container, "Destroy agent");
    expect(destroy.disabled).toBe(true);

    const confirm = container.querySelector<HTMLInputElement>('input[aria-label="Type the agent name to confirm"]');
    if (!confirm) throw new Error("Could not find the destroy confirmation input");

    setReactInputValue(confirm, "mail-diges");
    expect(findButton(container, "Destroy agent").disabled).toBe(true);

    setReactInputValue(confirm, "mail-digest");
    expect(findButton(container, "Destroy agent").disabled).toBe(false);
  });
});
