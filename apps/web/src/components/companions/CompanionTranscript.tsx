"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useAuiState,
  useExternalStoreRuntime,
  type AppendMessage,
  type AssistantRuntime,
  type TextMessagePartComponent,
  type ThreadMessageLike,
} from "@assistant-ui/react";
import type {
  Companion,
  CompanionThread as Thread,
  CompanionTranscriptEntry,
} from "@companion/contracts";
import { companionMessageEventId } from "@companion/contracts";
import { Icon } from "../Icon";
import {
  composerHint,
  replyExpected,
  transcriptTurns,
  type TranscriptTurn,
} from "./transcript";

/**
 * The conversation of one Companion, rendered through the assistant-ui Thread, Message, and Composer
 * primitives. The primitives own the transcript mechanics — viewport anchoring, the composer, keys,
 * focus — and nothing else: the messages come from the control-plane read model this component is
 * handed, sending goes back out through the same callback the rest of Companions uses, and no
 * assistant-ui thread list, cloud, history, or tool surface is wired up. A Viewer gets the transcript
 * with a read-only note where the composer would be, and the runtime has nothing to contact, so
 * reading a thread still cannot reach Box.
 */

/** Turn metadata by message id. The primitives render one component per message; this is its row. */
const TurnsContext = createContext<ReadonlyMap<string, TranscriptTurn>>(new Map());

function useTurn(): TranscriptTurn | undefined {
  const turns = useContext(TurnsContext);
  const id = useAuiState((state) => state.message.id);
  return id ? turns.get(id) : undefined;
}

const convertEntry = (entry: CompanionTranscriptEntry): ThreadMessageLike => ({
  id: entry.event_id,
  role: entry.role,
  content: [{ type: "text", text: entry.content }],
  createdAt: new Date(entry.created_at),
});

/** Server markup keeps the stable ISO minute; the local clock takes over on the client. */
function SentAt({ iso }: { iso: string }) {
  const [text, setText] = useState(() => iso.slice(11, 16));
  useEffect(() => setText(new Date(iso).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  })), [iso]);
  return <time dateTime={iso}>{text}</time>;
}

/** Message text is prose, not markup: Pi's reply is shown literally, with its own line breaks. */
const TurnText: TextMessagePartComponent = ({ text }) => <p className="chat-turn__text">{text}</p>;

const TEXT_ONLY = { Text: TurnText };

function Turn({ tone }: { tone: "said" | "reply" }) {
  const turn = useTurn();
  return (
    <MessagePrimitive.Root
      className={"chat-turn chat-turn--" + tone
        + (turn?.lead ? " chat-turn--lead" : "")
        + (turn?.sending ? " chat-turn--sending" : "")}
      aria-busy={turn?.sending || undefined}
    >
      {turn?.lead && turn.author && (
        <p className="chat-turn__meta">
          <span className="chat-turn__author">{turn.author}</span>
          <SentAt iso={turn.entry.created_at} />
        </p>
      )}
      <MessagePrimitive.Parts components={TEXT_ONLY} />
    </MessagePrimitive.Root>
  );
}

/**
 * What happened to the run, not what anyone said: a refused message or a turn that ended with nothing
 * to show. It stays a quiet line in the transcript instead of an error banner, because the
 * conversation continues around it.
 */
function Note() {
  return (
    <MessagePrimitive.Root className="chat-note">
      <MessagePrimitive.Parts components={TEXT_ONLY} />
    </MessagePrimitive.Root>
  );
}

const TURN_COMPONENTS = {
  UserMessage: () => <Turn tone="said" />,
  AssistantMessage: () => <Turn tone="reply" />,
  SystemMessage: Note,
};

/**
 * Keep one object per entry across polls. The thread is re-read every couple of seconds and arrives
 * as fresh JSON each time, so without this every message would look new to the runtime and the whole
 * transcript would re-render mid-conversation.
 */
function useStableEntries(entries: CompanionTranscriptEntry[]): CompanionTranscriptEntry[] {
  const seen = useRef(new Map<string, CompanionTranscriptEntry>());
  const previous = useRef<CompanionTranscriptEntry[]>([]);
  return useMemo(() => {
    const next = new Map<string, CompanionTranscriptEntry>();
    const stable = entries.map((entry) => {
      const kept = seen.current.get(entry.event_id);
      const unchanged = kept
        && kept.role === entry.role
        && kept.content === entry.content
        && kept.author_id === entry.author_id
        && kept.author_name === entry.author_name
        && kept.created_at === entry.created_at;
      const value = unchanged ? kept : entry;
      next.set(entry.event_id, value);
      return value;
    });
    seen.current = next;
    const same = stable.length === previous.current.length
      && stable.every((entry, index) => entry === previous.current[index]);
    if (same) return previous.current;
    previous.current = stable;
    return stable;
  }, [entries]);
}

function appendedText(message: AppendMessage): string {
  return message.content
    .map((part) => part.type === "text" ? part.text : "")
    .join("")
    .trim();
}

/** A failed send keeps its text: restore the draft unless something newer was typed meanwhile. */
function restoreDraft(runtime: AssistantRuntime | null, content: string): void {
  const composer = runtime?.thread.composer;
  if (!composer || composer.getState().text.trim()) return;
  composer.setText(content);
}

export function CompanionTranscript({
  companion,
  thread,
  busy,
  onSend,
}: {
  companion: Companion;
  thread: Thread | null;
  busy: boolean;
  onSend: (content: string, clientMessageId: string) => Promise<boolean>;
}) {
  const canSend = thread ? thread.can_send : companion.access !== "viewer";
  const awake = companion.runtime.state === "running";
  const viewerId = thread?.viewer_id ?? "";
  const runtimeRef = useRef<AssistantRuntime | null>(null);
  const inFlight = useRef(false);
  /**
   * The message this composer just sent, shown before the control plane answers. It already carries
   * the event id the control plane will store it under, so the saved entry replaces it rather than
   * joining it: the sent message cannot appear twice even if a thread read lands first. A refused send
   * drops it and hands the text back to the composer.
   */
  const [outgoing, setOutgoing] = useState<CompanionTranscriptEntry | null>(null);

  const entries = useMemo(() => {
    const saved = thread?.entries ?? [];
    if (!outgoing || saved.some((entry) => entry.event_id === outgoing.event_id)) return [...saved];
    return [...saved, outgoing];
  }, [outgoing, thread]);
  const messages = useStableEntries(entries);

  const turns = useMemo(
    () => transcriptTurns(messages, {
      viewerId,
      companionName: companion.name,
      sendingEventId: outgoing?.event_id ?? null,
    }),
    [companion.name, messages, outgoing, viewerId],
  );
  const turnsById = useMemo(
    () => new Map(turns.map((turn) => [turn.entry.event_id, turn])),
    [turns],
  );

  const send = useCallback(async (message: AppendMessage) => {
    const content = appendedText(message);
    // The composer blocks a second send while one is in flight; this closes the same door for a
    // programmatic one, so one message is never sent twice.
    if (!content || !canSend || inFlight.current) return;
    inFlight.current = true;
    // One submission, one id, kept for as long as this send lasts: whatever happens to the request,
    // the control plane can only ever store the turn it names once.
    const clientMessageId = crypto.randomUUID();
    setOutgoing({
      event_id: companionMessageEventId(clientMessageId),
      ordinal: Number.MAX_SAFE_INTEGER,
      role: "user",
      content,
      author_id: viewerId,
      author_name: null,
      created_at: new Date().toISOString(),
    });
    try {
      const saved = await onSend(content, clientMessageId);
      if (!saved) restoreDraft(runtimeRef.current, content);
    } finally {
      inFlight.current = false;
      setOutgoing(null);
    }
  }, [canSend, onSend, viewerId]);

  const runtime = useExternalStoreRuntime({
    messages,
    convertMessage: convertEntry,
    onNew: send,
    // Sending is the only thing this thread does: no editing, no branching, no regeneration, no
    // cancel, and no run of its own, so the primitives offer none of those controls.
    isDisabled: !canSend,
    isSendDisabled: busy,
  });
  useEffect(() => {
    runtimeRef.current = runtime;
  }, [runtime]);

  const replying = replyExpected({ entries: messages, awake });
  const empty = thread !== null && messages.length === 0;

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <TurnsContext.Provider value={turnsById}>
        <ThreadPrimitive.Root className="chat-thread">
          <ThreadPrimitive.Viewport
            className="chat-log"
            role="log"
            aria-live="polite"
            aria-busy={thread === null}
          >
            <div className="chat-column">
              {thread === null && (
                <>
                  {/* The skeleton is decorative; the wait itself still has to be announced. */}
                  <span className="sr-only" role="status">Loading conversation...</span>
                  <p className="chat-loading" aria-hidden="true">
                    <span /><span /><span />
                  </p>
                </>
              )}
              {empty && (
                <div className="chat-start">
                  <strong>No messages yet</strong>
                  <p>
                    {canSend
                      ? `Messages are saved here. Wake ${companion.name} when you want a reply.`
                      : "This transcript is read from the control plane, so opening it left the Box asleep."}
                  </p>
                </div>
              )}
              <ThreadPrimitive.Messages components={TURN_COMPONENTS} />
              {replying && (
                <p className="chat-replying">
                  <span className="chat-turn__author">{companion.name}</span>
                  <span>is replying...</span>
                </p>
              )}
            </div>
            <ThreadPrimitive.ScrollToBottom className="chat-jump">
              <Icon name="chevron-down" size={14} /> Latest
            </ThreadPrimitive.ScrollToBottom>
          </ThreadPrimitive.Viewport>

          {canSend ? (
            <ComposerPrimitive.Root className="chat-composer">
              <div className="chat-composer__field">
                <ComposerPrimitive.Input
                  className="chat-composer__input"
                  placeholder={`Message ${companion.name}`}
                  aria-label={`Message ${companion.name}`}
                  // Escape belongs to the thread, not to the draft: a stray keystroke must never
                  // discard text this composer is holding on to.
                  cancelOnEscape={false}
                />
                <ComposerPrimitive.Send className="chat-send" aria-label="Send message">
                  <Icon name="send" size={15} />
                </ComposerPrimitive.Send>
              </div>
              <p className="chat-hint">
                {composerHint({ thread, companionName: companion.name, awake })}
              </p>
            </ComposerPrimitive.Root>
          ) : (
            <footer className="chat-readonly">
              Viewer access is read-only. Sending, run, and desktop stay with the Owner and Editors.
            </footer>
          )}
        </ThreadPrimitive.Root>
      </TurnsContext.Provider>
    </AssistantRuntimeProvider>
  );
}
