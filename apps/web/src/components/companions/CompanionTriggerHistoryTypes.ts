import type {
  CompanionTriggerMode,
  CompanionTriggerRunDetail,
  CompanionTriggerRunEntry,
  CompanionTriggerRunList,
  CompanionTriggerRunStatus,
  CompanionTriggerRunSummary,
} from "@companion/contracts";

export type CompanionTriggerHistoryStatus = CompanionTriggerRunStatus;
export type CompanionTriggerHistoryMode = CompanionTriggerMode;
export type CompanionTriggerHistorySummary = CompanionTriggerRunSummary;
export type CompanionTriggerHistoryEntry = CompanionTriggerRunEntry;
export type CompanionTriggerHistoryDetail = CompanionTriggerRunDetail;
export type CompanionTriggerHistoryListResponse = CompanionTriggerRunList;

export interface CompanionTriggerHistoryListOptions {
  limit: number;
  cursor?: string;
}

export interface CompanionTriggerHistoryDetailOptions {
  entryLimit: number;
  entryCursor?: number;
}

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
