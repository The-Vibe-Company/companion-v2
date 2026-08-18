"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  useAuiState,
  useExternalStoreRuntime,
  type AppendMessage,
  type AssistantRuntime,
} from "@assistant-ui/react";
import { ArrowUpIcon } from "lucide-react";
import type {
  Companion,
  CompanionThread as Thread,
  CompanionTranscriptEntry,
} from "@companion/contracts";
import { companionMessageEventId } from "@companion/contracts";
import { Thread as AssistantThread } from "@/components/assistant-ui/thread";
import { cn } from "@/lib/utils";
import { decideCompanionDecision } from "../../lib/companions";
import { DecisionActionsContext, type DecisionAction } from "./decisionActions";
import { DecisionToolCard } from "./DecisionToolCard";
import { ToolRunCard } from "./ToolRunCard";
import { composerHint, localDay, replyExpected, utcDay } from "./transcript";
import {
  COMPANION_DECISION_TOOL_NAME,
  COMPANION_TOOL_NAME,
  groupTranscriptEntries,
  toThreadMessageLike,
  useStableEntries,
  useStableGroups,
  type TranscriptMessage,
} from "./transcriptMessages";

/**
 * The conversation of one Companion, rendered through assistant-ui.
 *
 * The library owns the transcript mechanics — viewport anchoring, the composer, keys, focus, message
 * parts — and nothing else: the messages come from the control-plane read model this component is
 * handed, sending goes back out through the same callback the rest of Companions uses, and no
 * assistant-ui thread list, cloud, history, or model adapter is wired up. A Viewer gets the
 * transcript with a read-only note where the composer would be, and the runtime has nothing to
 * contact, so reading a thread still cannot reach Box.
 *
 * A Pi turn arrives here as one message whose parts are its reasoning, its reply, and every tool run
 * and permission card it produced. The two cards are registered as tool UIs by name, which is how a
 * permission decision — the one thing in this thread a reader can act on — reaches the control plane
 * from inside a message part.
 */

/**
 * How long after a press its own `click` can still arrive. A browser resolving a tap takes a moment
 * to deliver it, and on a phone it may never come at all; anything later than this is somebody
 * activating the button again.
 */
const PRESS_CLICK_MS = 700;

/** Message metadata by id: who wrote it, whether it opens a passage, whether it is still sending. */
const MessagesContext = createContext<ReadonlyMap<string, TranscriptMessage>>(new Map());

/**
 * What the chrome around the messages is showing. It travels by context because the thread mounts
 * these as components: a new component *identity* on every render would remount the composer, and a
 * remounted composer is a lost draft mid-keystroke.
 */
interface TranscriptChrome {
  companionName: string;
  canSend: boolean;
  loading: boolean;
  empty: boolean;
  replying: boolean;
  hint: string;
  onSendPress: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onSendClick: (event: ReactMouseEvent<HTMLButtonElement>) => void;
}

const ChromeContext = createContext<TranscriptChrome | null>(null);

function useChrome(): TranscriptChrome {
  const chrome = useContext(ChromeContext);
  if (!chrome) throw new Error("the Companion thread chrome is only available inside the thread");
  return chrome;
}

function useTranscriptMessage(): TranscriptMessage | undefined {
  const messages = useContext(MessagesContext);
  const id = useAuiState((state) => state.message.id);
  return id ? messages.get(id) : undefined;
}

/** Server markup keeps the stable ISO minute; the local clock takes over on the client. */
function SentAt({ iso }: { iso: string }) {
  const [text, setText] = useState(() => iso.slice(11, 16));
  useEffect(() => setText(new Date(iso).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  })), [iso]);
  return <time dateTime={iso}>{text}</time>;
}

/**
 * A writer keeps the floor across consecutive messages, so the name and the clock appear once per
 * passage and the messages underneath are just the words.
 */
function PassageLead({ message }: { message: TranscriptMessage | undefined }) {
  if (!message?.lead || !message.author) return null;
  return (
    <p className="text-muted-foreground mb-1 flex items-baseline gap-2 text-xs">
      <span className="text-foreground font-medium">{message.author}</span>
      <SentAt iso={message.createdAt} />
    </p>
  );
}

/**
 * One day separator. The key is already the day this message belongs to — the stored one on the
 * server, the reader's own once the client has a clock — and is read back at midday UTC so the round
 * trip cannot shift it. Only the label gets friendlier after mount.
 */
function DaySeparator({ day }: { day: string }) {
  const [text, setText] = useState(day);
  useEffect(() => {
    const at = new Date(`${day}T12:00:00.000Z`);
    const today = new Date();
    const daysApart = Math.round(
      (Date.UTC(today.getFullYear(), today.getMonth(), today.getDate())
        - Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate())) / 86_400_000,
    );
    if (daysApart === 0) setText("Today");
    else if (daysApart === 1) setText("Yesterday");
    else {
      setText(at.toLocaleDateString(undefined, {
        month: "long",
        day: "numeric",
        ...(daysApart > 300 ? { year: "numeric" } : {}),
        timeZone: "UTC",
      }));
    }
  }, [day]);
  return (
    <p
      data-slot="chat-day-separator"
      className="text-muted-foreground my-1 flex items-center gap-3 text-xs before:h-px before:flex-1 before:bg-(--color-line) after:h-px after:flex-1 after:bg-(--color-line)"
    >
      <time dateTime={day}>{text}</time>
    </p>
  );
}

/**
 * Where this reader left off. It is drawn once, on the first message somebody else wrote after the
 * newest line they had already seen, so returning to a busy thread starts where reading stopped.
 *
 * The accent is on the hairlines and nowhere else. `accent-edge` is an edge token — it is not lifted
 * for the dark theme — and this word is small, so at accent colour it falls under the contrast floor
 * on every preset. The one word this divider exists for stays at full foreground contrast.
 */
function NewSeparator() {
  return (
    <p
      data-slot="chat-new-separator"
      className="text-foreground my-1 flex items-center gap-3 text-xs font-medium before:h-px before:flex-1 before:bg-(--color-accent-line) after:h-px after:flex-1 after:bg-(--color-accent-line)"
    >
      New
    </p>
  );
}

/** Both separators, above whichever message opens the day or the unread run. */
function Separators({ message }: { message: TranscriptMessage | undefined }) {
  if (!message) return null;
  return (
    <>
      {message.startsDay && <DaySeparator day={message.startsDay} />}
      {message.startsNew && <NewSeparator />}
    </>
  );
}

function AssistantFrame({ children }: { children: ReactNode }) {
  const message = useTranscriptMessage();
  return (
    <>
      <Separators message={message} />
      <PassageLead message={message} />
      {children}
    </>
  );
}

function UserFrame({ children }: { children: ReactNode }) {
  const message = useTranscriptMessage();
  return (
    <div className="flex w-full flex-col items-end" aria-busy={message?.sending || undefined}>
      <div className="w-full">
        <Separators message={message} />
      </div>
      <PassageLead message={message} />
      {/* Full width on purpose: the bubble inside is capped as a percentage, and a fit-content
          wrapper would make that percentage resolve against the bubble's own text. */}
      <div className={cn("flex w-full flex-col items-end", message?.sending && "opacity-60")}>
        {children}
      </div>
    </div>
  );
}

const TOOL_UIS = {
  [COMPANION_TOOL_NAME]: ToolRunCard,
  [COMPANION_DECISION_TOOL_NAME]: DecisionToolCard,
};

const THREAD_COMPONENTS = {
  Welcome,
  Trailer,
  Footer,
  UserMessageFrame: UserFrame,
  AssistantMessageFrame: AssistantFrame,
  tools: TOOL_UIS,
};

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
  lastReadOrdinal,
  openedThroughOrdinal,
  onSend,
  onThread,
}: {
  companion: Companion;
  thread: Thread | null;
  orgId: string;
  busy: boolean;
  /** This reader's unread watermark as it stood when the thread was opened; null draws no divider. */
  lastReadOrdinal?: number | null;
  /** The newest ordinal the thread held when it was opened, so the divider cannot chase new arrivals. */
  openedThroughOrdinal?: number | null;
  onSend: (content: string, clientMessageId: string) => Promise<boolean>;
  /** Replace the thread after a permission card is decided, without a full poll cycle. */
  onThread: (thread: Thread) => void;
}) {
  const canSend = thread ? thread.can_send : companion.access !== "viewer";
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
  useEffect(() => {
    if (outgoing && thread?.entries.some((entry) => entry.event_id === outgoing.event_id)) {
      setOutgoing(null);
    }
  }, [outgoing, thread]);
  const stableEntries = useStableEntries(entries);

  /**
   * The server has no clock the browser agrees with, so both renders key the day on the stored one
   * and the reader's own calendar takes over after mount. Swapping it later is what keeps a
   * separator from naming a different date than the timestamps under it.
   */
  const [dayOf, setDayOf] = useState<(iso: string) => string>(() => utcDay);
  useEffect(() => setDayOf(() => localDay), []);

  const grouped = useMemo(
    () => groupTranscriptEntries(stableEntries, {
      viewerId,
      companionName: companion.name,
      sendingEventId: outgoing?.event_id ?? null,
      lastReadOrdinal: lastReadOrdinal ?? null,
      openedThroughOrdinal: openedThroughOrdinal ?? null,
      dayOf,
    }),
    [companion.name, dayOf, lastReadOrdinal, openedThroughOrdinal, outgoing, stableEntries, viewerId],
  );
  const messages = useStableGroups(grouped);
  const messagesById = useMemo(
    () => new Map(messages.map((message) => [message.id, message])),
    [messages],
  );

  const onDecide = useCallback(async (requestId: string, input: DecisionAction) => {
    const next = await decideCompanionDecision(orgId, companion.id, requestId, input);
    onThread(next);
  }, [companion.id, onThread, orgId]);

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
      reasoning: null,
      author_id: viewerId,
      author_name: null,
      tool: null,
      decision: null,
      created_at: new Date().toISOString(),
    });
    let saved = false;
    try {
      saved = await onSend(content, clientMessageId);
      if (saved) pendingSendRef.current = null;
      else restoreDraft(runtimeRef.current, content);
    } finally {
      inFlight.current = false;
      // A bounded send ACK carries only the turn. Keep the accepted message visible until the
      // thread projection contains its durable event id; a failed send still restores the draft.
      if (!saved) setOutgoing(null);
    }
  }, [canSend, onSend, viewerId]);

  const runtime = useExternalStoreRuntime({
    messages,
    convertMessage: toThreadMessageLike,
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

  const replying = replyExpected(thread);
  const loading = thread === null;
  const empty = thread !== null && messages.length === 0;
  const hint = composerHint({
    thread,
    companionName: companion.name,
    state: companion.runtime.state,
  });

  const chrome = useMemo<TranscriptChrome>(() => ({
    companionName: companion.name,
    canSend,
    loading,
    empty,
    replying,
    hint,
    onSendPress: sendOnPress,
    onSendClick: swallowClickAfterPress,
  }), [
    canSend,
    companion.name,
    empty,
    hint,
    loading,
    replying,
    sendOnPress,
    swallowClickAfterPress,
  ]);

  const decisions = useMemo(() => ({ canAct: canSend, onDecide }), [canSend, onDecide]);

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <DecisionActionsContext.Provider value={decisions}>
        <MessagesContext.Provider value={messagesById}>
          <ChromeContext.Provider value={chrome}>
            <AssistantThread
              className="chat-thread min-w-0 flex-1"
              components={THREAD_COMPONENTS}
              viewportProps={{
                role: "log",
                "aria-live": "polite",
                "aria-busy": loading,
              }}
            />
          </ChromeContext.Provider>
        </MessagesContext.Provider>
      </DecisionActionsContext.Provider>
    </AssistantRuntimeProvider>
  );
}

function Welcome() {
  const { canSend, companionName, empty, loading } = useChrome();
  if (loading) {
    return (
      <>
        {/* The skeleton is decorative; the wait itself still has to be announced. */}
        <span className="sr-only" role="status">Loading conversation...</span>
        <div className="grid gap-3" aria-hidden="true">
          <span className="bg-muted h-3 w-2/5 rounded" />
          <span className="bg-muted h-3 w-3/4 rounded" />
          <span className="bg-muted h-3 w-3/5 rounded" />
        </div>
      </>
    );
  }
  if (!empty) return null;
  return (
    <div className="text-muted-foreground max-w-[48ch] text-sm">
      <strong className="text-foreground block text-base">No messages yet</strong>
      <p className="mt-1">
        {canSend
          ? `Send a message to start ${companionName} and get a reply.`
          : "This transcript is read from the control plane, so opening it left the Box asleep."}
      </p>
    </div>
  );
}

/**
 * Pi owes this thread a reply and has not produced one yet.
 *
 * The dots are the decoration; the sentence is the message. A reader who has asked for reduced
 * motion gets three motionless dots, so leaving the words to a screen-reader-only span would tell
 * that reader nothing at all — the sentence is on the page for everyone, and the dots are hidden
 * from assistive technology because they say the same thing again.
 */
function Trailer() {
  const { companionName, replying } = useChrome();
  if (!replying) return null;
  return (
    <p
      data-slot="companion-replying"
      className="text-muted-foreground flex items-center gap-2 text-sm"
    >
      <span aria-hidden="true" className="flex items-center gap-1">
        {[0, 1, 2].map((index) => (
          <span
            key={index}
            className="bg-muted-foreground/70 size-1.5 animate-bounce rounded-full motion-reduce:animate-none"
            style={{ animationDelay: `${index * 140}ms` }}
          />
        ))}
      </span>
      <span>{companionName} is replying...</span>
    </p>
  );
}

/** The composer, or — for a Viewer — the line that says why there is none. */
function Footer() {
  const { canSend, companionName, hint, onSendPress, onSendClick } = useChrome();
  if (!canSend) {
    return (
      <footer className="border-border text-muted-foreground shrink-0 border-t px-(--chat-gutter) py-3 text-xs">
        Viewer access is read-only. Sending, run, and desktop stay with the Owner and Editors.
      </footer>
    );
  }
  return (
    <ComposerPrimitive.Root className="border-border bg-background shrink-0 border-t px-(--chat-gutter) pt-2.5 pb-[max(14px,env(safe-area-inset-bottom,0px))]">
      <div className="mx-auto w-full max-w-(--thread-max-width)">
        {/* The field and its send control are one object, so the composer reads as one place to type. */}
        <div
          data-slot="composer-field"
          className="border-input focus-within:border-ring bg-card flex items-end gap-2 rounded-2xl border py-1.5 pe-1.5 ps-3"
        >
          <ComposerPrimitive.Input
            className="text-foreground max-h-42 min-h-8 flex-1 resize-none overscroll-contain bg-transparent py-1 outline-none"
            placeholder={`Message ${companionName}`}
            aria-label={`Message ${companionName}`}
            rows={1}
            // A phone keyboard labels its return key from this hint. Without it a textarea offers
            // `return`, which reads as a new line even though Enter sends here; Shift + Enter is
            // still the new line, on a phone as on a desktop.
            enterKeyHint="send"
            // Escape belongs to the thread, not to the draft: a stray keystroke must never discard
            // text this composer is holding on to.
            cancelOnEscape={false}
          />
          <ComposerPrimitive.Send
            // THE-346: Send is the control the composer exists for, and a 32px square is not a thumb
            // target. The field grows around it rather than the control shrinking, and a mouse keeps
            // the compact square it points at precisely.
            className="bg-primary text-primary-foreground hover:bg-primary/90 disabled:bg-muted disabled:text-muted-foreground pointer-coarse:size-11 grid size-8 shrink-0 place-items-center rounded-full transition-colors disabled:cursor-not-allowed"
            aria-label="Send message"
            onPointerDown={onSendPress}
            onClick={onSendClick}
          >
            <ArrowUpIcon className="size-4" />
          </ComposerPrimitive.Send>
        </div>
        <p data-slot="composer-hint" className="text-muted-foreground mt-1.5 text-xs">{hint}</p>
      </div>
    </ComposerPrimitive.Root>
  );
}
