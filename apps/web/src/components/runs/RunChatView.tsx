"use client";

import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import {
  RUN_ATTACHMENT_MAX_FILES,
  RUN_PROMPT_MAX_QUEUED,
  type RunPhase,
  type RunPromptAccepted,
  type RunPromptStatus,
  type SkillRunDetail,
} from "@companion/contracts";
import {
  cancelRun,
  cancelRunPrompt,
  fetchRun,
  sendRunPrompt,
} from "@/lib/runQueries";
import { Icon } from "../Icon";
import { ChatComposer } from "./ChatComposer";
import { RunFilesDrawer } from "./ChatMedia";
import { ChatTranscript } from "./ChatTranscript";
import { chatReducer, initChatState, openRunStream } from "./chatStream";
import { runInputsFromSnapshot, type RunLauncherDraft } from "./launcherState";
import { appendRunAttachmentFiles } from "./runAttachmentDraft";
import {
  foldPromptStatusDetail,
  mergeAcceptedPromptDetail,
  mergeStalePendingPrompts,
  newerPromptStatus,
  orderedPromptStatus,
} from "./promptQueue";
import {
  canReactivateRun,
  canUseRunComposer,
  isStaleRunDetail,
  shouldRestartPollingAfterPromptFailure,
} from "./reactivation";
import { useRunFileDrop } from "./useRunFileDrop";

const STARTING_POLL_MS = 1_500;

function phaseLabel(phase: RunPhase | null | undefined): string {
  return phase ?? "pending";
}

function StartingBanner({ status, phase }: { status: "queued" | "starting"; phase: RunPhase | null | undefined }) {
  return (
    <div className="run-chat-banner run-chat-banner--starting">
      <div>
        <Icon name="loader" size={14} className="ls-spin" />
        <b>{status === "queued" ? "Run queued" : "Starting run"}</b>
        <code>{phaseLabel(phase)}</code>
      </div>
      <span className="chat-wake__track"><span className="chat-wake__bar" /></span>
    </div>
  );
}

function FrozenBanner({
  note,
  canReactivate,
  onRunAgain,
}: {
  note: string;
  canReactivate: boolean;
  onRunAgain: () => void;
}) {
  return (
    <div className="run-chat-banner">
      <Icon name={canReactivate ? "refresh-cw" : "lock"} size={13} />
      <b>Session ended</b>
      <span>{note}</span>
      <button type="button" className="btn-sec" onClick={onRunAgain}>
        <Icon name="play" size={13} />
        Run again
      </button>
    </div>
  );
}

export function RunChatView({
  runId,
  expectedSkillSlug,
  onBack,
  onRunAgain,
}: {
  runId: string;
  expectedSkillSlug: string;
  onBack: () => void;
  onRunAgain: (draft: RunLauncherDraft) => void;
}) {
  const [run, setRun] = useState<SkillRunDetail | null>(null);
  const runRef = useRef<SkillRunDetail | null>(null);
  runRef.current = run;
  const currentRunIdRef = useRef(runId);
  currentRunIdRef.current = runId;
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadRetryNonce, setLoadRetryNonce] = useState(0);
  const [text, setText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [rowOverride, setRowOverride] = useState<Map<string, boolean>>(() => new Map());
  const [chat, dispatch] = useReducer(chatReducer, undefined, initChatState);
  const chatRef = useRef(chat);
  chatRef.current = chat;
  const [streamDead, setStreamDead] = useState(false);
  const [streamReady, setStreamReady] = useState(false);
  const [reconnectNonce, setReconnectNonce] = useState(0);
  const lastEventIdRef = useRef<string | null>(null);
  const [sending, setSending] = useState(false);
  const promptSendingRef = useRef(false);
  const promptAttemptRef = useRef<{
    text: string;
    fileSignature: string;
    files: File[];
    idempotencyKey: string;
  } | null>(null);
  const [promptError, setPromptError] = useState<string | null>(null);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [cancelBusy, setCancelBusy] = useState(false);
  const [cancelRequestedLocal, setCancelRequestedLocal] = useState(false);
  const [promptCancelBusy, setPromptCancelBusy] = useState(false);
  const [reactivationClock, setReactivationClock] = useState(() => Date.now());
  const [filesOpen, setFilesOpen] = useState(false);
  const openFiles = useCallback(() => setFilesOpen(true), []);
  const closeFiles = useCallback(() => setFilesOpen(false), []);
  const filesButtonRef = useRef<HTMLButtonElement>(null);
  const requestGenerationRef = useRef(0);
  const appliedGenerationRef = useRef(0);
  const pendingRevisionRef = useRef(0);
  const promptStatusRef = useRef<Map<string, RunPromptStatus>>(new Map());
  const promptSseObservedRef = useRef<Set<string>>(new Set());
  const promptProcessedRef = useRef<Set<string>>(new Set());
  const removedAttachmentIdsRef = useRef<Set<string>>(new Set());
  const statusActivationRevisionRef = useRef<number | null>(null);
  const appliedTranscriptSequenceRef = useRef(-1);
  const [showPromptBubble, setShowPromptBubble] = useState(false);

  const applyRunDetail = useCallback((
    detail: SkillRunDetail,
    generation: number,
    pendingRevisionAtRequest = pendingRevisionRef.current,
  ): SkillRunDetail => {
    if (detail.id !== currentRunIdRef.current) throw new Error("Ignored a stale response for a different run.");
    if (detail.skill_slug !== expectedSkillSlug) throw new Error("This run does not belong to the skill in the current route.");
    if (
      statusActivationRevisionRef.current !== null
      && detail.activation_revision > statusActivationRevisionRef.current
    ) {
      promptStatusRef.current.clear();
      promptSseObservedRef.current.clear();
      promptProcessedRef.current.clear();
    }
    statusActivationRevisionRef.current = Math.max(
      statusActivationRevisionRef.current ?? detail.activation_revision,
      detail.activation_revision,
    );
    const current = runRef.current;
    if (generation < appliedGenerationRef.current) return current ?? detail;
    if (current?.id === detail.id && isStaleRunDetail(current, detail)) return current;
    const reconciled = current?.id === detail.id && pendingRevisionAtRequest < pendingRevisionRef.current
      ? (() => {
          const attachments = new Map(
            detail.attachments
              .filter((attachment) => !removedAttachmentIdsRef.current.has(attachment.id))
              .map((attachment) => [attachment.id, attachment]),
          );
          for (const attachment of current.attachments) attachments.set(attachment.id, attachment);
          return {
            ...detail,
            attachments: [...attachments.values()],
            pending_prompts: mergeStalePendingPrompts(
              current.pending_prompts,
              detail.pending_prompts,
              promptStatusRef.current,
            ),
          };
        })()
      : detail;
    if (pendingRevisionAtRequest === pendingRevisionRef.current) {
      removedAttachmentIdsRef.current.clear();
    }
    appliedGenerationRef.current = generation;
    runRef.current = reconciled;
    setRun(reconciled);
    setLoadError(null);
    return reconciled;
  }, [expectedSkillSlug]);

  const refreshRun = useCallback(async (): Promise<SkillRunDetail> => {
    const generation = requestGenerationRef.current + 1;
    requestGenerationRef.current = generation;
    const pendingRevisionAtRequest = pendingRevisionRef.current;
    return applyRunDetail(await fetchRun(runId), generation, pendingRevisionAtRequest);
  }, [applyRunDetail, runId]);

  const resolveToolLabel = useCallback((tool: string, skill: string | null): { label: string; action: string } => {
    const current = runRef.current;
    if (current && skill && skill === current.skill_slug) {
      return { label: `${current.skill_slug}@${current.skill_version ?? "?"}`, action: tool };
    }
    return { label: tool, action: "run" };
  }, []);

  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const load = async () => {
      try {
        const detail = await refreshRun();
        if (!live) return;
        if (detail.status === "queued" || detail.status === "starting") {
          timer = setTimeout(() => void load(), STARTING_POLL_MS);
        }
      } catch (error) {
        if (!live) return;
        setLoadError(error instanceof Error ? error.message : "Could not load the run.");
        const lastKnown = runRef.current;
        if (lastKnown && (lastKnown.status === "queued" || lastKnown.status === "starting")) {
          timer = setTimeout(() => void load(), STARTING_POLL_MS);
        }
      }
    };
    void load();
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, [loadRetryNonce, refreshRun]);

  useEffect(() => {
    requestGenerationRef.current = 0;
    appliedGenerationRef.current = 0;
    pendingRevisionRef.current = 0;
    promptStatusRef.current.clear();
    promptSseObservedRef.current.clear();
    promptProcessedRef.current.clear();
    removedAttachmentIdsRef.current.clear();
    statusActivationRevisionRef.current = null;
    appliedTranscriptSequenceRef.current = -1;
    lastEventIdRef.current = null;
    dispatch({ kind: "reset" });
    setRun(null);
    setLoadError(null);
    setText("");
    setFiles([]);
    setPromptError(null);
    setUploadProgress(null);
    setStreamReady(false);
    setStreamDead(false);
    setRowOverride(new Map());
    setCancelRequestedLocal(false);
    setCancelBusy(false);
    setPromptCancelBusy(false);
    setFilesOpen(false);
    setShowPromptBubble(false);
    promptAttemptRef.current = null;
  }, [runId]);

  useEffect(() => {
    if (!run || run.status === "queued" || run.status === "starting") return;
    const liveCursor = Number(lastEventIdRef.current ?? 0);
    if (run.transcript_event_sequence < liveCursor) return;
    if (run.transcript_event_sequence <= appliedTranscriptSequenceRef.current) return;
    appliedTranscriptSequenceRef.current = run.transcript_event_sequence;
    if (run.transcript_event_sequence > liveCursor) lastEventIdRef.current = String(run.transcript_event_sequence);
    setShowPromptBubble(!run.transcript.some((item) => item.kind === "user"));
    dispatch({ kind: "history", items: run.transcript, attachments: run.attachments, resolveToolLabel });
    setStreamDead(false);
  }, [resolveToolLabel, run]);

  useEffect(() => {
    if (!run) return;
    for (const warning of run.warnings) {
      dispatch({
        kind: "event",
        event: { type: "run.warning", code: warning.code, message: warning.message, phase: warning.phase },
        resolveToolLabel,
      });
    }
  }, [resolveToolLabel, run]);

  useEffect(() => {
    if (run && ["frozen", "error", "canceled"].includes(run.status)) setCancelRequestedLocal(false);
  }, [run]);

  useEffect(() => {
    const until = run?.reactivatable_until ? Date.parse(run.reactivatable_until) : Number.NaN;
    if (!Number.isFinite(until)) return;
    setReactivationClock(Date.now());
    const remaining = until - Date.now();
    if (remaining <= 0) return;
    const timer = setTimeout(() => setReactivationClock(Date.now()), Math.min(remaining + 25, 2_147_483_647));
    return () => clearTimeout(timer);
  }, [run?.reactivatable_until]);

  const status = run?.status ?? "starting";
  useEffect(() => {
    if (status !== "running" || streamDead) return;
    const controller = new AbortController();
    setStreamReady(false);
    void openRunStream(
      runId,
      (event) => {
        setStreamReady(true);
        if (event.type === "error" && event.message === "This session has ended.") {
          setStreamReady(false);
          setStreamDead(true);
          void refreshRun().catch((cause) => {
            setLoadError(cause instanceof Error ? cause.message : "Could not refresh the completed run.");
          });
          return;
        }

        if (event.type === "prompt.status") {
          const current = runRef.current;
          const pending = current?.pending_prompts.find((prompt) => prompt.id === event.prompt_id);
          if (event.status === "processing") promptProcessedRef.current.add(event.prompt_id);
          if (event.status === "processing" && pending?.kind === "follow_up") {
            const visible = chatRef.current.items.some((item) => item.kind === "user" && item.messageId === event.message_id);
            if (!visible) {
              dispatch({ kind: "user", text: pending.text, messageId: pending.message_id, attachments: pending.attachments });
            }
          }
          const knownStatus = promptStatusRef.current.get(event.prompt_id);
          const effectiveStatus = orderedPromptStatus(knownStatus, event.status);
          let revisionAdvanced = false;
          if (knownStatus !== effectiveStatus) {
            pendingRevisionRef.current += 1;
            promptStatusRef.current.set(event.prompt_id, effectiveStatus);
            revisionAdvanced = true;
          }
          promptSseObservedRef.current.add(event.prompt_id);
          if (current) {
            const removedAttachmentIds = effectiveStatus === "canceled" && pending?.status === "queued"
              ? new Set(pending.attachments.map((attachment) => attachment.id))
              : null;
            if (removedAttachmentIds) {
              for (const attachmentId of removedAttachmentIds) removedAttachmentIdsRef.current.add(attachmentId);
            }
            const folded = foldPromptStatusDetail(current, { ...event, status: effectiveStatus });
            const next = removedAttachmentIds
              ? {
                  ...folded,
                  attachments: folded.attachments.filter((attachment) => !removedAttachmentIds.has(attachment.id)),
                }
              : folded;
            if (next !== current) {
              if (!revisionAdvanced) pendingRevisionRef.current += 1;
              runRef.current = next;
              setRun(next);
            }
          }
        }
        dispatch({ kind: "event", event, resolveToolLabel });
        setStreamDead(false);
        if (event.type === "session.idle" || event.type === "artifacts.updated" || event.type === "prompt.status") {
          void refreshRun().catch(() => undefined);
        } else if (event.type === "run.error") {
          void refreshRun().catch(() => undefined);
        } else if (event.type === "error") {
          setStreamDead(true);
          setStreamReady(false);
          void refreshRun().catch(() => undefined);
        }
      },
      controller.signal,
      {
        lastEventId: lastEventIdRef.current,
        onEventId: (id) => { lastEventIdRef.current = id; },
        onConnected: () => {
          setStreamReady(true);
          setStreamDead(false);
          dispatch({ kind: "connected" });
        },
        onStreamEnd: async () => {
          try {
            return ["frozen", "error", "canceled"].includes((await refreshRun()).status);
          } catch {
            return false;
          }
        },
      },
    );
    return () => controller.abort();
  }, [reconnectNonce, refreshRun, resolveToolLabel, runId, status, streamDead]);

  const cancelRequested = cancelRequestedLocal || run?.phase === "cancel";
  const fileSignature = files.map((file) => [file.name, file.size, file.type, file.lastModified].join(":" )).join("|");
  const terminalCanReactivate = canReactivateRun(run, reactivationClock);
  const liveSendReady = status === "running" && !cancelRequested && streamReady && !streamDead;
  const composerDisabled = !canUseRunComposer(status, liveSendReady, terminalCanReactivate);
  const queuedCount = run?.pending_prompts.filter((prompt) => prompt.kind === "follow_up" && prompt.status === "queued").length ?? 0;
  const queueFull = queuedCount >= RUN_PROMPT_MAX_QUEUED;
  const streamingAssistant = chat.items.some((item) => item.kind === "asst" && item.streaming);
  const showWorking = chat.working.active && !streamingAssistant && status === "running";

  const mergeAcceptedPrompt = (response: RunPromptAccepted, promptText: string): RunPromptStatus | null => {
    const current = runRef.current;
    if (!current) return null;
    const knownStatus = promptStatusRef.current.get(response.prompt_id);
    const effectiveStatus = promptSseObservedRef.current.has(response.prompt_id) && knownStatus
      ? knownStatus
      : newerPromptStatus(knownStatus, response.status);
    const canceledBeforeProcessing = effectiveStatus === "canceled"
      && response.status === "queued"
      && !promptProcessedRef.current.has(response.prompt_id);
    if (canceledBeforeProcessing) {
      for (const attachment of response.attachments) removedAttachmentIdsRef.current.add(attachment.id);
    }
    const acknowledged = {
      ...response,
      status: effectiveStatus,
      attachments: canceledBeforeProcessing ? [] : response.attachments,
    };
    const next = mergeAcceptedPromptDetail(current, acknowledged, promptText);
    const resolvedStatus = next.pending_prompts.find((prompt) => prompt.id === response.prompt_id)?.status
      ?? effectiveStatus;
    pendingRevisionRef.current += 1;
    promptStatusRef.current.set(response.prompt_id, resolvedStatus);
    runRef.current = next;
    setRun(next);
    return resolvedStatus;
  };

  const send = () => {
    const trimmed = text.trim();
    if (promptSendingRef.current || composerDisabled || queueFull || (!trimmed && files.length === 0)) return;
    const terminalDelivery = status === "frozen" || status === "canceled";
    const previous = promptAttemptRef.current;
    const retrying = previous?.text === trimmed && previous.fileSignature === fileSignature;
    const attempt = retrying
      ? previous
      : { text: trimmed, fileSignature, files: [...files], idempotencyKey: crypto.randomUUID() };
    if (!attempt) return;

    promptSendingRef.current = true;
    promptAttemptRef.current = attempt;
    setSending(true);
    setPromptError(null);
    setUploadProgress(attempt.files.length > 0 ? 0 : null);
    sendRunPrompt(
      runId,
      trimmed,
      attempt.files,
      attempt.idempotencyKey,
      attempt.files.length > 0 ? setUploadProgress : undefined,
    )
      .then((response) => {
        // A previous API replica has no persistent queue fields or prompt.status events. Treat its
        // single accepted turn as active and refresh from its transcript instead of fabricating a
        // queue entry that could never receive a terminal transition.
        const effectiveStatus = response.legacy ? "processing" : mergeAcceptedPrompt(response, trimmed);
        const visible = chatRef.current.items.some((item) => item.kind === "user" && item.messageId === response.message_id);
        // A queued follow-up belongs only in the durable queue. It enters the transcript once the
        // worker actually starts it; this also means removing queued work leaves no false message.
        if ((effectiveStatus === "processing" || promptProcessedRef.current.has(response.prompt_id)) && !visible) {
          dispatch({ kind: "user", text: trimmed, messageId: response.message_id, attachments: response.attachments });
        }
        if (effectiveStatus === "processing") {
          dispatch({ kind: "send" });
        }
        setText("");
        setFiles([]);
        promptAttemptRef.current = null;
        setPromptError(null);
        if (response.reactivated) {
          setStreamReady(false);
          setStreamDead(false);
          const current = runRef.current;
          if (current) {
            const acceptedStatus = promptStatusRef.current.get(response.prompt_id);
            promptStatusRef.current.clear();
            promptSseObservedRef.current.clear();
            promptProcessedRef.current.clear();
            if (acceptedStatus) promptStatusRef.current.set(response.prompt_id, acceptedStatus);
            const next = {
              ...current,
              status: "queued" as const,
              phase: "queued" as const,
              error_code: null,
              error_message: null,
              status_detail: null,
              activation_revision: current.activation_revision + 1,
              reactivatable_until: null,
              can_reactivate: false,
            };
            statusActivationRevisionRef.current = next.activation_revision;
            runRef.current = next;
            setRun(next);
          }
        }
        if (response.legacy) {
          void refreshRun().catch(() => undefined);
        } else if (terminalDelivery) {
          setLoadRetryNonce((value) => value + 1);
          if (!response.reactivated) void refreshRun().catch(() => undefined);
        } else {
          void refreshRun().catch(() => undefined);
        }
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : "Could not send the message.";
        setPromptError(`Delivery status is unknown. Retry safely: ${message}`);
        if (shouldRestartPollingAfterPromptFailure(status)) setLoadRetryNonce((value) => value + 1);
        void refreshRun().catch(() => undefined);
      })
      .finally(() => {
        promptSendingRef.current = false;
        setSending(false);
        setUploadProgress(null);
      });
  };

  const addFiles = (incoming: FileList | null) => {
    if (!incoming) return;
    promptAttemptRef.current = null;
    const persistedBytes = run?.attachments.reduce((sum, attachment) => sum + attachment.byte_size, 0) ?? 0;
    const next = appendRunAttachmentFiles({ files, incoming, persistedBytes });
    setPromptError(next.error);
    setFiles(next.files);
  };

  const attachmentDisabled = composerDisabled || sending || queueFull || files.length >= RUN_ATTACHMENT_MAX_FILES;
  const { dragOver, dropProps } = useRunFileDrop<HTMLDivElement>({ disabled: attachmentDisabled, onFiles: addFiles });

  const rerun = () => {
    if (!run) return;
    onRunAgain({
      prompt: run.prompt,
      files: [],
      model: run.model,
      inputs: runInputsFromSnapshot(run.input_snapshot),
      configurationId: run.run_config_id ?? null,
    });
  };

  const requestCancel = () => {
    if (!run || cancelBusy || !["queued", "starting", "running"].includes(run.status)) return;
    setCancelRequestedLocal(true);
    setCancelBusy(true);
    cancelRun(run.id)
      .then((detail) => {
        const generation = requestGenerationRef.current + 1;
        requestGenerationRef.current = generation;
        applyRunDetail(detail, generation);
      })
      .catch((cause) => {
        setCancelRequestedLocal(false);
        setPromptError(cause instanceof Error ? cause.message : "Could not end the session.");
      })
      .finally(() => setCancelBusy(false));
  };

  const requestPromptCancel = (promptId: string) => {
    if (!run || promptCancelBusy) return;
    const target = run.pending_prompts.find((prompt) => prompt.id === promptId);
    if (!target) return;
    if (target.kind === "initial" && target.status === "queued") {
      requestCancel();
      return;
    }
    setPromptCancelBusy(true);
    setPromptError(null);
    cancelRunPrompt(run.id, promptId)
      .then((response) => {
        const current = runRef.current;
        if (current) {
          const terminal = response.status === "completed" || response.status === "canceled" || response.status === "error";
          const pendingPrompts = terminal
            ? current.pending_prompts.filter((prompt) => prompt.id !== promptId)
            : response.status === "cancel_requested"
              ? current.pending_prompts.map((prompt) => prompt.id === promptId ? { ...prompt, status: "cancel_requested" as const } : prompt)
              : current.pending_prompts;
          const removedAttachmentIds = response.status === "canceled" && target.status === "queued"
            ? new Set(target.attachments.map((attachment) => attachment.id))
            : null;
          if (removedAttachmentIds) {
            for (const attachmentId of removedAttachmentIds) removedAttachmentIdsRef.current.add(attachmentId);
          }
          const next = {
            ...current,
            pending_prompts: pendingPrompts,
            attachments: removedAttachmentIds
              ? current.attachments.filter((attachment) => !removedAttachmentIds.has(attachment.id))
              : current.attachments,
          };
          pendingRevisionRef.current += 1;
          promptStatusRef.current.set(promptId, newerPromptStatus(
            promptStatusRef.current.get(promptId),
            response.status,
          ));
          runRef.current = next;
          setRun(next);
        }
        void refreshRun().catch(() => undefined);
      })
      .catch((cause) => {
        setPromptError(cause instanceof Error ? cause.message : "Could not update this follow-up.");
      })
      .finally(() => setPromptCancelBusy(false));
  };

  const rowExpanded = (id: string, defaultOpen: boolean) => rowOverride.get(id) ?? defaultOpen;
  const toggleRow = (id: string, defaultOpen: boolean) => {
    setRowOverride((previous) => {
      const next = new Map(previous);
      next.set(id, !(previous.get(id) ?? defaultOpen));
      return next;
    });
  };

  const retryLoad = () => {
    setLoadError(null);
    setStreamDead(false);
    setReconnectNonce((value) => value + 1);
    setLoadRetryNonce((value) => value + 1);
  };

  if (loadError && !run) {
    return (
      <div data-screen-label="Run" className="run-chat-load-error">
        <p role="alert">{loadError}</p>
        <div>
          <button type="button" className="btn-primary" onClick={retryLoad}><Icon name="refresh-cw" size={13} />Retry</button>
          <button type="button" className="btn-sec" onClick={onBack}><Icon name="arrow-left" size={13} />Back</button>
        </div>
      </div>
    );
  }

  const statusWord = cancelRequested ? "ending" : status === "frozen" ? "ended" : status;
  const dotClass = status === "running"
    ? "vdot vdot--ok"
    : status === "queued" || status === "starting"
      ? "vdot vdot--warn"
      : status === "error"
        ? "vdot vdot--down"
        : "vdot vdot--unknown";
  const fileCount = (run?.attachments.length ?? 0) + (run?.artifacts.length ?? 0);
  const placeholder = queueFull
    ? "Follow-up queue is full"
    : status === "running"
      ? "Send a follow-up or attach files"
      : status === "queued"
        ? "Run queued"
        : status === "starting"
          ? "Starting run"
          : (status === "frozen" || status === "canceled") && terminalCanReactivate
            ? "Send a message to reactivate"
            : "This session is read-only";

  return (
    <div data-screen-label="Run" className="run-chat-shell">
      <header className="run-chat-topbar">
        <button type="button" className="run-chat-topbar__back" onClick={onBack} aria-label="Back to skill">
          <Icon name="arrow-left" size={15} />
        </button>
        <div className="run-chat-topbar__identity">
          <strong>{run ? `${run.skill_slug}${run.skill_version ? `@${run.skill_version}` : ""}` : "Loading"}</strong>
          <span className={dotClass} />
          <code>{statusWord}{run?.phase ? ` · ${phaseLabel(run.phase)}` : ""}</code>
        </div>
        <div className="run-chat-topbar__meta">
          {run?.run_config_name_snapshot && <span>{run.run_config_name_snapshot}</span>}
          {run && <code>{run.model}</code>}
        </div>
        <button
          ref={filesButtonRef}
          type="button"
          className="btn-sec run-chat-topbar__files"
          disabled={!run}
          onClick={openFiles}
        >
          <Icon name="folder-open" size={13} />
          Files · {fileCount}
        </button>
        <details className="run-chat-menu">
          <summary aria-label="Run actions"><Icon name="more-horizontal" size={16} /></summary>
          <div>
            <button type="button" onClick={rerun} disabled={!run}><Icon name="rotate-ccw" size={13} />Run again</button>
            {["queued", "starting", "running"].includes(status) && (
              <button type="button" className="is-danger" disabled={cancelBusy || cancelRequested} onClick={requestCancel}>
                <Icon name="ban" size={13} />
                {cancelBusy || cancelRequested ? "Ending session" : "End session"}
              </button>
            )}
          </div>
        </details>
      </header>

      {loadError && (
        <div className="run-chat__load-warning" role="alert">
          <Icon name="alert-triangle" size={13} />
          <span>Could not refresh this run. Showing the latest snapshot.</span>
          <button type="button" className="btn-sec" onClick={retryLoad}>Retry</button>
        </div>
      )}
      {(status === "queued" || status === "starting") && <StartingBanner status={status} phase={run?.phase} />}
      {status === "frozen" && run && (
        <FrozenBanner
          note={terminalCanReactivate ? "Send a message below to reactivate it." : "The reactivation window has expired."}
          canReactivate={terminalCanReactivate}
          onRunAgain={rerun}
        />
      )}
      {status === "canceled" && run && (
        <FrozenBanner
          note={terminalCanReactivate ? "Reactivate from the last durable snapshot." : "The reactivation window has expired."}
          canReactivate={terminalCanReactivate}
          onRunAgain={rerun}
        />
      )}
      {status === "error" && run && (
        <div className="run-chat-banner run-chat-banner--error" role="alert">
          <Icon name="alert-triangle" size={13} />
          <b>Run failed</b>
          <span>{run.error_message ?? run.status_detail ?? "The runtime stopped unexpectedly."}</span>
          <button type="button" className="btn-sec" onClick={rerun}>Try again</button>
        </div>
      )}

      <main className="run-chat-main">
        <ChatTranscript
          run={run}
          chat={chat}
          showPromptBubble={showPromptBubble}
          showWorking={showWorking}
          streamDead={streamDead}
          rowExpanded={rowExpanded}
          onToggleRow={toggleRow}
          onReconnect={() => {
            setStreamDead(false);
            setReconnectNonce((value) => value + 1);
          }}
          onOpenFiles={openFiles}
        />
        <ChatComposer
          text={text}
          files={files}
          pendingPrompts={run?.pending_prompts ?? []}
          disabled={composerDisabled}
          submitDisabled={queueFull}
          attachmentDisabled={attachmentDisabled}
          sending={sending}
          stopBusy={promptCancelBusy}
          dragOver={dragOver}
          uploadProgress={uploadProgress}
          promptError={promptError}
          placeholder={placeholder}
          helper={queueFull ? `Queue full · ${RUN_PROMPT_MAX_QUEUED} follow-ups` : "Up to 5 files · 10 MB each · 100 MB per run"}
          dropProps={dropProps}
          onTextChange={(value) => {
            if (promptAttemptRef.current?.text !== value.trim()) promptAttemptRef.current = null;
            setPromptError(null);
            setText(value);
          }}
          onAddFiles={addFiles}
          onRemoveFile={(index) => {
            promptAttemptRef.current = null;
            setPromptError(null);
            setFiles((current) => current.filter((_, itemIndex) => itemIndex !== index));
          }}
          onSend={send}
          onCancelPrompt={requestPromptCancel}
        />
      </main>

      <RunFilesDrawer
        open={filesOpen}
        runId={runId}
        attachments={run?.attachments ?? []}
        artifacts={run?.artifacts ?? []}
        returnFocusRef={filesButtonRef}
        onClose={closeFiles}
      />
    </div>
  );
}
