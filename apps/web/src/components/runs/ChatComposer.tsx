"use client";

import { useLayoutEffect, useRef, type ClipboardEvent, type HTMLAttributes, type KeyboardEvent } from "react";
import type { PendingRunPrompt } from "@companion/contracts";
import { Icon } from "../Icon";
import { RunAttachmentButton } from "./RunAttachmentButton";
import { DraftAttachmentList } from "./ChatMedia";

function QueueRow({
  prompt,
  busy,
  onCancel,
}: {
  prompt: PendingRunPrompt;
  busy: boolean;
  onCancel: (id: string) => void;
}) {
  const label = prompt.kind === "initial"
    ? prompt.status === "queued" ? "Starting" : prompt.status === "cancel_requested" ? "Stopping" : "Current turn"
    : prompt.status === "queued" ? `Queued · ${prompt.ordinal}` : prompt.status === "cancel_requested" ? "Stopping" : "Current turn";
  return (
    <li className={`run-prompt-queue__row is-${prompt.status}`}>
      <span className="run-prompt-queue__status">
        {prompt.status === "processing" ? <Icon name="loader" size={12} className="ls-spin" /> : <Icon name="clock" size={12} />}
        {label}
      </span>
      <span className="run-prompt-queue__text" title={prompt.text || "Files only"}>{prompt.text || "Files only"}</span>
      {prompt.attachments.length > 0 && <small>{prompt.attachments.length} file{prompt.attachments.length === 1 ? "" : "s"}</small>}
      {prompt.kind === "follow_up" && prompt.status === "queued" && (
        <button type="button" disabled={busy} onClick={() => onCancel(prompt.id)} aria-label={`Remove queued follow-up ${prompt.ordinal}`}>
          <Icon name="x" size={12} />
        </button>
      )}
    </li>
  );
}

export function ChatComposer({
  text,
  files,
  pendingPrompts,
  disabled,
  submitDisabled,
  attachmentDisabled,
  sending,
  stopBusy,
  dragOver,
  uploadProgress,
  promptError,
  placeholder,
  helper,
  dropProps,
  onTextChange,
  onAddFiles,
  onRemoveFile,
  onSend,
  onCancelPrompt,
}: {
  text: string;
  files: File[];
  pendingPrompts: PendingRunPrompt[];
  disabled: boolean;
  submitDisabled: boolean;
  attachmentDisabled: boolean;
  sending: boolean;
  stopBusy: boolean;
  dragOver: boolean;
  uploadProgress: number | null;
  promptError: string | null;
  placeholder: string;
  helper: string;
  dropProps: HTMLAttributes<HTMLDivElement>;
  onTextChange: (value: string) => void;
  onAddFiles: (files: FileList) => void;
  onRemoveFile: (index: number) => void;
  onSend: () => void;
  onCancelPrompt: (id: string) => void;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const composingRef = useRef(false);
  const activePrompt = pendingPrompts.find((prompt) => prompt.status !== "queued") ?? null;
  const hasMessage = text.trim().length > 0 || files.length > 0;

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "0px";
    textarea.style.height = `${Math.min(160, Math.max(48, textarea.scrollHeight))}px`;
  }, [text]);

  const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    if (disabled || attachmentDisabled || event.clipboardData.files.length === 0) return;
    onAddFiles(event.clipboardData.files);
    if (!event.clipboardData.getData("text/plain")) event.preventDefault();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing || composingRef.current) return;
    event.preventDefault();
    if (!sending && !submitDisabled && hasMessage) onSend();
  };

  return (
    <div className={`run-composer${dragOver ? " is-dragover" : ""}`} {...dropProps}>
      {pendingPrompts.length > 0 && (
        <div className="run-prompt-queue">
          <div className="run-prompt-queue__head">
            <span>Turns</span>
            <small>{pendingPrompts.filter((prompt) => prompt.kind === "follow_up" && prompt.status === "queued").length} follow-ups queued</small>
          </div>
          <ol>
            {pendingPrompts.map((prompt) => (
              <QueueRow key={prompt.id} prompt={prompt} busy={stopBusy} onCancel={onCancelPrompt} />
            ))}
          </ol>
        </div>
      )}
      <DraftAttachmentList files={files} disabled={sending} onRemove={onRemoveFile} />
      <div className="run-composer__box">
        <label className="sr-only" htmlFor="run-follow-up">Send a follow-up message</label>
        <textarea
          id="run-follow-up"
          ref={textareaRef}
          value={text}
          rows={1}
          disabled={disabled || sending}
          placeholder={placeholder}
          aria-describedby={promptError ? "run-follow-up-error" : "run-follow-up-help"}
          onChange={(event) => onTextChange(event.target.value)}
          onPaste={handlePaste}
          onCompositionStart={() => { composingRef.current = true; }}
          onCompositionEnd={() => { composingRef.current = false; }}
          onKeyDown={handleKeyDown}
        />
        <div className="run-composer__actions">
          <RunAttachmentButton disabled={attachmentDisabled} onFiles={onAddFiles} />
          <span className="run-composer__spacer" />
          {uploadProgress !== null && (
            <span className="run-composer__progress">
              <progress aria-label="Uploading files" value={uploadProgress} max={100} />
              <span aria-hidden="true">Uploading · {uploadProgress}%</span>
            </span>
          )}
          {activePrompt && (
            <button
              type="button"
              className="run-composer__stop"
              disabled={stopBusy || activePrompt.status === "cancel_requested"}
              onClick={() => onCancelPrompt(activePrompt.id)}
            >
              <span aria-hidden="true" />
              {stopBusy || activePrompt.status === "cancel_requested" ? "Stopping" : "Stop"}
            </button>
          )}
          {(!activePrompt || hasMessage) && (
            <button
              type="button"
              className="run-composer__send"
              disabled={disabled || submitDisabled || sending || !hasMessage}
              onClick={onSend}
              aria-label="Send"
            >
              {sending ? <Icon name="loader" size={15} className="ls-spin" /> : <Icon name="arrow-up" size={15} />}
            </button>
          )}
        </div>
      </div>
      <div className="run-composer__foot">
        <span id="run-follow-up-help">{dragOver ? "Drop files here" : helper}</span>
        <kbd>Enter</kbd><span>send</span><span>·</span><kbd>Shift Enter</kbd><span>new line</span>
      </div>
      {promptError && <p className="run-chat__prompt-error" id="run-follow-up-error" role="alert">{promptError}</p>}
    </div>
  );
}
