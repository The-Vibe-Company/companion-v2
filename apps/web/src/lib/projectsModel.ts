import {
  projectDetailSchema,
  projectFileRowSchema,
  projectFileVersionsResponseSchema,
  projectSessionDetailSchema,
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
  pendingPrompts: Array<{ id: string; text: string; createdAt: string }>;
  latestEventSequence: number;
  createdAt: string;
  lastActiveAt: string;
  errorMessage: string | null;
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
  baseVersion: number | null;
  conflictDetected: boolean;
  createdAt: string;
};

export type ProjectWorkspaceVM = {
  status: ProjectWorkspaceStatus;
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
  statusDetail: string | null;
  skillCount: number;
  sessionCount: number;
  fileCount: number;
  secretCount: number;
  createdAt: string;
  updatedAt: string;
  recentSessions: ProjectSessionVM[];
};

export type ProjectDetailVM = ProjectRowVM & {
  skills: ProjectSkillVM[];
  sessions: ProjectSessionVM[];
  files: ProjectFileVM[];
  workspace: ProjectWorkspaceVM;
  modelConnectionCount: number;
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
  const pendingPromptRows: ProjectSessionVM["pendingPrompts"] = [];
  const prompts = "prompts" in row ? row.prompts : [];
  for (const [index, prompt] of prompts.entries()) {
    const text = prompt.text;
    const visibleCount = visiblePromptCounts.get(text) ?? 0;
    if (visibleCount > 0) {
      visiblePromptCounts.set(text, visibleCount - 1);
      continue;
    }
    pendingPromptRows.push({
      id: prompt.id || `prompt-${index}`,
      text,
      createdAt: prompt.created_at,
    });
  }
  return {
    id: row.id,
    title: row.title,
    model: row.model,
    status: row.status,
    history,
    pendingPrompts: pendingPromptRows,
    latestEventSequence:
      "latest_event_sequence" in row ? row.latest_event_sequence : 0,
    createdAt,
    lastActiveAt: row.last_active_at,
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
    statusDetail: row.message,
    skillCount: row.skill_count,
    sessionCount: row.session_count,
    fileCount: row.file_count,
    secretCount: 0,
    createdAt: row.created_at,
    updatedAt: row.last_activity_at,
    recentSessions: row.recent_sessions.map(normalizeProjectSession),
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
  const sessions = row.sessions.map(normalizeProjectSession);
  return {
    ...base,
    secretCount: row.secret_count,
    recentSessions: base.recentSessions,
    skills: row.skills.map(normalizeProjectSkill),
    sessions,
    files: [],
    modelConnectionCount: row.model_connection_count,
    workspace: {
      status: row.status,
      statusDetail: row.message,
      lastActiveAt: row.last_activity_at,
      sleepAt: null,
    },
  };
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
