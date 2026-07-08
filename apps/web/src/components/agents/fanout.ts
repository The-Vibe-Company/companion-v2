import type { AgentStatus } from "@companion/contracts";

/**
 * Pure state machine for the skill-update fan-out screen. Rows come from a snapshot FROZEN when the
 * screen opens (so names and "prev" versions survive the run while live agents mutate underneath),
 * and pushes run strictly sequentially — one agent at a time, mirroring the pending_op phases the
 * API reports (pushing → restarting → updated | failed).
 */

export interface FanoutRow {
  /** Agent slug. */
  id: string;
  prevVersion: string;
  status: AgentStatus;
}

export type FanoutPhase = "pushing" | "restarting" | "updated" | "failed";
export type FanoutRowState = "idle" | FanoutPhase | "skipped";

export interface FanoutState {
  snapshot: FanoutRow[];
  /** Selected agent slugs (defaults to all). */
  selected: string[];
  running: boolean;
  done: boolean;
  results: Record<string, FanoutPhase>;
}

export type FanoutAction =
  | { kind: "toggle"; id: string }
  | { kind: "toggleAll" }
  | { kind: "start" }
  | { kind: "progress"; id: string; phase: FanoutPhase }
  | { kind: "finish" };

export function initFanout(snapshot: FanoutRow[]): FanoutState {
  return {
    snapshot,
    selected: snapshot.map((row) => row.id),
    running: false,
    done: false,
    results: {},
  };
}

export function allSelected(state: FanoutState): boolean {
  return state.snapshot.length > 0 && state.selected.length >= state.snapshot.length;
}

export function fanoutReducer(state: FanoutState, action: FanoutAction): FanoutState {
  switch (action.kind) {
    case "toggle": {
      if (state.running) return state;
      const has = state.selected.includes(action.id);
      return {
        ...state,
        selected: has ? state.selected.filter((id) => id !== action.id) : [...state.selected, action.id],
      };
    }
    case "toggleAll": {
      if (state.running) return state;
      return { ...state, selected: allSelected(state) ? [] : state.snapshot.map((row) => row.id) };
    }
    case "start": {
      if (state.running || state.selected.length === 0) return state;
      return { ...state, running: true, done: false, results: {} };
    }
    case "progress": {
      return { ...state, results: { ...state.results, [action.id]: action.phase } };
    }
    case "finish": {
      return { ...state, running: false, done: true };
    }
  }
}

/** The ordered slugs the sequential runner should push (snapshot order ∩ selection). */
export function fanoutQueue(state: FanoutState): string[] {
  return state.snapshot.map((row) => row.id).filter((id) => state.selected.includes(id));
}

/** What the right-hand status cell of a row shows. "skipped" appears only once the run is done. */
export function fanoutRowState(state: FanoutState, id: string): FanoutRowState {
  const result = state.results[id];
  if (result) return result;
  return state.done ? "skipped" : "idle";
}

export function fanoutSummary(state: FanoutState, latestVersion: string): string {
  const values = Object.values(state.results);
  const updated = values.filter((phase) => phase === "updated").length;
  const failed = values.filter((phase) => phase === "failed").length;
  return `${updated} updated · ${failed} failed · fleet is on ${latestVersion}`;
}
