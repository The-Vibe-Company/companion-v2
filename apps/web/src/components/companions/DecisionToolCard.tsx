"use client";

import { useState } from "react";
import type { ToolCallMessagePartComponent } from "@assistant-ui/react";
import type { CompanionDecisionKind } from "@companion/contracts";
import {
  AlertTriangleIcon,
  CheckIcon,
  FilePenLineIcon,
  LoaderIcon,
  MessageSquareIcon,
  TerminalIcon,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useDecisionActions, type DecisionAction } from "./decisionActions";
import type { CompanionDecisionArgs } from "./transcriptMessages";

/**
 * One permission card in the thread.
 *
 * Pi is blocked while this is pending — the Box extension is holding a shell command, a file edit, or
 * a question open — so the card is the loudest thing the transcript ever shows, and it stays in place
 * once it is decided rather than disappearing: who allowed what, and when, is part of the record.
 * Only an Owner or Editor is offered the controls; a Viewer reads the same card and is told who the
 * thread is waiting on. A card that timed out reads as denied, because that is what fail-closed did.
 */

const DECISION_ICONS: Record<CompanionDecisionKind, LucideIcon> = {
  shell: TerminalIcon,
  file: FilePenLineIcon,
  question: MessageSquareIcon,
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

export const DecisionToolCard: ToolCallMessagePartComponent<CompanionDecisionArgs> = ({ args }) => {
  const { canAct, onDecide } = useDecisionActions();
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const decision = args?.decision;
  if (!decision) return null;

  const pending = decision.status === "pending";
  const interactive = pending && canAct && !busy;
  const settledWell = decision.status === "allowed" || decision.status === "answered";
  const status = DECISION_STATUS_LABELS[decision.status];
  const KindIcon = DECISION_ICONS[decision.kind];
  const requestId = decision.request_id;

  async function act(input: DecisionAction) {
    if (!interactive) return;
    setBusy(true);
    try {
      await onDecide(requestId, input);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      data-slot="companion-decision"
      className={cn(
        "my-2 w-full rounded-lg border p-2.5 text-sm",
        pending && "border-primary/40 bg-primary/5",
        !pending && settledWell && "border-border bg-muted/40",
        !pending && !settledWell && "border-destructive/40 bg-destructive/5",
      )}
      aria-busy={pending || undefined}
    >
      <div className="flex items-center gap-2">
        <KindIcon className="text-muted-foreground size-3.5 shrink-0" aria-hidden="true" />
        <span className="text-foreground font-medium">
          {decision.kind === "question" ? "Question" : `Allow ${DECISION_KIND_LABELS[decision.kind]}`}
        </span>
        <span className="text-muted-foreground min-w-0 flex-1 truncate font-mono text-xs">
          {decision.name}
        </span>
        {pending
          ? (
            <LoaderIcon
              className="text-muted-foreground size-3.5 animate-spin motion-reduce:animate-none"
              aria-hidden="true"
            />
          )
          : settledWell
            ? <CheckIcon className="size-3.5 text-(--color-ok)" aria-hidden="true" />
            : <AlertTriangleIcon className="text-destructive size-3.5" aria-hidden="true" />}
        <span className="sr-only">{status}</span>
      </div>

      <pre className="text-foreground mt-1.5 max-h-40 overflow-auto font-mono text-xs leading-relaxed whitespace-pre-wrap">
        {decision.title}
      </pre>

      {decision.kind === "question" && decision.answer && (
        <p className="text-foreground mt-1.5 text-sm">{decision.answer}</p>
      )}
      {!pending && decision.decided_by_name && (
        <p className="text-muted-foreground mt-1.5 text-xs">
          {status} by {decision.decided_by_name}
        </p>
      )}
      {decision.status === "expired" && !decision.decided_by_name && (
        <p className="text-muted-foreground mt-1.5 text-xs">Timed out — denied</p>
      )}

      {interactive && decision.kind === "question" && (
        <form
          className="mt-2 flex flex-wrap items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const value = answer.trim();
            if (!value) return;
            void act({ action: "answer", answer: value });
          }}
        >
          <input
            className="border-input focus-visible:ring-ring/50 min-w-40 flex-1 rounded-md border px-2.5 py-1.5 text-sm outline-none focus-visible:ring-[3px]"
            value={answer}
            onChange={(event) => setAnswer(event.target.value)}
            placeholder="Your answer"
            aria-label="Answer"
            disabled={busy}
          />
          <Button type="submit" size="sm" disabled={busy || !answer.trim()}>Answer</Button>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={busy}
            onClick={() => void act({ action: "deny" })}
          >
            Deny
          </Button>
        </form>
      )}
      {interactive && decision.kind !== "question" && (
        <div className="mt-2 flex items-center gap-2">
          <Button type="button" size="sm" disabled={busy} onClick={() => void act({ action: "allow" })}>
            Allow
          </Button>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={busy}
            onClick={() => void act({ action: "deny" })}
          >
            Deny
          </Button>
        </div>
      )}
      {pending && !canAct && (
        <p className="text-muted-foreground mt-1.5 text-xs">Waiting for an Owner or Editor</p>
      )}
    </section>
  );
};
