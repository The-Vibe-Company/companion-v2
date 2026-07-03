import { describe, expect, it } from "vitest";
import type { AgentModelRow, AgentModelsResponse } from "@companion/contracts";
import type { AgentVM, SkillVM } from "@/lib/types";
import {
  agentCounts,
  deriveAgentNav,
  deriveSecretRows,
  deriveUpdateNotices,
  filterAgents,
  filterModelGroups,
  firstConnectedModel,
  groupLabelMeta,
  groupModelsByProvider,
  kebabName,
  modelProviderConnected,
  outdatedSkills,
  statusBadge,
  statusDot,
  summaryLine,
  toModelProviders,
  validateSecretKey,
} from "./derive";

function agent(overrides: Partial<AgentVM>): AgentVM {
  return {
    uuid: "id",
    id: "agent",
    scope: "org",
    creatorId: "u1",
    client: null,
    groupLabel: null,
    description: "",
    model: "anthropic/claude-sonnet-4-5",
    region: "iad1",
    status: "running",
    sandboxName: null,
    skills: [],
    outdatedCount: 0,
    sessionsCount: 0,
    pendingOp: null,
    lastActive: "4m ago",
    created: "Mar 12, 2026",
    instructions: "",
    sandboxId: null,
    lastResumeMs: null,
    provision: null,
    secrets: [],
    sessions: [],
    ...overrides,
  };
}

function registrySkill(id: string, requirements: SkillVM["requirements"]): SkillVM {
  return { id, requirements } as unknown as SkillVM;
}

describe("agentCounts + summaryLine", () => {
  it("counts statuses and outdated agents", () => {
    const counts = agentCounts([
      agent({ status: "running" }),
      agent({ status: "running", outdatedCount: 2 }),
      agent({ status: "sleeping" }),
      agent({ status: "error" }),
      agent({ status: "provisioning" }),
    ]);
    expect(counts).toEqual({ total: 5, running: 2, sleeping: 1, provisioning: 1, error: 1, outdated: 1 });
    expect(summaryLine(counts)).toBe("Running 2 · Sleeping 1 · Outdated 1 · Errors 1");
  });
});

describe("status classes", () => {
  it("maps every status to a dot + badge (color always paired with the word in the UI)", () => {
    expect(statusDot("running")).toBe("vdot vdot--ok");
    expect(statusDot("sleeping")).toBe("vdot vdot--unknown");
    expect(statusDot("provisioning")).toBe("vdot vdot--warn");
    expect(statusDot("error")).toBe("vdot vdot--down");
    expect(statusBadge("running")).toBe("ls-badge--ok");
    expect(statusBadge("error")).toBe("vbadge--down");
  });
});

describe("kebabName", () => {
  it("kebabs raw names for the chat-URL preview", () => {
    expect(kebabName("Monka Support")).toBe("monka-support");
    expect(kebabName("  Éé!! weird__name  ")).toBe("weird-name");
    expect(kebabName("already-kebab")).toBe("already-kebab");
    expect(kebabName("--edge--")).toBe("edge");
  });
});

describe("deriveSecretRows", () => {
  const registry = [
    registrySkill("monka-triage", [
      { key: "ZENDESK_API_TOKEN", type: "secret", required: true, note: "" },
      { key: "MONKA_API_KEY", type: "secret", required: true, note: "" },
    ]),
    registrySkill("meeting-digest", [{ key: "SLACK_BOT_TOKEN", type: "secret", required: true, note: "" }]),
    registrySkill("inbox-sweep", [{ key: "SLACK_BOT_TOKEN", type: "secret", required: false, note: "" }]),
    registrySkill("granite-notes", []),
  ];

  it("unions requirements across selected skills, deduped by key with joined `by`", () => {
    const rows = deriveSecretRows(["monka-triage", "meeting-digest", "inbox-sweep"], registry);
    expect(rows.map((r) => r.key)).toEqual(["ZENDESK_API_TOKEN", "MONKA_API_KEY", "SLACK_BOT_TOKEN"]);
    expect(rows.find((r) => r.key === "SLACK_BOT_TOKEN")?.by).toEqual(["meeting-digest", "inbox-sweep"]);
  });

  it("required wins over optional when two skills disagree", () => {
    const rows = deriveSecretRows(["inbox-sweep", "meeting-digest"], registry);
    expect(rows.find((r) => r.key === "SLACK_BOT_TOKEN")?.required).toBe(true);
  });

  it("ignores unselected and requirement-free skills", () => {
    expect(deriveSecretRows(["granite-notes"], registry)).toEqual([]);
  });
});

describe("outdatedSkills", () => {
  it("filters to pins behind their latest version", () => {
    const a = agent({
      skills: [
        { skillId: "1", id: "meeting-digest", version: "1.2.4", latest: "1.3.0", outdated: true },
        { skillId: "2", id: "granite-notes", version: "2.0.1", latest: "2.0.1", outdated: false },
      ],
    });
    expect(outdatedSkills(a).map((s) => s.id)).toEqual(["meeting-digest"]);
  });
});

describe("deriveAgentNav", () => {
  it("computes per-library counts, update dots and sorted label rows", () => {
    const nav = deriveAgentNav(
      [agent({ groupLabel: "Ops" }), agent({ groupLabel: "Finance", outdatedCount: 1 })],
      [agent({ groupLabel: "Monka" }), agent({ groupLabel: "Monka" }), agent({})],
    );
    expect(nav.mine.count).toBe(2);
    expect(nav.mine.updateDot).toBe(true);
    expect(nav.mine.labels.map((l) => l.name)).toEqual(["Finance", "Ops"]);
    expect(nav.org.count).toBe(3);
    expect(nav.org.updateDot).toBe(false);
    expect(nav.org.labels).toEqual([expect.objectContaining({ name: "Monka", count: 2 })]);
  });

  it("label cosmetics are deterministic", () => {
    expect(groupLabelMeta("Ops")).toEqual(groupLabelMeta("Ops"));
    expect(groupLabelMeta("Ops").color).toMatch(/^#/);
  });
});

describe("filterAgents", () => {
  const fleet = [
    agent({ id: "monka-support", client: "Monka", groupLabel: "Monka" }),
    agent({ id: "tvc-devis", client: "TVC", groupLabel: "Finance" }),
    agent({ id: "vibe-standup", client: "TVC" }),
  ];

  it("filters by group label", () => {
    expect(filterAgents(fleet, { label: "Finance" }).map((a) => a.id)).toEqual(["tvc-devis"]);
  });

  it("searches slug and client", () => {
    expect(filterAgents(fleet, { query: "monka" }).map((a) => a.id)).toEqual(["monka-support"]);
    expect(filterAgents(fleet, { query: "tvc" }).map((a) => a.id)).toEqual(["tvc-devis", "vibe-standup"]);
  });

  it("sorts by name on demand without mutating input", () => {
    const sorted = filterAgents(fleet, { sort: "name" });
    expect(sorted.map((a) => a.id)).toEqual(["monka-support", "tvc-devis", "vibe-standup"]);
    expect(fleet[0]?.id).toBe("monka-support");
  });
});

function modelRow(id: string, provider: string, providerName: string): AgentModelRow {
  return {
    id,
    provider,
    provider_name: providerName,
    name: id,
    description: null,
    context: null,
    cost_input: null,
    cost_output: null,
    env_keys: [],
  };
}

function modelsResponse(connected: Record<string, boolean>): AgentModelsResponse {
  return {
    models: [
      modelRow("openai/gpt-5.5", "openai", "OpenAI"),
      modelRow("openai/gpt-5-mini", "openai", "OpenAI"),
      modelRow("anthropic/claude-sonnet-4-5", "anthropic", "Anthropic"),
    ],
    providers: [
      { id: "openai", name: "OpenAI", env_keys: ["OPENAI_API_KEY"], connected: connected.openai ?? false },
      { id: "anthropic", name: "Anthropic", env_keys: ["ANTHROPIC_API_KEY"], connected: connected.anthropic ?? false },
    ],
  };
}

describe("groupModelsByProvider", () => {
  it("groups models by provider, connected-first then alphabetical", () => {
    const res = modelsResponse({ anthropic: true, openai: false });
    const groups = groupModelsByProvider(res.models, toModelProviders(res));
    expect(groups.map((g) => g.provider.id)).toEqual(["anthropic", "openai"]);
    expect(groups[0]?.provider.connected).toBe(true);
    expect(groups[1]?.models.map((m) => m.id)).toEqual(["openai/gpt-5.5", "openai/gpt-5-mini"]);
  });

  it("applies a local connected override (an inline Connect flips the group)", () => {
    const res = modelsResponse({});
    const groups = groupModelsByProvider(res.models, toModelProviders(res), new Set(["openai"]));
    expect(groups.find((g) => g.provider.id === "openai")?.provider.connected).toBe(true);
    expect(groups.find((g) => g.provider.id === "anthropic")?.provider.connected).toBe(false);
    // Connected override sorts openai (connected) ahead of anthropic (not).
    expect(groups[0]?.provider.id).toBe("openai");
  });

  it("gates model selectability on the owning provider's connection", () => {
    const res = modelsResponse({ anthropic: true });
    const groups = groupModelsByProvider(res.models, toModelProviders(res));
    expect(modelProviderConnected(groups, "anthropic/claude-sonnet-4-5")).toBe(true);
    expect(modelProviderConnected(groups, "openai/gpt-5.5")).toBe(false);
    expect(modelProviderConnected(groups, "unknown/model")).toBe(false);
  });

  it("preselects the first model of the first connected provider (or null)", () => {
    const connected = modelsResponse({ openai: true });
    expect(firstConnectedModel(groupModelsByProvider(connected.models, toModelProviders(connected)))).toBe(
      "openai/gpt-5.5",
    );
    const none = modelsResponse({});
    expect(firstConnectedModel(groupModelsByProvider(none.models, toModelProviders(none)))).toBeNull();
  });

  it("filters models by query but keeps the header for any group with matches", () => {
    const res = modelsResponse({ openai: true, anthropic: true });
    const groups = groupModelsByProvider(res.models, toModelProviders(res));
    const filtered = filterModelGroups(groups, "sonnet");
    expect(filtered.map((g) => g.provider.id)).toEqual(["anthropic"]);
    expect(filtered[0]?.models.map((m) => m.id)).toEqual(["anthropic/claude-sonnet-4-5"]);
    // A provider-name query keeps all of that provider's models.
    expect(filterModelGroups(groups, "openai")[0]?.models.length).toBe(2);
  });
});

describe("validateSecretKey", () => {
  it("accepts env-var-shaped names and rejects the rest", () => {
    expect(validateSecretKey("API_TOKEN")).toBeNull();
    expect(validateSecretKey("_x1")).toBeNull();
    expect(validateSecretKey("")).toMatch(/name/i);
    expect(validateSecretKey("1BAD")).toMatch(/letters/i);
    expect(validateSecretKey("has space")).toMatch(/letters/i);
    expect(validateSecretKey("OPENCODE_SERVER_PASSWORD")).toMatch(/reserved/i);
    expect(validateSecretKey("DUP", ["DUP"])).toMatch(/already exists/i);
  });
});

describe("deriveUpdateNotices", () => {
  it("recomputes notices from the live agent rows, ordered by affected count", () => {
    const rows = [
      agent({
        skills: [
          { skillId: "s1", id: "meeting-digest", version: "1.2.0", latest: "1.3.0", outdated: true },
          { skillId: "s2", id: "seo-helper", version: "1.0.0", latest: null, outdated: false },
        ],
      }),
      agent({
        skills: [{ skillId: "s1", id: "meeting-digest", version: "1.2.4", latest: "1.3.0", outdated: true }],
      }),
      agent({
        skills: [{ skillId: "s3", id: "granite-notes", version: "2.0.0", latest: "2.1.0", outdated: true }],
      }),
    ];
    const notices = deriveUpdateNotices(rows);
    expect(notices.map((n) => n.slug)).toEqual(["meeting-digest", "granite-notes"]);
    const digest = notices.find((n) => n.slug === "meeting-digest");
    expect(digest?.affected_count).toBe(2);
    expect(digest?.latest_version).toBe("1.3.0");
    expect(digest?.skill_id).toBe("s1");
  });

  it("clears once no agent is outdated (banner disappears after a push)", () => {
    const rows = [
      agent({ skills: [{ skillId: "s1", id: "meeting-digest", version: "1.3.0", latest: "1.3.0", outdated: false }] }),
    ];
    expect(deriveUpdateNotices(rows)).toEqual([]);
  });
});
