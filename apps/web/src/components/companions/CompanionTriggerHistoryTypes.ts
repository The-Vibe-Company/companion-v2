/**
 * Temporary web-side Trigger v2 history contracts. The shared package will own these once the API
 * response schemas land; keeping them local prevents an unfinished server type from leaking into
 * unrelated Companion components.
 */
export type CompanionTriggerHistoryStatus =
  | "queued"
  | "starting"
  | "dispatching"
  | "running"
  | "needs_input"
  | "succeeded"
  | "failed"
  | "interrupted"
  | "cancelled";

export type CompanionTriggerHistoryOutcome = "notify" | "relay" | "no_output";
export type CompanionTriggerHistoryMode = "notify" | "relay";

export interface CompanionTriggerHistoryError {
  code?: string | null;
  message?: string | null;
  action?: string | null;
}

export interface CompanionTriggerHistorySummary {
  run_id: string;
  companion_id: string;
  trigger: { id: string; name: string };
  status: CompanionTriggerHistoryStatus;
  mode?: CompanionTriggerHistoryMode | null;
  outcome: CompanionTriggerHistoryOutcome;
  main_entry_event_id: string | null;
  relay_turn_id: string | null;
  created_at: string;
  started_at: string | null;
  settled_at: string | null;
  error: CompanionTriggerHistoryError | null;
}

export interface CompanionTriggerHistoryTool {
  call_id?: string;
  kind?: string;
  name?: string;
  title?: string;
  status?: string;
  detail?: string | null;
}

export interface CompanionTriggerHistoryDecision {
  name?: string;
  title?: string;
  status?: string;
  detail?: string | null;
  answer?: string | null;
}

export interface CompanionTriggerHistoryEntry {
  event_id: string;
  ordinal: number;
  role?: "assistant" | "user" | "system" | "tool" | "decision" | string;
  content?: string | null;
  reasoning?: string | null;
  tool?: CompanionTriggerHistoryTool | null;
  decision?: CompanionTriggerHistoryDecision | null;
  /** Some server revisions put the bounded external payload on the entry itself. */
  payload?: string | null;
  payload_excerpt?: string | null;
  created_at: string;
}

export interface CompanionTriggerHistoryDetail extends CompanionTriggerHistorySummary {
  internal_entries: CompanionTriggerHistoryEntry[];
  next_entry_cursor: string | number | null;
}

export interface CompanionTriggerHistoryListResponse {
  runs: CompanionTriggerHistorySummary[];
  next_cursor: string | null;
}

export interface CompanionTriggerHistoryListOptions {
  limit: number;
  cursor?: string;
}

export interface CompanionTriggerHistoryDetailOptions {
  entryLimit: number;
  entryCursor?: string | number;
}

/** Injected read adapter; no route is assumed by the drawer itself. */
export interface CompanionTriggerHistoryApi {
  listCompanionTriggerRuns: (
    orgId: string,
    companionId: string,
    triggerId: string,
    options: CompanionTriggerHistoryListOptions,
  ) => Promise<CompanionTriggerHistoryListResponse>;
  readCompanionTriggerRun: (
    orgId: string,
    companionId: string,
    runId: string,
    options: CompanionTriggerHistoryDetailOptions,
  ) => Promise<CompanionTriggerHistoryDetail>;
}
