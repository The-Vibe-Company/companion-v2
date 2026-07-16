import type {
  PendingRunPrompt,
  RunChatEvent,
  RunPromptAccepted,
  RunPromptStatus,
  SkillRunDetail,
} from "@companion/contracts";

const PENDING_RANK = { queued: 0, processing: 1, cancel_requested: 2 } as const;

type PromptStatusEvent = Extract<RunChatEvent, { type: "prompt.status" }>;
type TerminalPromptStatus = Exclude<RunPromptStatus, PendingRunPrompt["status"]>;

function isTerminalPromptStatus(status: RunPromptStatus): status is TerminalPromptStatus {
  return status === "completed" || status === "canceled" || status === "error";
}

/**
 * Reconcile a request acknowledgement with state that may already have advanced over SSE.
 * A queued acknowledgement cannot move a live prompt backwards, and terminal state is final.
 * Ordered SSE transitions use {@link orderedPromptStatus} because a retry legitimately moves
 * `processing` back to `queued`.
 */
export function newerPromptStatus(current: RunPromptStatus | undefined, incoming: RunPromptStatus): RunPromptStatus {
  if (!current || isTerminalPromptStatus(incoming)) return incoming;
  if (isTerminalPromptStatus(current)) return current;
  return PENDING_RANK[incoming] >= PENDING_RANK[current] ? incoming : current;
}

/** The durable SSE log is ordered, so accept retries while keeping an observed terminal tombstone. */
export function orderedPromptStatus(current: RunPromptStatus | undefined, incoming: RunPromptStatus): RunPromptStatus {
  return current && isTerminalPromptStatus(current) ? current : incoming;
}

function newerPendingPrompt(current: PendingRunPrompt, incoming: PendingRunPrompt): PendingRunPrompt {
  if (PENDING_RANK[current.status] > PENDING_RANK[incoming.status]) return current;
  return {
    ...incoming,
    kind: current.kind,
    text: incoming.text || current.text,
    created_at: current.created_at,
    attachments: incoming.attachments.length > 0 ? incoming.attachments : current.attachments,
  };
}

/**
 * Reconcile a detail request that started before a local acknowledgement or SSE status arrived.
 * Local rows are retained, statuses never move backwards, and terminal SSE tombstones cannot be
 * resurrected by the older response.
 */
export function mergeStalePendingPrompts(
  local: PendingRunPrompt[],
  stale: PendingRunPrompt[],
  knownStatuses: ReadonlyMap<string, RunPromptStatus>,
): PendingRunPrompt[] {
  const merged = new Map(stale.map((prompt) => [prompt.id, prompt]));
  for (const prompt of local) {
    const incoming = merged.get(prompt.id);
    merged.set(prompt.id, incoming ? newerPendingPrompt(prompt, incoming) : prompt);
  }
  for (const [promptId, status] of knownStatuses) {
    if (isTerminalPromptStatus(status)) {
      merged.delete(promptId);
      continue;
    }
    const prompt = merged.get(promptId);
    if (prompt) merged.set(promptId, { ...prompt, status });
  }
  return [...merged.values()].sort((a, b) => a.ordinal - b.ordinal);
}

/** Fold a durable prompt.status event into the queue before the follow-up detail request returns. */
export function foldPromptStatusDetail(current: SkillRunDetail, event: PromptStatusEvent): SkillRunDetail {
  if (event.status === "completed" || event.status === "canceled" || event.status === "error") {
    const pendingPrompts = current.pending_prompts.filter((prompt) => prompt.id !== event.prompt_id);
    return pendingPrompts.length === current.pending_prompts.length
      ? current
      : { ...current, pending_prompts: pendingPrompts };
  }

  const pendingStatus: PendingRunPrompt["status"] = event.status;
  const existing = current.pending_prompts.find((prompt) => prompt.id === event.prompt_id);
  if (!existing) return current;
  if (existing.status === pendingStatus) return current;
  return {
    ...current,
    pending_prompts: current.pending_prompts.map((prompt) => prompt.id === event.prompt_id
      ? { ...prompt, status: pendingStatus }
      : prompt),
  };
}

/** Fold an HTTP acknowledgement into a possibly-newer SSE/detail snapshot without downgrading it. */
export function mergeAcceptedPromptDetail(
  current: SkillRunDetail,
  response: RunPromptAccepted,
  promptText: string,
  acceptedAt = new Date().toISOString(),
): SkillRunDetail {
  const knownAttachments = new Set(current.attachments.map((attachment) => attachment.id));
  const attachments = [
    ...current.attachments,
    ...response.attachments.filter((attachment) => !knownAttachments.has(attachment.id)),
  ];
  if (response.status !== "queued" && response.status !== "processing" && response.status !== "cancel_requested") {
    return {
      ...current,
      attachments,
      pending_prompts: current.pending_prompts.filter((prompt) => prompt.id !== response.prompt_id),
    };
  }

  const existing = current.pending_prompts.find((prompt) => prompt.id === response.prompt_id);
  const acknowledged = {
    id: response.prompt_id,
    message_id: response.message_id,
    ordinal: response.ordinal,
    kind: "follow_up" as const,
    text: promptText,
    status: response.status,
    created_at: acceptedAt,
    attachments: response.attachments,
  };
  const nextPrompt = existing
    ? newerPendingPrompt(existing, { ...acknowledged, kind: existing.kind, created_at: existing.created_at })
    : acknowledged;

  return {
    ...current,
    attachments,
    pending_prompts: [
      ...current.pending_prompts.filter((prompt) => prompt.id !== response.prompt_id),
      nextPrompt,
    ].sort((a, b) => a.ordinal - b.ordinal),
  };
}
