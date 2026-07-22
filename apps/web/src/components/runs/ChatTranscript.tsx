"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { MessageScroller, useMessageScrollerScrollable } from "@shadcn/react/message-scroller";
import type { SkillRunDetail } from "@companion/contracts";
import { formatDurationSeconds } from "@/lib/format";
import { Icon } from "../Icon";
import { ChatMarkdown } from "./chatMarkdown";
import type { ChatItem, ChatState } from "./chatStream";
import { copyRunText } from "./clipboard";
import { toolIcon } from "./derive";
import { RunAttachmentList } from "./ChatMedia";

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
}: {
  run: SkillRunDetail | null;
  chat: ChatState;
  showPromptBubble: boolean;
  showWorking: boolean;
  streamDead: boolean;
  rowExpanded: (id: string, defaultOpen: boolean) => boolean;
  onToggleRow: (id: string, defaultOpen: boolean) => void;
  onReconnect: () => void;
  onOpenFiles: (artifactId?: string) => void;
}) {
  const terminalStatus = run?.status ?? "starting";
  const revision = [
    chat.items.length,
    run?.artifacts.length ?? 0,
  ].join(":");
  const artifactPaths = useMemo(() => Object.fromEntries(
    (run?.artifacts ?? []).flatMap((artifact) => {
      const normalized = artifact.path.startsWith("./") ? artifact.path : `./${artifact.path}`;
      return [[normalized, artifact.id], [normalized.slice(2), artifact.id]];
    }),
  ), [run?.artifacts]);

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
          aria-label="Run transcript"
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
              if (item.kind === "sys") {
                return (
                  <MessageScroller.Item key={item.id} messageId={item.id} className="run-marker">
                    <span>{item.text}</span>
                  </MessageScroller.Item>
                );
              }
              if (item.kind === "user") {
                return (
                  <MessageScroller.Item key={item.id} messageId={item.id} scrollAnchor className="run-message run-message--user">
                    {item.text && <div className="run-message__bubble">{item.text}</div>}
                    <RunAttachmentList runId={run?.id ?? ""} attachments={item.attachments} />
                  </MessageScroller.Item>
                );
              }
              if (item.kind === "tool") {
                return (
                  <MessageScroller.Item key={item.id} messageId={item.id} className="run-marker run-marker--wide">
                    <ToolMarker
                      item={item}
                      expanded={rowExpanded(item.id, item.running)}
                      onToggle={() => onToggleRow(item.id, item.running)}
                    />
                  </MessageScroller.Item>
                );
              }
              if (item.kind === "reasoning") {
                return (
                  <MessageScroller.Item key={item.id} messageId={item.id} className="run-marker run-marker--wide">
                    <ReasoningMarker
                      item={item}
                      expanded={rowExpanded(item.id, item.streaming)}
                      onToggle={() => onToggleRow(item.id, item.streaming)}
                    />
                  </MessageScroller.Item>
                );
              }
              return (
                <MessageScroller.Item key={item.id} messageId={item.id} className="run-message run-message--assistant">
                  <div className="run-message__assistant">
                    <ChatMarkdown text={item.text} streaming={item.streaming} artifactPaths={artifactPaths} onOpenArtifact={onOpenFiles} />
                    {!item.streaming && item.text && <CopyMessageButton text={item.text} />}
                  </div>
                </MessageScroller.Item>
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
            {chat.error && chat.error !== "This session has ended." && (
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
