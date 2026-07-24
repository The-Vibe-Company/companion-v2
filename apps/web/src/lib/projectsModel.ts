import {
  projectDetailSchema,
  projectFileRowSchema,
  projectFileVersionsResponseSchema,
  projectSessionDetailSchema,
  projectSessionsResponseSchema,
  projectsResponseSchema,
  runChatHistoryItemSchema,
  type ProjectDetail,
  type ProjectFileRow,
  type ProjectRow,
  type ProjectSessionDetail,
  type ProjectSessionRow,
  type ProjectSessionStatus as ContractProjectSessionStatus,
  type ProjectSkill,
  type ProjectWorkspaceStatus as ContractProjectWorkspaceStatus,
  RunChatHistoryItem,
} from "@companion/contracts";

/** Presentation model derived only from the persistent Projects API contracts. */

export type ProjectWorkspaceStatus = ContractProjectWorkspaceStatus;
export type ProjectSessionStatus = ContractProjectSessionStatus;

export type ProjectSessionVM = {
  id: string;
  title: string;
  model: string;
  status: ProjectSessionStatus;
  history: RunChatHistoryItem[];
  prompts: ProjectPromptVM[];
  pendingPrompts: ProjectPromptVM[];
  /** Prefix already represented by the durable transcript; use as the SSE replay cursor. */
  latestEventSequence: number;
  /** Current durable event allocator maximum; may advance after the transcript becomes terminal. */
  currentEventSequence: number;
  createdAt: string;
  updatedAt: string;
  lastActiveAt: string;
  archivedAt: string | null;
  lastViewedAt: string;
  isUnread: boolean;
  errorMessage: string | null;
};

export type ProjectPromptAttachmentVM = {
  id: string;
  fileName: string;
  contentType: string;
  byteSize: number;
  workspacePath: string;
  status: "uploaded" | "materialized" | "failed";
  createdAt: string;
};

export type ProjectPromptVM = {
  id: string;
  messageId: string;
  text: string;
  status:
    | "queued"
    | "dispatching"
    | "running"
    | "completed"
    | "failed"
    | "cancelled";
  attachments: ProjectPromptAttachmentVM[];
  fileChanges: ProjectPromptFileChangeVM[];
  createdAt: string;
  completedAt: string | null;
  errorCode: string | null;
  errorMessage: string | null;
};

export type ProjectPromptFileChangeVM = {
  projectId: string;
  fileId: string;
  path: string;
  kind: "created" | "updated";
  version: number;
  contentType: string;
  byteSize: number;
  modifiedBySessionId: string;
  modifiedByPromptId: string;
  conflictDetected: boolean;
  createdAt: string;
};

export type ProjectSkillVM = {
  id: string;
  slug: string;
  displayName: string;
  summary: string;
  version: string;
  archived: boolean;
};

export type ProjectFileVM = {
  id: string;
  path: string;
  name: string;
  version: number;
  contentType: string | null;
  byteSize: number;
  conflictDetected: boolean;
  modifiedBySessionId: string | null;
  modifiedByPromptId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ProjectFileVersionVM = {
  projectId: string;
  fileId: string;
  path: string;
  version: number;
  contentType: string;
  byteSize: number;
  checksum: string;
  modifiedBySessionId: string | null;
  modifiedByPromptId: string | null;
  baseVersion: number | null;
  conflictDetected: boolean;
  createdAt: string;
};

export type ProjectWorkspaceVM = {
  status: ProjectWorkspaceStatus;
  errorCode?: string | null;
  statusDetail: string | null;
  lastActiveAt: string | null;
  sleepAt: string | null;
};

export type ProjectRowVM = {
  id: string;
  name: string;
  defaultModel: string;
  revision: number;
  status: ProjectWorkspaceStatus;
  errorCode?: string | null;
  statusDetail: string | null;
  skillCount: number;
  sessionCount: number;
  activeSessionCount: number;
  archivedSessionCount: number;
  unreadSessionCount: number;
  fileCount: number;
  secretCount: number;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  recentSessions: ProjectSessionVM[];
};

export type ProjectAccessVM = {
  secrets: Array<{
    id: string;
    name: string;
    source: "personal" | "organization" | "shared";
    ownerName: string;
  }>;
  modelConnections: Array<{
    id: string;
    provider: string;
    source: "personal" | "organization";
  }>;
};

export type ProjectDetailVM = ProjectRowVM & {
  skills: ProjectSkillVM[];
  sessions: ProjectSessionVM[];
  files: ProjectFileVM[];
  workspace: ProjectWorkspaceVM;
  modelConnectionCount: number;
  access: ProjectAccessVM;
};

export type ProjectModelChoice = {
  id: string;
  name: string;
  providerName: string;
};

export type ProjectSkillChoice = {
  slug: string;
  name: string;
  summary: string;
  source: string;
  version: string | null;
};

export type ProjectRuntimeAvailability = {
  available: boolean;
  message: string | null;
};

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function normalizeProjectSession(
  row: ProjectSessionRow | ProjectSessionDetail,
): ProjectSessionVM {
  const createdAt = row.created_at;
  const historyResult = runChatHistoryItemSchema
    .array()
    .safeParse("transcript" in row ? row.transcript : []);
  const history = historyResult.success ? historyResult.data : [];
  const visiblePromptCounts = new Map<string, number>();
  for (const item of history) {
    if (item.kind !== "user") continue;
    visiblePromptCounts.set(
      item.text,
      (visiblePromptCounts.get(item.text) ?? 0) + 1,
    );
  }
  const promptRows: ProjectPromptVM[] =
    "prompts" in row
      ? row.prompts.map((prompt) => ({
          id: prompt.id,
          messageId: prompt.opencode_message_id,
          text: prompt.text,
          status: prompt.status,
          attachments: prompt.attachments.map((attachment) => ({
            id: attachment.id,
            fileName: attachment.file_name,
            contentType: attachment.content_type,
            byteSize: attachment.byte_size,
            workspacePath: attachment.workspace_path,
            status: attachment.status,
            createdAt: attachment.created_at,
          })),
          fileChanges: prompt.file_changes.map((change) => ({
            projectId: change.project_id,
            fileId: change.file_id,
            path: change.path,
            kind: change.kind,
            version: change.version,
            contentType: change.content_type,
            byteSize: change.byte_size,
            modifiedBySessionId: change.modified_by_session_id,
            modifiedByPromptId: change.modified_by_prompt_id,
            conflictDetected: change.conflict_detected,
            createdAt: change.created_at,
          })),
          createdAt: prompt.created_at,
          completedAt: prompt.completed_at,
          errorCode: prompt.error_code,
          errorMessage: prompt.error_message,
        }))
      : [];
  const pendingPromptRows: ProjectSessionVM["pendingPrompts"] = [];
  for (const [index, prompt] of promptRows.entries()) {
    const text = prompt.text;
    const visibleCount = visiblePromptCounts.get(text) ?? 0;
    if (visibleCount > 0) {
      visiblePromptCounts.set(text, visibleCount - 1);
      continue;
    }
    pendingPromptRows.push({ ...prompt, id: prompt.id || `prompt-${index}` });
  }
  return {
    id: row.id,
    title: row.title,
    model: row.model,
    status: row.status,
    history,
    prompts: promptRows,
    pendingPrompts: pendingPromptRows,
    latestEventSequence:
      "latest_event_sequence" in row ? row.latest_event_sequence : 0,
    currentEventSequence:
      "current_event_sequence" in row &&
      typeof row.current_event_sequence === "number"
        ? row.current_event_sequence
        : "latest_event_sequence" in row
          ? row.latest_event_sequence
          : 0,
    createdAt,
    updatedAt: row.updated_at,
    lastActiveAt: row.last_active_at,
    archivedAt: row.archived_at,
    lastViewedAt: row.last_viewed_at,
    isUnread: row.is_unread,
    errorMessage:
      row.message ??
      (historyResult.success
        ? null
        : "Some transcript entries could not be displayed."),
  };
}

export function normalizeProjectSessionResponse(
  value: unknown,
): ProjectSessionVM {
  const payload = record(value);
  const transcript = runChatHistoryItemSchema
    .array()
    .safeParse(payload.transcript);
  const normalized = normalizeProjectSession(
    projectSessionDetailSchema.parse(
      transcript.success ? value : { ...payload, transcript: [] },
    ),
  );
  return transcript.success || normalized.errorMessage
    ? normalized
    : {
        ...normalized,
        errorMessage: "Some transcript entries could not be displayed.",
      };
}

function normalizeProjectSkill(row: ProjectSkill): ProjectSkillVM {
  return {
    id: row.skill_id,
    slug: row.slug,
    displayName: row.display_name,
    summary: row.summary,
    version: row.version,
    archived: row.archived,
  };
}

function normalizeProjectFile(row: ProjectFileRow): ProjectFileVM {
  const path = row.path;
  return {
    id: row.id,
    path,
    name: path.startsWith("files/") ? path.slice("files/".length) : path,
    version: row.version,
    contentType: row.content_type,
    byteSize: row.byte_size,
    conflictDetected: row.conflict_detected,
    modifiedBySessionId: row.modified_by_session_id,
    modifiedByPromptId: row.modified_by_prompt_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function normalizeProjectFilesResponse(value: unknown): ProjectFileVM[] {
  const payload = record(value);
  const rows = projectFileRowSchema.array().parse(payload.files);
  return rows.map(normalizeProjectFile);
}

export function normalizeProjectFileVersionsResponse(
  value: unknown,
): ProjectFileVersionVM[] {
  const payload = projectFileVersionsResponseSchema.parse(value);
  return payload.versions.map((row) => ({
    projectId: row.project_id,
    fileId: row.file_id,
    path: row.path,
    version: row.version,
    contentType: row.content_type,
    byteSize: row.byte_size,
    checksum: row.checksum,
    modifiedBySessionId: row.modified_by_session_id,
    modifiedByPromptId: row.modified_by_prompt_id,
    baseVersion: row.base_version,
    conflictDetected: row.conflict_detected,
    createdAt: row.created_at,
  }));
}

function normalizeProjectRow(row: ProjectRow): ProjectRowVM {
  return {
    id: row.id,
    name: row.name,
    defaultModel: row.default_model,
    revision: row.revision,
    status: row.status,
    errorCode: row.error_code,
    statusDetail: row.message,
    skillCount: row.skill_count,
    sessionCount: row.session_count,
    activeSessionCount: row.active_session_count,
    archivedSessionCount: row.archived_session_count,
    unreadSessionCount: row.unread_session_count,
    fileCount: row.file_count,
    secretCount: 0,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.last_activity_at,
    recentSessions: sortProjectSessionsByCreatedAt(
      row.recent_sessions.map(normalizeProjectSession),
    ),
  };
}

export function normalizeProjectsResponse(value: unknown): {
  projects: ProjectRowVM[];
  runtime: ProjectRuntimeAvailability;
} {
  const payload = projectsResponseSchema.parse(value);
  return {
    projects: payload.projects.map(normalizeProjectRow),
    runtime: payload.runtime,
  };
}

export function normalizeProjectDetail(value: unknown): ProjectDetailVM {
  const row: ProjectDetail = projectDetailSchema.parse(value);
  const base = normalizeProjectRow(row);
  const sessions = sortProjectSessionsByCreatedAt(
    row.sessions.map(normalizeProjectSession),
  );
  return {
    ...base,
    secretCount: row.secret_count,
    recentSessions: base.recentSessions,
    skills: row.skills.map(normalizeProjectSkill),
    sessions,
    files: [],
    modelConnectionCount: row.model_connection_count,
    access: {
      secrets: row.access.secrets.map((secret) => ({
        id: secret.id,
        name: secret.name,
        source: secret.source,
        ownerName: secret.owner_name,
      })),
      modelConnections: row.access.model_connections.map((connection) => ({
        id: connection.id,
        provider: connection.provider,
        source: connection.source,
      })),
    },
    workspace: {
      status: row.status,
      errorCode: row.error_code,
      statusDetail: row.message,
      lastActiveAt: row.last_activity_at,
      sleepAt: null,
    },
  };
}

export function normalizeProjectSessionsResponse(value: unknown): {
  sessions: ProjectSessionVM[];
  nextCursor: string | null;
} {
  const payload = projectSessionsResponseSchema.parse(value);
  return {
    sessions: sortProjectSessionsByCreatedAt(
      payload.sessions.map(normalizeProjectSession),
    ),
    nextCursor: payload.next_cursor,
  };
}

/** Canonical Project conversation order: creation time descending, then id descending. */
export function sortProjectSessionsByCreatedAt<
  T extends Pick<ProjectSessionVM, "id" | "createdAt">,
>(sessions: T[]): T[] {
  return [...sessions].sort((left, right) => {
    const byCreated = right.createdAt.localeCompare(left.createdAt);
    return byCreated || right.id.localeCompare(left.id);
  });
}

export function mergeProjectRow(detail: ProjectDetailVM): ProjectRowVM {
  const {
    skills: _skills,
    sessions: _sessions,
    files: _files,
    workspace: _workspace,
    ...row
  } = detail;
  return row;
}
