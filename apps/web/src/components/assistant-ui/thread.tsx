"use client";

import { MarkdownText } from "@/components/assistant-ui/markdown-text";
import {
  ReasoningContent,
  ReasoningRoot,
  ReasoningText,
  ReasoningTrigger,
} from "@/components/assistant-ui/reasoning";
import { ToolFallback } from "@/components/assistant-ui/tool-fallback";
import { TooltipIconButton } from "@/components/assistant-ui/tooltip-icon-button";
import { cn } from "@/lib/utils";
import {
  ActionBarPrimitive,
  AuiIf,
  groupPartByType,
  MessagePrimitive,
  ThreadPrimitive,
  type ToolCallMessagePartComponent,
  useAuiState,
} from "@assistant-ui/react";
import { ArrowDownIcon, CheckIcon, CopyIcon } from "lucide-react";
import { createContext, useContext, type ComponentType, type FC } from "react";

/**
 * The assistant-ui registry thread (`r.assistant-ui.com/thread.json`, v0.15.14), pruned to what the
 * Companion thread actually offers. Everything removed is a capability this surface does not have —
 * attachments and their dropzone, dictation, prompt suggestions, branching, editing a sent message,
 * regeneration, and cancelling a run — because the model runs in a remote Box that the control plane
 * only polls: there is no stream to stop, no branch to pick, and no second attempt to ask for.
 * Re-fetching from the registry is an upgrade task, not a refresh: this file is the artifact.
 *
 * What survives is the ChatGPT-shaped reading experience: a viewport that anchors to the newest turn,
 * a floating scroll-to-bottom, right-aligned member bubbles, assistant replies as markdown, reasoning
 * and tool calls behind their own disclosures, and a hover action bar that copies.
 */

export type ThreadComponents = {
  /** Rendered above the messages when the transcript is empty or still loading. */
  Welcome?: ComponentType | undefined;
  /** Rendered under the messages: the composer, or the Viewer's read-only note. */
  Footer?: ComponentType | undefined;
  ToolFallback?: ToolCallMessagePartComponent | undefined;
};

export type ThreadProps = {
  components?: ThreadComponents | undefined;
  /** Placed on the viewport, which is the element that actually scrolls and announces. */
  viewportProps?: React.ComponentProps<typeof ThreadPrimitive.Viewport> | undefined;
};

const EMPTY_COMPONENTS: ThreadComponents = {};

const ThreadComponentsContext = createContext<ThreadComponents>(EMPTY_COMPONENTS);

export const Thread: FC<ThreadProps> = ({
  components = EMPTY_COMPONENTS,
  viewportProps,
}) => {
  const { Welcome, Footer } = components;
  return (
    <ThreadComponentsContext.Provider value={components}>
      <ThreadPrimitive.Root
        className="aui-scope aui-thread-root bg-background @container flex h-full min-h-0 flex-col"
        style={{
          ["--thread-max-width" as string]: "44rem",
          ["--composer-radius" as string]: "1.25rem",
        }}
      >
        <ThreadPrimitive.Viewport
          turnAnchor="top"
          data-slot="aui_thread-viewport"
          {...viewportProps}
          className={cn(
            "relative flex flex-1 flex-col overflow-y-auto scroll-smooth",
            viewportProps?.className,
          )}
        >
          <div className="mx-auto flex w-full max-w-(--thread-max-width) flex-1 flex-col px-4 pt-4">
            {Welcome ? <Welcome /> : null}
            <div
              data-slot="aui_message-group"
              className="flex flex-col gap-y-5 pb-4 empty:hidden"
            >
              <ThreadPrimitive.Messages>
                {() => <ThreadMessage />}
              </ThreadPrimitive.Messages>
            </div>
            <ThreadPrimitive.ViewportFooter className="sticky bottom-0 mt-auto flex flex-col gap-2 overflow-visible pb-1">
              <ThreadScrollToBottom />
              {Footer ? <Footer /> : null}
            </ThreadPrimitive.ViewportFooter>
          </div>
        </ThreadPrimitive.Viewport>
      </ThreadPrimitive.Root>
    </ThreadComponentsContext.Provider>
  );
};

const ThreadMessage: FC = () => {
  const role = useAuiState((s) => s.message.role);
  if (role === "user") return <UserMessage />;
  return <AssistantMessage />;
};

const ThreadScrollToBottom: FC = () => {
  return (
    <ThreadPrimitive.ScrollToBottom asChild>
      <TooltipIconButton
        tooltip="Scroll to bottom"
        variant="outline"
        className="aui-thread-scroll-to-bottom bg-background hover:bg-accent border-border absolute -top-10 z-10 self-center rounded-full border p-4 shadow-sm disabled:invisible"
      >
        <ArrowDownIcon />
      </TooltipIconButton>
    </ThreadPrimitive.ScrollToBottom>
  );
};

const AssistantMessage: FC = () => {
  const { ToolFallback: ToolFallbackComponent = ToolFallback } = useContext(
    ThreadComponentsContext,
  );

  return (
    <MessagePrimitive.Root
      data-slot="aui_assistant-message-root"
      data-role="assistant"
      className="aui-assistant-message-root motion-safe:fade-in motion-safe:slide-in-from-bottom-1 motion-safe:animate-in relative duration-150"
    >
      <div
        data-slot="aui_assistant-message-content"
        className="text-foreground leading-relaxed wrap-break-word"
      >
        <MessagePrimitive.GroupedParts
          groupBy={groupPartByType({
            reasoning: ["group-reasoning"],
            "tool-call": [],
            "standalone-tool-call": [],
          })}
        >
          {({ part, children }) => {
            switch (part.type) {
              case "group-reasoning":
                return (
                  <ReasoningRoot variant="ghost">
                    <ReasoningTrigger />
                    <ReasoningContent>
                      <ReasoningText>{children}</ReasoningText>
                    </ReasoningContent>
                  </ReasoningRoot>
                );
              case "text":
                return <MarkdownText />;
              case "reasoning":
                return <MarkdownText />;
              case "tool-call":
                return part.toolUI ?? <ToolFallbackComponent {...part} />;
              default:
                return null;
            }
          }}
        </MessagePrimitive.GroupedParts>
      </div>
      <div
        data-slot="aui_assistant-message-footer"
        className="flex min-h-7 items-center pt-0.5"
      >
        <AssistantActionBar />
      </div>
    </MessagePrimitive.Root>
  );
};

/**
 * Copy, and only copy. Editing, regeneration, and export each need a control-plane route this thread
 * does not have — a reply is Pi's own turn, projected from its log, not something the browser can ask
 * to be produced again.
 */
const AssistantActionBar: FC = () => {
  return (
    <ActionBarPrimitive.Root
      autohide="not-last"
      className="aui-assistant-action-bar-root text-muted-foreground animate-in fade-in flex gap-1 duration-200"
    >
      <ActionBarPrimitive.Copy asChild>
        <TooltipIconButton tooltip="Copy reply">
          <AuiIf condition={(s) => s.message.isCopied}>
            <CheckIcon className="animate-in zoom-in-50 fade-in duration-200 ease-out" />
          </AuiIf>
          <AuiIf condition={(s) => !s.message.isCopied}>
            <CopyIcon className="animate-in zoom-in-75 fade-in duration-150" />
          </AuiIf>
        </TooltipIconButton>
      </ActionBarPrimitive.Copy>
    </ActionBarPrimitive.Root>
  );
};

const UserMessage: FC = () => {
  return (
    <MessagePrimitive.Root
      data-slot="aui_user-message-root"
      data-role="user"
      className="aui-user-message-root motion-safe:fade-in motion-safe:slide-in-from-bottom-1 motion-safe:animate-in flex flex-col items-end duration-150"
    >
      <div className="aui-user-message-content bg-muted text-foreground max-w-[85%] rounded-2xl px-4 py-2 wrap-break-word empty:hidden">
        <MessagePrimitive.Parts />
      </div>
    </MessagePrimitive.Root>
  );
};
