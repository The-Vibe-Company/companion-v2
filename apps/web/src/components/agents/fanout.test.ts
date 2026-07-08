import { describe, expect, it } from "vitest";
import {
  allSelected,
  fanoutQueue,
  fanoutReducer,
  fanoutRowState,
  fanoutSummary,
  initFanout,
  type FanoutState,
} from "./fanout";

const snapshot = [
  { id: "monka-support", prevVersion: "1.2.4", status: "running" as const },
  { id: "vibe-standup", prevVersion: "1.2.4", status: "sleeping" as const },
  { id: "monka-onboarding", prevVersion: "1.2.9", status: "running" as const },
];

describe("fanout state machine", () => {
  it("starts with everything selected", () => {
    const state = initFanout(snapshot);
    expect(state.selected).toEqual(snapshot.map((r) => r.id));
    expect(allSelected(state)).toBe(true);
  });

  it("toggles rows and select-all", () => {
    let state = initFanout(snapshot);
    state = fanoutReducer(state, { kind: "toggle", id: "vibe-standup" });
    expect(state.selected).toEqual(["monka-support", "monka-onboarding"]);
    expect(allSelected(state)).toBe(false);
    state = fanoutReducer(state, { kind: "toggleAll" });
    expect(allSelected(state)).toBe(true);
    state = fanoutReducer(state, { kind: "toggleAll" });
    expect(state.selected).toEqual([]);
  });

  it("blocks selection changes while running", () => {
    let state = initFanout(snapshot);
    state = fanoutReducer(state, { kind: "start" });
    expect(state.running).toBe(true);
    expect(fanoutReducer(state, { kind: "toggle", id: "monka-support" }).selected).toEqual(state.selected);
    expect(fanoutReducer(state, { kind: "toggleAll" }).selected).toEqual(state.selected);
  });

  it("refuses to start with an empty selection", () => {
    let state = initFanout(snapshot);
    state = fanoutReducer(state, { kind: "toggleAll" });
    expect(fanoutReducer(state, { kind: "start" }).running).toBe(false);
  });

  it("queue preserves snapshot order regardless of toggle order", () => {
    let state = initFanout(snapshot);
    state = fanoutReducer(state, { kind: "toggleAll" });
    state = fanoutReducer(state, { kind: "toggle", id: "monka-onboarding" });
    state = fanoutReducer(state, { kind: "toggle", id: "monka-support" });
    expect(fanoutQueue(state)).toEqual(["monka-support", "monka-onboarding"]);
  });

  it("rows keep their frozen prev version while progress flows through phases", () => {
    let state = initFanout(snapshot);
    state = fanoutReducer(state, { kind: "start" });
    state = fanoutReducer(state, { kind: "progress", id: "monka-support", phase: "pushing" });
    expect(fanoutRowState(state, "monka-support")).toBe("pushing");
    expect(fanoutRowState(state, "vibe-standup")).toBe("idle");
    state = fanoutReducer(state, { kind: "progress", id: "monka-support", phase: "restarting" });
    state = fanoutReducer(state, { kind: "progress", id: "monka-support", phase: "updated" });
    expect(fanoutRowState(state, "monka-support")).toBe("updated");
    expect(state.snapshot.find((r) => r.id === "monka-support")?.prevVersion).toBe("1.2.4");
  });

  it("'skipped' appears only once the run is done", () => {
    let state = initFanout(snapshot);
    state = fanoutReducer(state, { kind: "toggle", id: "vibe-standup" });
    state = fanoutReducer(state, { kind: "start" });
    expect(fanoutRowState(state, "vibe-standup")).toBe("idle");
    state = fanoutReducer(state, { kind: "progress", id: "monka-support", phase: "updated" });
    state = fanoutReducer(state, { kind: "progress", id: "monka-onboarding", phase: "updated" });
    state = fanoutReducer(state, { kind: "finish" });
    expect(state.done).toBe(true);
    expect(fanoutRowState(state, "vibe-standup")).toBe("skipped");
  });

  it("summary counts updated + failed", () => {
    let state: FanoutState = initFanout(snapshot);
    state = fanoutReducer(state, { kind: "start" });
    state = fanoutReducer(state, { kind: "progress", id: "monka-support", phase: "updated" });
    state = fanoutReducer(state, { kind: "progress", id: "vibe-standup", phase: "failed" });
    state = fanoutReducer(state, { kind: "progress", id: "monka-onboarding", phase: "updated" });
    state = fanoutReducer(state, { kind: "finish" });
    expect(fanoutSummary(state, "1.3.0")).toBe("2 updated · 1 failed · fleet is on 1.3.0");
  });
});
