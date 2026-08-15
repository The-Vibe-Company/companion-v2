"use client";

import { useState } from "react";
import type { ToolCallMessagePartComponent } from "@assistant-ui/react";
import type { CompanionToolRunKind } from "@companion/contracts";
import {
  AlertTriangleIcon,
  BracesIcon,
  CheckIcon,
  ChevronDownIcon,
  FilePenLineIcon,
  GlobeIcon,
  LoaderIcon,
  MonitorIcon,
  TerminalIcon,
  type LucideIcon,
} from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import type { CompanionToolArgs } from "./transcriptMessages";

/**
 * One tool run Pi performed, as a card inside the turn that performed it.
 *
 * It is deliberately quiet: most runs are read at a glance and skipped, so the card is one line —
 * what ran, and how it ended — and the arguments and whatever the tool returned stay folded away
 * until a reader asks for them. A run that moved the Box desktop also carries one frame of that
 * desktop, shown in place. That frame is the screen as the run left it, not a live stream: watching
 * the machine is what the Computer panel beside the thread is for, and this thread has to stay
 * readable by someone who never opens one.
 *
 * Everything it shows is read from the run in `args`. This thread polls the control plane rather than
 * streaming from a model, so a part is never mid-flight — it is the run exactly as the last poll saw
 * it, and `running` is a state the control plane reported rather than one the runtime inferred.
 */

const TOOL_ICONS: Record<CompanionToolRunKind, LucideIcon> = {
  shell: TerminalIcon,
  file: FilePenLineIcon,
  browse: GlobeIcon,
  computer: MonitorIcon,
  tool: BracesIcon,
};

/** What the card says it is doing, for a reader who cannot see the spinner or the tick. */
const TOOL_STATUS_LABELS = {
  running: "running",
  ok: "done",
  error: "failed",
  timeout: "timed out",
} as const;

export const ToolRunCard: ToolCallMessagePartComponent<CompanionToolArgs> = ({ args }) => {
  const [open, setOpen] = useState(false);
  const run = args?.run;
  if (!run) return null;
  const KindIcon = TOOL_ICONS[run.kind];
  const named = run.title !== run.name;
  const failed = run.status === "error" || run.status === "timeout";

  return (
    <Collapsible
      open={run.detail ? open : false}
      onOpenChange={setOpen}
      data-slot="companion-tool-run"
      className={cn(
        "my-1.5 w-full rounded-md border text-sm",
        failed ? "border-destructive/40 bg-destructive/5" : "border-border bg-muted/40",
      )}
      aria-busy={run.status === "running" || undefined}
    >
      <CollapsibleTrigger
        // A run Pi reported nothing about has nothing to unfold, so the card is a plain line.
        disabled={!run.detail}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-start disabled:cursor-default"
      >
        <KindIcon className="text-muted-foreground size-3.5 shrink-0" aria-hidden="true" />
        <span className="text-foreground font-medium">{run.name}</span>
        {named && (
          <span className="text-muted-foreground min-w-0 flex-1 truncate font-mono text-xs">
            {run.title}
          </span>
        )}
        <span className="ms-auto flex items-center gap-1.5">
          {run.status === "running" && (
            <LoaderIcon
              className="text-muted-foreground size-3.5 animate-spin motion-reduce:animate-none"
              aria-hidden="true"
            />
          )}
          {run.status === "ok" && (
            <CheckIcon className="size-3.5 text-(--color-ok)" aria-hidden="true" />
          )}
          {failed && <AlertTriangleIcon className="text-destructive size-3.5" aria-hidden="true" />}
          <span className="sr-only">{TOOL_STATUS_LABELS[run.status]}</span>
          {run.detail && (
            <ChevronDownIcon
              className={cn(
                "text-muted-foreground size-3.5 transition-transform motion-reduce:transition-none",
                open ? "rotate-0" : "-rotate-90",
              )}
              aria-hidden="true"
            />
          )}
        </span>
      </CollapsibleTrigger>
      {run.detail && (
        <CollapsibleContent className="data-closed:animate-collapsible-up data-open:animate-collapsible-down overflow-hidden motion-reduce:animate-none">
          <pre className="text-muted-foreground max-h-64 overflow-auto px-2.5 pb-2 font-mono text-xs leading-relaxed whitespace-pre-wrap">
            {run.detail}
          </pre>
        </CollapsibleContent>
      )}
      {run.screenshot && (
        // A still, so it is sized like a figure in the transcript rather than like the Computer
        // panel: it never grows past the column it sits in, and never past the width at which a
        // desktop frame stops being readable anyway.
        <img
          className="border-border bg-muted mx-2.5 mb-2.5 max-w-[min(100%,460px)] rounded-md border"
          src={run.screenshot}
          alt={`The Box desktop after ${run.title}`}
          loading="lazy"
        />
      )}
    </Collapsible>
  );
};
