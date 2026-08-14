"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
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
  CompanionDecision,
  CompanionDecisionKind,
  CompanionThread as Thread,
  CompanionToolRun,
  CompanionToolRunKind,
  CompanionTranscriptEntry,
} from "@companion/contracts";
import { companionMessageEventId } from "@companion/contracts";
import { Icon } from "../Icon";
import { decideCompanionDecision } from "../../lib/companions";
import {
  composerHint,
  replyExpected,
  transcriptDisplayContent,
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

/**
 * How long after a press its own `click` can still arrive. A browser resolving a tap takes a moment
 * to deliver it, and on a phone it may never come at all; anything later than this is somebody
 * activating the button again.
 */
const PRESS_CLICK_MS = 700;

/** Turn metadata by message id. The primitives render one component per message; this is its row. */
const TurnsContext = createContext<ReadonlyMap<string, TranscriptTurn>>(new Map());

type DecisionAction =
  | { action: "allow" }
  | { action: "deny" }
  | { action: "answer"; answer: string };

const DecisionActionsContext = createContext<{
  canAct: boolean;
  onDecide: (requestId: string, input: DecisionAction) => Promise<void>;
}>({
  canAct: false,
  onDecide: async () => undefined,
});

function useTurn(): TranscriptTurn | undefined {
  const turns = useContext(TurnsContext);
  const id = useAuiState((state) => state.message.id);
  return id ? turns.get(id) : undefined;
}

/**
 * A tool run is its own transcript entry, and the primitives know three roles. It rides in as the
 * quietest of them and is rendered from the entry itself, so the run keeps its place in the
 * conversation without the thread growing a fourth kind of message to lay out.
 */
const convertEntry = (
  entry: CompanionTranscriptEntry,
  companionName: string,
): ThreadMessageLike => ({
  id: entry.event_id,
  role: entry.role === "tool" || entry.role === "decision" ? "system" : entry.role,
  content: [{ type: "text", text: transcriptDisplayContent(entry, companionName) }],
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

const TOOL_ICONS: Record<CompanionToolRunKind, string> = {
  shell: "terminal",
  file: "file-pen-line",
  browse: "globe",
  computer: "monitor",
  tool: "braces",
};

/** What the chip says it is doing, for a reader who cannot see the spinner or the tick. */
const TOOL_STATUS_LABELS = {
  running: "running",
  ok: "done",
  error: "failed",
} as const;

/**
 * One tool run, as a chip on the transcript. It is deliberately not a message: the run is a line of
 * chrome between two turns, so the reply above it and the reply below it still read as a
 * conversation. The chip carries what ran and how it ended; the arguments and whatever the tool
 * returned stay folded away until a reader asks for them, because most runs are read at a glance and
 * skipped.
 *
 * A run that moved the Box desktop also carries one frame of that desktop, shown in place. It is the
 * screen as the run left it, not a live stream — watching the machine is what the Computer panel
 * beside the thread is for, and this thread is still readable by someone who may not open one.
 */
function ToolChip({ run }: { run: CompanionToolRun }) {
  const [open, setOpen] = useState(false);
  const detailId = useId();
  const status = TOOL_STATUS_LABELS[run.status];
  const named = run.title !== run.name;
  return (
    <MessagePrimitive.Root
      className={"chat-tool chat-tool--" + run.status}
      aria-busy={run.status === "running" || undefined}
    >
      <button
        type="button"
        className="chat-tool__head"
        aria-expanded={run.detail ? open : undefined}
        aria-controls={run.detail ? detailId : undefined}
        // A run Pi reported nothing about has nothing to unfold, so the chip is a plain line.
        disabled={!run.detail}
        onClick={() => setOpen((shown) => !shown)}
      >
        <Icon name={TOOL_ICONS[run.kind]} size={13} className="chat-tool__kind" />
        <span className="chat-tool__name">{run.name}</span>
        {named && <span className="chat-tool__title">{run.title}</span>}
        {run.status === "running"
          ? <span className="chat-tool__spinner" aria-hidden="true" />
          : (
            <Icon
              name={run.status === "ok" ? "check" : "alert-triangle"}
              size={13}
              className="chat-tool__state"
            />
          )}
        <span className="sr-only">{status}</span>
        {run.detail && (
          <Icon
            name={open ? "chevron-down" : "chevron-right"}
            size={13}
            className="chat-tool__caret"
          />
        )}
      </button>
      {run.detail && open && (
        <pre className="chat-tool__detail" id={detailId}>{run.detail}</pre>
      )}
      {run.screenshot && (
        <img
          className="chat-tool__frame"
          src={run.screenshot}
          alt={`The Box desktop after ${run.title}`}
          loading="lazy"
        />
      )}
    </MessagePrimitive.Root>
  );
}

const DECISION_ICONS: Record<CompanionDecisionKind, string> = {
  shell: "terminal",
  file: "file-pen-line",
  question: "message-square",
};

const DECISION_KIND_LABELS: Record<CompanionDecisionKind, string> = {
  shell: "run a command",
  file: "edit a file",
  question: "asks",
};

const DECISION_STATUS_LABELS = {
  pending: "waiting",
  allowed: "allowed",
  denied: "denied",
  answered: "answered",
  expired: "timed out",
} as const;

/**
 * One permission card in the thread. It sits beside THE-352 tool chips with the same quiet chrome:
 * pending cards offer Allow / Deny (or an answer field) to Owner/Editor only; Viewers see the
 * resolved state and never get the controls.
 */
function DecisionCard({
  decision,
  canAct,
  onDecide,
}: {
  decision: CompanionDecision;
  canAct: boolean;
  onDecide: (
    requestId: string,
    input: { action: "allow" } | { action: "deny" } | { action: "answer"; answer: string },
  ) => Promise<void>;
}) {
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const pending = decision.status === "pending";
  const interactive = pending && canAct && !busy;
  const status = DECISION_STATUS_LABELS[decision.status];

  async function act(
    input: { action: "allow" } | { action: "deny" } | { action: "answer"; answer: string },
  ) {
    if (!interactive) return;
    setBusy(true);
    try {
      await onDecide(decision.request_id, input);
    } finally {
      setBusy(false);
    }
  }

  return (
    <MessagePrimitive.Root
      className={"chat-decision chat-decision--" + decision.status}
      aria-busy={pending || undefined}
    >
      <div className="chat-decision__head">
        <Icon name={DECISION_ICONS[decision.kind]} size={13} className="chat-decision__kind" />
        <span className="chat-decision__label">
          {decision.kind === "question" ? "Question" : `Allow ${DECISION_KIND_LABELS[decision.kind]}`}
        </span>
        <span className="chat-decision__name">{decision.name}</span>
        {pending
          ? <span className="chat-tool__spinner" aria-hidden="true" />
          : (
            <Icon
              name={decision.status === "allowed" || decision.status === "answered"
                ? "check"
                : "alert-triangle"}
              size={13}
              className="chat-decision__state"
            />
          )}
        <span className="sr-only">{status}</span>
      </div>
      <pre className="chat-decision__detail">{decision.title}</pre>
      {decision.kind === "question" && decision.answer && (
        <p className="chat-decision__answer">{decision.answer}</p>
      )}
      {!pending && decision.decided_by_name && (
        <p className="chat-decision__meta">
          {status} by {decision.decided_by_name}
        </p>
      )}
      {decision.status === "expired" && !decision.decided_by_name && (
        <p className="chat-decision__meta">Timed out — denied</p>
      )}
      {interactive && decision.kind === "question" && (
        <form
          className="chat-decision__actions"
          onSubmit={(event) => {
            event.preventDefault();
            const value = answer.trim();
            if (!value) return;
            void act({ action: "answer", answer: value });
          }}
        >
          <input
            className="chat-decision__input"
            value={answer}
            onChange={(event) => setAnswer(event.target.value)}
            placeholder="Your answer"
            aria-label="Answer"
            disabled={busy}
          />
          <button type="submit" className="cds-btn cds-btn--primary" disabled={busy || !answer.trim()}>
            Answer
          </button>
          <button
            type="button"
            className="cds-btn cds-btn--secondary"
            disabled={busy}
            onClick={() => void act({ action: "deny" })}
          >
            Deny
          </button>
        </form>
      )}
      {interactive && decision.kind !== "question" && (
        <div className="chat-decision__actions">
          <button
            type="button"
            className="cds-btn cds-btn--primary"
            disabled={busy}
            onClick={() => void act({ action: "allow" })}
          >
            Allow
          </button>
          <button
            type="button"
            className="cds-btn cds-btn--secondary"
            disabled={busy}
            onClick={() => void act({ action: "deny" })}
          >
            Deny
          </button>
        </div>
      )}
      {pending && !canAct && (
        <p className="chat-decision__meta">Waiting for an Owner or Editor</p>
      )}
    </MessagePrimitive.Root>
  );
}

/** A tool run or permission card arrives as a system message; everything else with that role is a note. */
function SystemTurn() {
  const entry = useTurn()?.entry;
  const { canAct, onDecide } = useContext(DecisionActionsContext);
  if (entry?.tool) return <ToolChip run={entry.tool} />;
  if (entry?.decision) {
    return <DecisionCard decision={entry.decision} canAct={canAct} onDecide={onDecide} />;
  }
  return <Note />;
}

const TURN_COMPONENTS = {
  UserMessage: () => <Turn tone="said" />,
  AssistantMessage: () => <Turn tone="reply" />,
  SystemMessage: SystemTurn,
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
        // A chip is the one entry that changes after it is stored: it settles, and a visual run then
        // gains its frame. Only those three fields ever move, so comparing them is what keeps a
        // finished run from re-rendering on every poll for the rest of the conversation.
        && kept.tool?.status === entry.tool?.status
        && kept.tool?.detail === entry.tool?.detail
        && kept.tool?.screenshot === entry.tool?.screenshot
        && kept.decision?.status === entry.decision?.status
        && kept.decision?.answer === entry.decision?.answer
        && kept.decision?.decided_by_id === entry.decision?.decided_by_id
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
  orgId,
  busy,
  onSend,
  onThread,
}: {
  companion: Companion;
  thread: Thread | null;
  orgId: string;
  busy: boolean;
  onSend: (content: string, clientMessageId: string) => Promise<boolean>;
  /** Replace the thread after a permission card is decided, without a full poll cycle. */
  onThread: (thread: Thread) => void;
}) {
  const canSend = thread ? thread.can_send : companion.access !== "viewer";
  const awake = companion.runtime.state === "running";
  const viewerId = thread?.viewer_id ?? "";
  const runtimeRef = useRef<AssistantRuntime | null>(null);
  const inFlight = useRef(false);
  /**
   * The id of a send whose request did not confirm, held beside the draft it named. A send that wakes
   * an asleep Companion persists the turn before the wake it then waits on, so a request that dies
   * mid-wake still left that turn durable under this id. Restoring the draft and minting a fresh id on
   * the retry would ask the control plane to store the same message under a second name — the second
   * turn THE-341 saw. Reusing the id keeps one submission one turn: the retry resolves to the entry
   * already stored. It is cleared the moment a send confirms and only reused for the identical draft,
   * so two different messages are still two turns.
   */
  const pendingSendRef = useRef<{ content: string; clientMessageId: string } | null>(null);
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

  const onDecide = useCallback(async (requestId: string, input: DecisionAction) => {
    const next = await decideCompanionDecision(orgId, companion.id, requestId, input);
    onThread(next);
  }, [companion.id, onThread, orgId]);

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
    // One submission, one id: whatever happens to the request, the control plane can only ever store
    // the turn it names once. A draft restored after a send that never confirmed keeps the id its
    // first attempt named, so retrying the same text resolves to the durable turn rather than a
    // second copy of it; anything else is a new message and gets a fresh id.
    const remembered = pendingSendRef.current;
    const clientMessageId = remembered && remembered.content === content
      ? remembered.clientMessageId
      : crypto.randomUUID();
    pendingSendRef.current = { content, clientMessageId };
    setOutgoing({
      event_id: companionMessageEventId(clientMessageId),
      ordinal: Number.MAX_SAFE_INTEGER,
      role: "user",
      content,
      author_id: viewerId,
      author_name: null,
      tool: null,
    decision: null,
      created_at: new Date().toISOString(),
    });
    try {
      const saved = await onSend(content, clientMessageId);
      if (saved) pendingSendRef.current = null;
      else restoreDraft(runtimeRef.current, content);
    } finally {
      inFlight.current = false;
      setOutgoing(null);
    }
  }, [canSend, onSend, viewerId]);

  const convertMessage = useCallback(
    (entry: CompanionTranscriptEntry) => convertEntry(entry, companion.name),
    [companion.name],
  );
  const runtime = useExternalStoreRuntime({
    messages,
    convertMessage,
    onNew: send,
    // Sending is the only thing this thread does: no editing, no branching, no regeneration, no
    // cancel, and no run of its own, so the primitives offer none of those controls.
    isDisabled: !canSend,
    isSendDisabled: busy,
  });
  useEffect(() => {
    runtimeRef.current = runtime;
  }, [runtime]);

  /** When a press last sent, so the click that press produces can be told apart from a new one. */
  const pressSentAt = useRef(0);

  /**
   * iOS settles a tap on the composer's own button by blurring the field first: the keyboard starts
   * closing, the visual viewport grows, the thread pinned to it is laid out again, and the `click`
   * meant for this button lands wherever the button used to be — THE-346, a Send that never fired.
   * The press is the whole gesture on a button that neither drags nor holds, so it is where the
   * message goes. Refusing the default keeps focus, and the draft, in the field, which is what keeps
   * the keyboard from closing under the finger to begin with.
   */
  const sendOnPress = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    const composer = runtime.thread.composer;
    if (!composer.getState().canSend) return;
    event.preventDefault();
    pressSentAt.current = Date.now();
    composer.send();
  }, [runtime]);

  /**
   * The primitive sends from `click`, and the browser still delivers one after the press. Refusing
   * the default is how `ComposerPrimitive.Send` is told this one is spoken for: it composes its own
   * handler behind this one and skips it on a prevented event. Only the click belonging to the press
   * is refused — a click from a keyboard activating the focused button, or one the browser delivers
   * long after a press whose own click never arrived, is a fresh Send and goes through.
   */
  const swallowClickAfterPress = useCallback((event: ReactMouseEvent<HTMLButtonElement>) => {
    if (Date.now() - pressSentAt.current > PRESS_CLICK_MS) return;
    pressSentAt.current = 0;
    event.preventDefault();
  }, []);

  const replying = replyExpected({ entries: messages, awake });
  const empty = thread !== null && messages.length === 0;

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <DecisionActionsContext.Provider value={{ canAct: canSend, onDecide }}>
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
                  // A phone keyboard labels its return key from this hint. Without it a textarea
                  // offers `return`, which reads as a new line even though Enter sends here; Shift +
                  // Enter is still the new line, on a phone as on a desktop.
                  enterKeyHint="send"
                  // Escape belongs to the thread, not to the draft: a stray keystroke must never
                  // discard text this composer is holding on to.
                  cancelOnEscape={false}
                />
                <ComposerPrimitive.Send
                  className="chat-send"
                  aria-label="Send message"
                  onPointerDown={sendOnPress}
                  onClick={swallowClickAfterPress}
                >
                  <Icon name="send" size={15} />
                </ComposerPrimitive.Send>
              </div>
              <p className="chat-hint">
                {composerHint({
                  thread,
                  companionName: companion.name,
                  state: companion.runtime.state,
                })}
              </p>
            </ComposerPrimitive.Root>
          ) : (
            <footer className="chat-readonly">
              Viewer access is read-only. Sending, run, and desktop stay with the Owner and Editors.
            </footer>
          )}
        </ThreadPrimitive.Root>
      </TurnsContext.Provider>
      </DecisionActionsContext.Provider>
    </AssistantRuntimeProvider>
  );
}
