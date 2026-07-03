import { describe, expect, it } from "vitest";
import type { AgentVM, SkillVM } from "@/lib/types";
import {
  agentCounts,
  deriveAgentNav,
  deriveSecretRows,
  filterAgents,
  groupLabelMeta,
  kebabName,
  outdatedSkills,
  statusBadge,
  statusDot,
  summaryLine,
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
