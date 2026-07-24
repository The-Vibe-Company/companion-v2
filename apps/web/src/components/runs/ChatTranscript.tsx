"use client";

import {
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { MessageScroller, useMessageScrollerScrollable } from "@shadcn/react/message-scroller";
import type { SkillRunDetail } from "@companion/contracts";
import { formatDurationSeconds } from "@/lib/format";
import { Icon } from "../Icon";
import { ChatMarkdown } from "./chatMarkdown";
import type { ChatItem, ChatState } from "./chatStream";
import { copyRunText } from "./clipboard";
import { toolIcon } from "./derive";
import { RunAttachmentList } from "./ChatMedia";

export type GeneratedProjectFile = {
  id: string;
  path: string;
  name: string;
  version: number;
  contentType: string;
  byteSize: number;
  action: "created" | "updated";
};

type GeneratedProjectFileTurn = {
  messageId: string;
  files: GeneratedProjectFile[];
};

function ProjectGeneratedFilesMarker({
  messageId,
  files,
  onOpenFiles,
}: {
  messageId: string;
  files: GeneratedProjectFile[];
  onOpenFiles: (
    fileId?: string,
    version?: number,
    file?: GeneratedProjectFile,
  ) => void;
}) {
  const created = files.filter((file) => file.action === "created");
  const updated = files.filter((file) => file.action === "updated");
  return (
    <MessageScroller.Item
      messageId={`project:generated-files:${messageId}`}
      className="run-marker run-marker--wide"
    >
      <div className="run-generated-marker run-generated-marker--project">
        <div className="run-generated-marker__summary">
          <Icon name="folder-open" size={13} />
          <span>
            {created.length > 0 && `Created files · ${created.length}`}
            {created.length > 0 && updated.length > 0 && " · "}
            {updated.length > 0 && `Updated files · ${updated.length}`}
          </span>
        </div>
        <ul className="run-generated-marker__files" aria-label="Files from this task">
          {files.map((file) => (
            <li key={`${file.id}:${file.version}`}>
              <button
                type="button"
                className="run-generated-marker__file"
                data-project-file-id={file.id}
                onClick={() => onOpenFiles(file.id, file.version, file)}
                aria-label={`Open ${file.name}, version ${file.version}`}
              >
                <span>{file.name}</span>
                <small>v{file.version}</small>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </MessageScroller.Item>
  );
}

function CopyMessageButton({ text }: { text: string }) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">("idle");
  useEffect(() => {
    if (copyState === "idle") return;
    const timer = window.setTimeout(() => setCopyState("idle"), 1_600);
    return () => window.clearTimeout(timer);
  }, [copyState]);
  const label = copyState === "copied" ? "Copied" : copyState === "error" ? "Copy failed" : "Copy";
  return (
    <button
      type="button"
      className="run-message-action"
      onClick={() => {
        void copyRunText(text).then((copied) => setCopyState(copied ? "copied" : "error"));
      }}
      aria-label={copyState === "copied" ? "Response copied" : copyState === "error" ? "Response copy failed" : "Copy response"}
    >
      <Icon name={copyState === "copied" ? "check" : copyState === "error" ? "alert-triangle" : "copy"} size={12} />
      {label}
    </button>
  );
}

function ToolMarker({
  item,
  expanded,
  onToggle,
}: {
  item: Extract<ChatItem, { kind: "tool" }>;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <div className={`run-tool${item.running ? " is-running" : ""}`}>
      <button type="button" className="run-tool__trigger" onClick={onToggle} aria-expanded={expanded}>
        <Icon name="chevron-right" size={12} className={expanded ? "is-open" : undefined} />
        <Icon name={toolIcon(item.tool)} size={13} />
        <b>{item.label}</b>
        <span>{item.action}</span>
        <span className="run-tool__spacer" />
        {item.running ? <Icon name="loader" size={12} className="ls-spin" /> : <Icon name="check" size={12} />}
        <small>{item.running ? "running" : formatDurationSeconds(item.durationMs)}</small>
      </button>
      {expanded && (
        <div className="run-tool__body">
          <span>Input</span>
          <pre>{item.input || "None"}</pre>
          <span>Result</span>
          <pre>{item.output || "Waiting for result…"}</pre>
        </div>
      )}
    </div>
  );
}

function ReasoningMarker({
  item,
  expanded,
  onToggle,
}: {
  item: Extract<ChatItem, { kind: "reasoning" }>;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="run-reasoning">
      <button type="button" onClick={onToggle} aria-expanded={expanded}>
        <Icon name="chevron-right" size={11} className={expanded ? "is-open" : undefined} />
        {item.streaming ? <Icon name="loader" size={11} className="ls-spin" /> : <Icon name="message-square" size={11} />}
        <span>{item.streaming ? "Reasoning" : "Reasoning complete"}</span>
      </button>
      {expanded && <div className="run-reasoning__body">{item.text}</div>}
    </div>
  );
}

function WorkingMarker({ label }: { label: string }) {
  return (
    <div className="run-working" role="status" aria-live="polite">
      <Icon name="loader" size={12} className="ls-spin" />
      <span>{label || "Working"}</span>
    </div>
  );
}

function JumpToLatest({ revision }: { revision: string }) {
  const scrollable = useMessageScrollerScrollable();
  const previousRevision = useRef(revision);
  const [unseen, setUnseen] = useState(0);

  useEffect(() => {
    if (revision === previousRevision.current) return;
    previousRevision.current = revision;
    if (scrollable.end) setUnseen((count) => count + 1);
  }, [revision, scrollable.end]);

  useEffect(() => {
    if (!scrollable.end) setUnseen(0);
  }, [scrollable.end]);

  return (
    <MessageScroller.Button direction="end" behavior="smooth" className="run-chat-jump">
      <Icon name="chevron-down" size={13} />
      <span>Latest{unseen > 0 ? ` · ${unseen}` : ""}</span>
    </MessageScroller.Button>
  );
}

export function ChatTranscript({
  run,
  chat,
  showPromptBubble,
  showWorking,
  streamDead,
  rowExpanded,
  onToggleRow,
  onReconnect,
  onOpenFiles,
  generatedFileTurns = [],
  renderUserAttachments,
  showChatError = true,
  ariaLabel = "Run transcript",
}: {
  run: SkillRunDetail | null;
  chat: ChatState;
  showPromptBubble: boolean;
  showWorking: boolean;
  streamDead: boolean;
  rowExpanded: (id: string, defaultOpen: boolean) => boolean;
  onToggleRow: (id: string, defaultOpen: boolean) => void;
  onReconnect: () => void;
  onOpenFiles: (
    artifactId?: string,
    version?: number,
    file?: GeneratedProjectFile,
  ) => void;
  generatedFileTurns?: GeneratedProjectFileTurn[];
  renderUserAttachments?: (
    messageId: string | null,
    text: string,
  ) => ReactNode;
  showChatError?: boolean;
  ariaLabel?: string;
}) {
  const terminalStatus = run?.status ?? "starting";
  const revision = [
    chat.items.length,
    run?.artifacts.length ?? 0,
    generatedFileTurns.reduce((count, turn) => count + turn.files.length, 0),
  ].join(":");
  const artifactPaths = useMemo(() => Object.fromEntries(
    (run?.artifacts ?? []).flatMap((artifact) => {
      const normalized = artifact.path.startsWith("./") ? artifact.path : `./${artifact.path}`;
      return [[normalized, artifact.id], [normalized.slice(2), artifact.id]];
    }),
  ), [run?.artifacts]);
  const generatedFilesByEndItem = useMemo(() => {
    const filesByMessage = new Map(
      generatedFileTurns.map((turn) => [turn.messageId, turn.files]),
    );
    const result = new Map<string, { messageId: string; files: GeneratedProjectFile[] }>();
    let activeMessageId: string | null = null;
    let lastItemId: string | null = null;
    const finishTurn = () => {
      if (!activeMessageId || !lastItemId) return;
      const files = filesByMessage.get(activeMessageId);
      if (files?.length) {
        result.set(lastItemId, { messageId: activeMessageId, files });
      }
    };
    for (const item of chat.items) {
      if (item.kind === "user") {
        finishTurn();
        activeMessageId = item.messageId;
      }
      if (activeMessageId) lastItemId = item.id;
    }
    finishTurn();
    return result;
  }, [chat.items, generatedFileTurns]);

  return (
    <MessageScroller.Provider
      autoScroll
      defaultScrollPosition="last-anchor"
      scrollEdgeThreshold={12}
      scrollPreviousItemPeek={64}
      scrollMargin={16}
    >
      <MessageScroller.Root className="run-transcript">
        <MessageScroller.Viewport
          className="run-transcript__viewport"
          role="log"
          aria-label={ariaLabel}
          aria-live="polite"
          aria-relevant="additions"
          aria-atomic="false"
        >
          <MessageScroller.Content className="run-transcript__content" aria-busy={showWorking || undefined}>
            {run && showPromptBubble && terminalStatus !== "queued" && terminalStatus !== "starting" && (
              <MessageScroller.Item
                messageId={`${run.id}:prompt:0`}
                scrollAnchor
                className="run-message run-message--user"
              >
                {run.prompt && <div className="run-message__bubble">{run.prompt}</div>}
                <RunAttachmentList
                  runId={run.id}
                  attachments={run.attachments.filter((attachment) => attachment.prompt_ordinal === 0)}
                />
              </MessageScroller.Item>
            )}
            {chat.items.map((item) => {
              let content: ReactNode;
              if (item.kind === "sys") {
                content = (
                  <MessageScroller.Item messageId={item.id} className="run-marker">
                    <span>{item.text}</span>
                  </MessageScroller.Item>
                );
              } else if (item.kind === "user") {
                content = (
                  <MessageScroller.Item messageId={item.id} scrollAnchor className="run-message run-message--user">
                    {item.text && <div className="run-message__bubble">{item.text}</div>}
                    {renderUserAttachments ? (
                      renderUserAttachments(item.messageId, item.text)
                    ) : (
                      <RunAttachmentList
                        runId={run?.id ?? ""}
                        attachments={item.attachments}
                      />
                    )}
                  </MessageScroller.Item>
                );
              } else if (item.kind === "tool") {
                content = (
                  <MessageScroller.Item messageId={item.id} className="run-marker run-marker--wide">
                    <ToolMarker
                      item={item}
                      expanded={rowExpanded(item.id, item.running)}
                      onToggle={() => onToggleRow(item.id, item.running)}
                    />
                  </MessageScroller.Item>
                );
              } else if (item.kind === "reasoning") {
                content = (
                  <MessageScroller.Item messageId={item.id} className="run-marker run-marker--wide">
                    <ReasoningMarker
                      item={item}
                      expanded={rowExpanded(item.id, item.streaming)}
                      onToggle={() => onToggleRow(item.id, item.streaming)}
                    />
                  </MessageScroller.Item>
                );
              } else {
                content = (
                  <MessageScroller.Item messageId={item.id} className="run-message run-message--assistant">
                    <div className="run-message__assistant">
                      <ChatMarkdown text={item.text} streaming={item.streaming} artifactPaths={artifactPaths} onOpenArtifact={onOpenFiles} />
                      {!item.streaming && item.text && <CopyMessageButton text={item.text} />}
                    </div>
                  </MessageScroller.Item>
                );
              }
              const generatedTurn = generatedFilesByEndItem.get(item.id);
              return (
                <Fragment key={item.id}>
                  {content}
                  {generatedTurn && (
                    <ProjectGeneratedFilesMarker
                      messageId={generatedTurn.messageId}
                      files={generatedTurn.files}
                      onOpenFiles={onOpenFiles}
                    />
                  )}
                </Fragment>
              );
            })}
            {run && run.artifacts.length > 0 && (
              <MessageScroller.Item messageId={`${run.id}:artifacts`} className="run-marker">
                <button type="button" className="run-generated-marker" onClick={() => onOpenFiles(run.artifacts.at(-1)?.id)}>
                  <Icon name="folder-open" size={13} />
                  Generated files updated · {run.artifacts.length}
                </button>
              </MessageScroller.Item>
            )}
            {showWorking && (
              <MessageScroller.Item messageId={`${run?.id ?? "run"}:working`} className="run-marker run-marker--wide">
                <WorkingMarker label={chat.working.label} />
              </MessageScroller.Item>
            )}
            {chat.warnings.map((warning) => (
              <MessageScroller.Item
                key={`${warning.code}:${warning.message}`}
                messageId={`warning:${warning.code}:${warning.message}`}
                className="run-marker run-marker--wide"
              >
                <div className="run-chat__warning" role="status">
                  <Icon name="alert-triangle" size={13} />
                  <span><b>Warning</b> {warning.message}</span>
                </div>
              </MessageScroller.Item>
            ))}
            {showChatError &&
              chat.error &&
              chat.error !== "This session has ended." && (
              <MessageScroller.Item messageId={`${run?.id ?? "run"}:error`} className="run-marker run-marker--wide">
                <div className="run-transcript__error" role="alert">
                  {chat.error}
                  {streamDead && terminalStatus === "running" && (
                    <button type="button" className="btn-sec" onClick={onReconnect}>Reconnect</button>
                  )}
                </div>
              </MessageScroller.Item>
              )}
          </MessageScroller.Content>
        </MessageScroller.Viewport>
        <JumpToLatest revision={revision} />
      </MessageScroller.Root>
    </MessageScroller.Provider>
  );
}
