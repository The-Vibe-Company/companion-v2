import { Ionicons } from "@expo/vector-icons";
import { memo, useState } from "react";
import { Pressable, Text, View } from "react-native";

import type { TranscriptEntry } from "@/lib/types";
import { Badge } from "@/components/ui";
import { AttachmentList } from "./attachment-list";
import { CompanionIcon } from "./companion-icon";
import { MarkdownText } from "./markdown-text";

/** What Pi thought before it answered, closed by default the way the web disclosure is. */
function Reasoning({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <View className="gap-1">
      <Pressable
        onPress={() => setOpen((value) => !value)}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        className="flex-row items-center gap-1"
      >
        <Ionicons name={open ? "chevron-down" : "chevron-forward"} size={13} className="text-muted" />
        <Text className="text-xs font-medium text-muted">Thought process</Text>
      </Pressable>
      {open ? <Text selectable className="text-sm leading-5 text-muted">{text}</Text> : null}
    </View>
  );
}

export const MessageBubble = memo(function MessageBubble({
  entry,
  own,
  companionId,
  companionIcon,
  failed,
  onRetry,
  onCancelQueued,
}: {
  entry: TranscriptEntry;
  own: boolean;
  companionId: string;
  companionIcon?: Parameters<typeof CompanionIcon>[0]["icon"];
  failed?: boolean;
  onRetry?: () => void;
  /** Cancel this saved-but-not-started message; offered on exactly the queued rows. */
  onCancelQueued?: () => void;
}) {
  if (entry.routine) {
    return <Text className="px-4 py-2 text-xs font-medium text-muted">Routine: {entry.routine.name}</Text>;
  }
  if (entry.trigger) {
    return <Text className="px-4 py-2 text-xs font-medium text-muted">Trigger: {entry.trigger.name}</Text>;
  }
  if (entry.role === "system") {
    return <Text className="px-8 py-2 text-center text-xs text-muted">{entry.content.replaceAll("Pi", "Companion")}</Text>;
  }
  if (entry.role === "assistant") {
    return (
      <View className="flex-row items-start gap-2 px-4 py-2">
        <CompanionIcon icon={companionIcon} size={18} />
        <View className="min-w-0 flex-1 gap-2">
          {entry.reasoning ? <Reasoning text={entry.reasoning} /> : null}
          {entry.content ? <MarkdownText content={entry.content} /> : null}
          <AttachmentList companionId={companionId} attachments={entry.attachments} />
        </View>
      </View>
    );
  }
  return (
    <View className={`${own ? "items-end" : "items-start"} px-4 py-2`}>
      {!own && entry.author_name ? (
        <Text className="pb-1 text-xs font-medium text-muted">{entry.author_name}</Text>
      ) : null}
      <Pressable
        disabled={!failed}
        onPress={onRetry}
        accessibilityRole={failed ? "button" : undefined}
        accessibilityLabel={failed ? "Message not sent. Tap to retry." : undefined}
        className="max-w-[84%] gap-2 rounded-bubble bg-accent-tint px-4 py-3"
      >
        {entry.content ? (
          <Text selectable className="text-base leading-6 text-foreground">{entry.content}</Text>
        ) : null}
        <AttachmentList companionId={companionId} attachments={entry.attachments} />
        {entry.queued ? (
          <View className="flex-row items-center gap-2">
            <Badge>Queued</Badge>
            {onCancelQueued ? (
              <Pressable
                onPress={onCancelQueued}
                accessibilityRole="button"
                accessibilityLabel="Cancel this queued message"
                hitSlop={8}
              >
                <Text className="text-xs font-medium text-danger">Cancel</Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}
        {failed ? <Text className="text-xs font-medium text-danger">Not sent, tap to retry</Text> : null}
      </Pressable>
    </View>
  );
});
