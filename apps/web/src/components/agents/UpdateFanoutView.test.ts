// @vitest-environment happy-dom

import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AffectedAgentsResponse, AgentDetail } from "@companion/contracts";
import { UpdateFanoutView } from "./UpdateFanoutView";

const agentQueryMocks = vi.hoisted(() => ({
  fetchSkillUpdates: vi.fn(),
  pushAgentSkill: vi.fn(),
  fetchAgent: vi.fn(),
}));

vi.mock("@/lib/agentQueries", () => agentQueryMocks);

const response: AffectedAgentsResponse = {
  skill: {
    id: "skill-1",
    slug: "meeting-digest",
    latest_version: "1.3.0",
    released_at: "2026-07-01T00:00:00.000Z",
    description: "Summarize meetings and standups into shareable digests.",
    changelog: ["Handles multi-speaker transcripts over 2 hours", "Fixes a crash on empty agendas"],
  },
  agents: [
    { id: "agent-mail", slug: "mail-digest", scope: "personal", status: "running", pinned_version: "1.2.0" },
    { id: "agent-ops", slug: "ops-runner", scope: "personal", status: "sleeping", pinned_version: "1.2.1" },
  ],
};

function pendingOp(phase: "pushing" | "restarting" | "updated" | "failed") {
  return {
    kind: "skill-push" as const,
    skill_slug: "meeting-digest",
    from_version: "1.2.0",
    to_version: "1.3.0",
    phase,
    error: null,
    started_at: "2026-07-03T00:00:00.000Z",
  };
}

/** A minimal AgentDetail whose pending_op reports the given terminal phase for meeting-digest. */
function detailRow(slug: string, phase: "updated" | "failed"): AgentDetail {
  return {
    id: `agent-${slug}`,
    org_id: "org-1",
    slug,
    scope: "personal",
    creator_id: "user-1",
    client_label: null,
    group_label: null,
    description: "Test agent",
    model: "openai/gpt-5.5",
    region: "cdg1",
    lifecycle: "ready",
    status: "running",
    sandbox_name: "sb-01jb2k",
    skills: [
      {
        skill_id: "skill-1",
        slug: "meeting-digest",
        version: phase === "updated" ? "1.3.0" : "1.2.0",
        latest_version: "1.3.0",
        outdated: phase !== "updated",
        position: 0,
      },
    ],
    outdated_count: phase === "updated" ? 0 : 1,
    sessions_count: 0,
    pending_op: pendingOp(phase),
    last_active_at: "2026-07-03T00:00:00.000Z",
    created_at: "2026-06-01T00:00:00.000Z",
    instructions: "",
    sandbox_id: "sb-internal",
    golden_snapshot_id: null,
    opencode_version: null,
    last_resume_ms: null,
    provision: { attempt: 1, steps: [], error: null },
    secrets: [],
    sessions: [],
  };
}

let mountedRoots: Root[] = [];

async function mountView(props: Partial<React.ComponentProps<typeof UpdateFanoutView>> = {}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mountedRoots.push(root);
  await act(async () => {
    root.render(
      React.createElement(UpdateFanoutView, {
        skillSlug: "meeting-digest",
        onBack: vi.fn(),
        onAgentDetail: vi.fn(),
        ...props,
      }),
    );
  });
  await flushEffects();
  return { container, root };
}

function findButton(container: HTMLElement, label: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll("button")).find(
    (node) => node.getAttribute("aria-label") === label || node.textContent?.trim() === label,
  );
  if (!button) throw new Error(`Could not find button: ${label}`);
  return button;
}

function click(el: HTMLElement) {
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

async function flushEffects() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  agentQueryMocks.fetchSkillUpdates.mockResolvedValue(response);
  agentQueryMocks.pushAgentSkill.mockResolvedValue({ pending_op: pendingOp("pushing") });
  agentQueryMocks.fetchAgent.mockImplementation((slug: string) => Promise.resolve(detailRow(slug, "updated")));
});

afterEach(async () => {
  for (const root of mountedRoots) {
    await act(async () => root.unmount());
  }
  mountedRoots = [];
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

describe("UpdateFanoutView", () => {
  it("renders the skill header, changelog, and the affected rows with prev → latest chips", async () => {
    const { container } = await mountView();

    expect(agentQueryMocks.fetchSkillUpdates).toHaveBeenCalledWith("meeting-digest");
    expect(container.querySelector('[data-screen-label="Skill update fan-out"]')).toBeTruthy();
    expect(container.querySelector(".dtitle")?.textContent).toBe("meeting-digest");
    expect(container.textContent).toContain("Summarize meetings and standups into shareable digests.");
    expect(container.textContent).toContain("What changed");
    expect(container.textContent).toContain("Handles multi-speaker transcripts over 2 hours");
    expect(container.textContent).toContain("2 on older versions");

    // Rows: name + prev chip → latest chip, plus the sleeping note.
    const chips = Array.from(container.querySelectorAll(".chip")).map((chip) => chip.textContent?.trim());
    expect(chips).toContain("1.2.0");
    expect(chips).toContain("1.2.1");
    expect(chips.filter((text) => text === "1.3.0").length).toBeGreaterThanOrEqual(2);
    expect(container.textContent).toContain("mail-digest");
    expect(container.textContent).toContain("ops-runner");
    expect(container.textContent).toContain("sleeping · wakes to update");

    // Defaults to all selected; the push button carries the count.
    expect(container.textContent).toContain("2 of 2 selected");
    expect(findButton(container, "Push update to 2 agents").disabled).toBe(false);
  });

  it("toggles the whole selection via select-all and disables push at zero", async () => {
    const { container } = await mountView();

    click(findButton(container, "Select all"));
    expect(container.textContent).toContain("0 of 2 selected");
    expect(findButton(container, "Push update to 0 agents").disabled).toBe(true);

    click(findButton(container, "Select all"));
    expect(container.textContent).toContain("2 of 2 selected");

    click(findButton(container, "Deselect ops-runner"));
    expect(container.textContent).toContain("1 of 2 selected");
    expect(findButton(container, "Push update to 1 agent").disabled).toBe(false);
  });

  it("runs the sequential push, marks rows updated, and shows the summary + Done", async () => {
    const onAgentDetail = vi.fn();
    const { container } = await mountView({ onAgentDetail });

    click(findButton(container, "Push update to 2 agents"));
    await flushEffects();

    // Strictly sequential, snapshot order: mail-digest first, then ops-runner.
    expect(agentQueryMocks.pushAgentSkill).toHaveBeenCalledTimes(2);
    expect(agentQueryMocks.pushAgentSkill).toHaveBeenNthCalledWith(1, "mail-digest", "meeting-digest");
    expect(agentQueryMocks.pushAgentSkill).toHaveBeenNthCalledWith(2, "ops-runner", "meeting-digest");

    // Every polled detail is fed back to the console.
    expect(onAgentDetail).toHaveBeenCalledTimes(2);
    expect(onAgentDetail.mock.calls.map(([row]) => (row as AgentDetail).slug)).toEqual(["mail-digest", "ops-runner"]);

    // Rows show the green updated state; the run summary + Done button replace the push button.
    expect(container.textContent?.match(/updated/g)?.length).toBeGreaterThanOrEqual(2);
    expect(container.textContent).toContain("2 updated · 0 failed · fleet is on 1.3.0");
    expect(findButton(container, "Done")).toBeTruthy();
  });

  it("marks a failed push failed and continues with the next agent", async () => {
    agentQueryMocks.pushAgentSkill.mockImplementation((slug: string) =>
      slug === "mail-digest"
        ? Promise.reject(new Error("agent busy"))
        : Promise.resolve({ pending_op: pendingOp("pushing") }),
    );

    const { container } = await mountView();
    click(findButton(container, "Push update to 2 agents"));
    await flushEffects();

    expect(agentQueryMocks.pushAgentSkill).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("failed");
    expect(container.textContent).toContain("1 updated · 1 failed · fleet is on 1.3.0");
  });
});
