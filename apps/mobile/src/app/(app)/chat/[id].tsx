import { Ionicons } from "@expo/vector-icons";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Text,
  View,
} from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";

import { Composer } from "@/components/companions/composer";
import { CompanionIcon, defaultCompanionIcon } from "@/components/companions/companion-icon";
import { DecisionCard } from "@/components/companions/decision-card";
import { InterruptedCard } from "@/components/companions/interrupted-card";
import { MessageBubble } from "@/components/companions/message-bubble";
import { ReplyingIndicator } from "@/components/companions/replying-indicator";
import { ToolRow } from "@/components/companions/tool-row";
import { EmptyState, ScreenHeader } from "@/components/ui";
import {
  answerDecision,
  cancelTurn,
  getThread,
  listCompanions,
  listPluginAccounts,
  listSkillNames,
  getProviders,
  retryTurn,
  sendMessage,
  type PickedAttachment,
} from "@/lib/api";
import {
  ApiError,
  type Companion,
  type CompanionThread,
  type NamedResource,
  type TranscriptEntry,
} from "@/lib/types";
import { usePoll } from "@/lib/use-poll";
import { uuid } from "@/lib/uuid";

type ThreadResult = { thread: CompanionThread; raw: string };
type PendingMessage = { id: string; content: string; files: PickedAttachment[]; failed: boolean };
type ListItem = { kind: "entry"; entry: TranscriptEntry } | { kind: "pending"; pending: PendingMessage };

/** Names the proposal cards may print. Loaded from this surface's own catalogs, never from Pi. */
type ResourceNames = {
  skills: NamedResource[];
  plugins: NamedResource[];
  models: NamedResource[];
};

function composerHint(thread: CompanionThread | null, name: string): string {
  if (!thread) return "Messages are saved before delivery.";
  if (thread.read_only || !thread.can_send) return "Viewer access is read-only and never wakes the Companion.";
  if (thread.interrupted_turn) {
    return `Retry or cancel the interrupted turn to continue${thread.queued_count ? ` · ${thread.queued_count} queued` : ""}.`;
  }
  const active = thread.active_turn;
  if (active?.status === "starting") return `${name} is starting this turn.`;
  if (active?.status === "dispatching") return `Sending this turn to ${name}.`;
  if (active?.status === "needs_input") return "Answer the request above to continue this turn.";
  if (active) return `${name} is working on this turn.`;
  if (thread.queued_count) return `${thread.queued_count} message${thread.queued_count === 1 ? " is" : "s are"} saved and queued.`;
  return "Messages are saved before delivery.";
}

function pendingEntry(pending: PendingMessage): TranscriptEntry {
  return {
    event_id: `local-${pending.id}`,
    ordinal: Number.MAX_SAFE_INTEGER,
    role: "user",
    content: pending.content,
    reasoning: null,
    author_id: null,
    author_name: null,
    tool: null,
    decision: null,
    routine: null,
    trigger: null,
    turn_id: null,
    queued: !pending.failed,
    // Staged ids are deliberately not uuids, so the list renders name chips and never fetches them.
    attachments: pending.files.map((file, position) => ({
      id: `staged-${position}`,
      kind: "user_upload" as const,
      content_type: file.type,
      byte_size: file.byteSize,
      filename: file.name,
      position,
    })),
    created_at: new Date().toISOString(),
  };
}

function interruptedActionError(cause: unknown, action: "retry" | "cancel"): string {
  if (cause instanceof ApiError && cause.status === 0) {
    return action === "retry"
      ? "The retry request could not be confirmed. Refreshing the thread; retrying will reuse the same request."
      : "The cancel request could not be confirmed. Refreshing the thread before another action.";
  }
  if (cause instanceof ApiError && cause.status === 409) {
    return action === "retry"
      ? "A retry is already pending for this turn. Refreshing the thread before another action."
      : "The turn changed before it could be cancelled. Refreshing the thread before another action.";
  }
  return cause instanceof Error
    ? cause.message
    : action === "retry" ? "This turn could not be retried." : "This turn could not be cancelled.";
}

export default function ChatScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const [companion, setCompanion] = useState<Companion | null>(null);
  const [pending, setPending] = useState<PendingMessage[]>([]);
  const [names, setNames] = useState<ResourceNames>({ skills: [], plugins: [], models: [] });
  const [stoppingTurnId, setStoppingTurnId] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionStatus, setActionStatus] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const retryIdRef = useRef<{ turnId: string; retryId: string } | null>(null);
  const rawRef = useRef<string | null>(null);
  const resultRef = useRef<ThreadResult | null>(null);

  const load = useCallback(async () => {
    const next = await getThread(id);
    if (next.raw === rawRef.current && resultRef.current) return resultRef.current;
    rawRef.current = next.raw;
    resultRef.current = next;
    return next;
  }, [id]);
  const interval = useCallback((result: ThreadResult | null) => {
    const thread = result?.thread;
    return thread?.active_turn || thread?.interrupted_turn || (thread?.queued_count ?? 0) > 0 ? 3_000 : 8_000;
  }, []);
  const poll = usePoll({ load, interval });
  const thread = poll.data?.thread ?? null;

  useEffect(() => {
    const interruptedTurnId = thread?.interrupted_turn?.id ?? null;
    if (retryIdRef.current && retryIdRef.current.turnId !== interruptedTurnId) {
      retryIdRef.current = null;
      setActionStatus(null);
      setActionError(null);
    }
  }, [thread?.interrupted_turn?.id]);

  useEffect(() => {
    let cancelled = false;
    void listCompanions()
      .then((companions) => {
        if (!cancelled) setCompanion(companions.find((item) => item.id === id) ?? null);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [id]);

  // Every lookup is display-only: a catalog that fails to load leaves ids unnamed, never blocks.
  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      listSkillNames().catch(() => []),
      listPluginAccounts().catch(() => []),
      getProviders()
        .then((providers) => providers.catalog.flatMap((provider) =>
          provider.models.map((model) => ({ id: model.id, label: model.name }))))
        .catch(() => []),
    ]).then(([skills, plugins, models]) => {
      if (!cancelled) setNames({ skills, plugins, models });
    });
    return () => {
      cancelled = true;
    };
  }, [id]);

  const sendPending = useCallback(async (message: PendingMessage) => {
    setPending((items) => items.map((item) => item.id === message.id ? { ...item, failed: false } : item));
    try {
      await sendMessage(id, message.content, message.id, message.files);
      setPending((items) => items.filter((item) => item.id !== message.id));
      poll.refresh();
    } catch {
      setPending((items) => items.map((item) => item.id === message.id ? { ...item, failed: true } : item));
    }
  }, [id, poll]);

  const send = useCallback(async (content: string, files: readonly PickedAttachment[]) => {
    const message = { id: uuid(), content, files: [...files], failed: false };
    setPending((items) => [...items, message]);
    await sendPending(message);
    return true;
  }, [sendPending]);

  const items = useMemo<ListItem[]>(() => [
    ...(thread?.entries ?? []).map((entry): ListItem => ({ kind: "entry", entry })),
    ...pending.map((message): ListItem => ({ kind: "pending", pending: message })),
  ].reverse(), [pending, thread?.entries]);

  const setThread = useCallback((next: CompanionThread) => {
    const result = { thread: next, raw: JSON.stringify({ thread: next }) };
    rawRef.current = result.raw;
    resultRef.current = result;
    poll.setData(result);
  }, [poll]);

  const decide = useCallback(async (
    decision: NonNullable<TranscriptEntry["decision"]>,
    input: { action: "allow" | "deny" } | { action: "answer"; answer: string },
  ) => {
    setThread(await answerDecision(id, decision, input));
  }, [id, setThread]);

  /** Cancel a turn that has not settled: the active one from Stop, or a queued follow-up's row. */
  const cancelUnsettled = useCallback(async (turnId: string) => {
    setStoppingTurnId(turnId);
    try {
      setThread(await cancelTurn(id, turnId));
    } catch {
      // The turn may have settled or started between the tap and the request; the next poll answers.
    } finally {
      setStoppingTurnId(null);
      poll.refresh();
    }
  }, [id, poll, setThread]);

  const retryInterrupted = async () => {
    const interrupted = thread?.interrupted_turn;
    if (!interrupted || actionBusy) return;
    setActionBusy(true);
    setActionStatus(null);
    setActionError(null);
    const retry = retryIdRef.current?.turnId === interrupted.id
      ? retryIdRef.current.retryId
      : uuid();
    retryIdRef.current = { turnId: interrupted.id, retryId: retry };
    try {
      await retryTurn(id, interrupted.id, retry);
      setActionStatus("Retry accepted. The thread is refreshing; repeating Retry will reuse this request.");
      poll.refresh();
    } catch (cause) {
      setActionError(interruptedActionError(cause, "retry"));
      // A response can be lost after the durable operation is accepted. Reconcile before inviting
      // another action, while preserving the retry id so a repeat cannot create a second request.
      poll.refresh();
    } finally {
      setActionBusy(false);
    }
  };

  const cancelInterrupted = async () => {
    const interrupted = thread?.interrupted_turn;
    if (!interrupted || actionBusy) return;
    setActionBusy(true);
    setActionStatus(null);
    setActionError(null);
    try {
      setThread(await cancelTurn(id, interrupted.id));
      poll.refresh();
    } catch (cause) {
      setActionError(interruptedActionError(cause, "cancel"));
      poll.refresh();
    } finally {
      setActionBusy(false);
    }
  };

  const name = companion?.name ?? "Companion";
  const icon = companion?.icon ?? defaultCompanionIcon;

  return (
    <KeyboardAvoidingView className="flex-1 bg-background pt-safe" behavior={Platform.OS === "ios" ? "padding" : undefined} keyboardVerticalOffset={0}>
      <ScreenHeader
        title={name}
        subtitle={companion?.runtime.replying ? "Replying" : companion?.runtime.state.replaceAll("_", " ")}
        onBack={() => router.back()}
        action={<CompanionIcon icon={icon} size={32} />}
      />

      {poll.error && !thread ? (
        <EmptyState
          title="Could not open this thread"
          description="The durable conversation could not be loaded from the server."
          action="Try again"
          onAction={poll.refresh}
        />
      ) : (
        <FlatList
          inverted
          data={items}
          keyExtractor={(item) => item.kind === "entry" ? item.entry.event_id : `local-${item.pending.id}`}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ paddingVertical: 12 }}
          ListEmptyComponent={(
            <View className="scale-y-[-1]">
              <EmptyState
                title="Start the thread"
                description={`Send a message to save the first turn and start ${name} when runtime capacity is available.`}
              />
            </View>
          )}
          renderItem={({ item }) => {
            if (item.kind === "pending") {
              return (
                <MessageBubble
                  entry={pendingEntry(item.pending)}
                  own
                  companionId={id}
                  failed={item.pending.failed}
                  onRetry={() => void sendPending(item.pending)}
                />
              );
            }
            const entry = item.entry;
            if (entry.role === "tool" && entry.tool) return <ToolRow tool={entry.tool} />;
            if (entry.role === "decision" && entry.decision) {
              return (
                <DecisionCard
                  decision={entry.decision}
                  companionName={name}
                  canAct={thread?.can_send === true}
                  skills={names.skills}
                  plugins={names.plugins}
                  models={names.models}
                  onDecide={(input) => decide(entry.decision!, input)}
                />
              );
            }
            const cancellable = entry.queued && entry.turn_id !== null && thread?.can_send === true;
            return (
              <MessageBubble
                entry={entry}
                own={entry.role === "user" && entry.author_id === thread?.viewer_id}
                companionId={id}
                companionIcon={icon}
                onCancelQueued={cancellable ? () => void cancelUnsettled(entry.turn_id!) : undefined}
              />
            );
          }}
        />
      )}

      {thread?.active_turn?.replying === true ? (
        <ReplyingIndicator
          name={name}
          stopping={stoppingTurnId === thread.active_turn.id}
          onStop={thread.can_send
            ? () => void cancelUnsettled(thread.active_turn!.id)
            : undefined}
        />
      ) : null}
      {thread?.interrupted_turn ? (
        <InterruptedCard
          queuedCount={thread.queued_count}
          busy={actionBusy}
          status={actionStatus}
          error={actionError}
          onRetry={() => void retryInterrupted()}
          onCancel={() => void cancelInterrupted()}
        />
      ) : null}
      {thread?.read_only || thread?.can_send === false ? (
        <View className="flex-row items-center gap-2 border-t border-border bg-surface px-4 pb-safe-offset-4 pt-4">
          <Ionicons name="eye-outline" size={18} className="text-muted" />
          <Text className="flex-1 text-sm text-muted">Viewer access is read-only and never contacts the Box.</Text>
        </View>
      ) : (
        <Composer disabled={!thread?.can_send} hint={composerHint(thread, name)} onSend={send} />
      )}
    </KeyboardAvoidingView>
  );
}
