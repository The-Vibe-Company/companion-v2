import { memo } from "react";
import { Pressable, Text, View } from "react-native";

import type { TranscriptEntry } from "@/lib/types";
import { Badge } from "@/components/ui";
import { CompanionIcon } from "./companion-icon";

function RichText({ content }: { content: string }) {
  const parts = content.split("```");
  return (
    <View className="gap-2">
      {parts.map((part, index) => index % 2 === 1 ? (
        <Text key={`${index}-${part.slice(0, 8)}`} selectable className="rounded-md bg-surface-sunken p-3 font-mono text-sm leading-5 text-foreground">
          {part.replace(/^\w+\n/, "")}
        </Text>
      ) : part ? (
        <Text key={`${index}-${part.slice(0, 8)}`} selectable className="text-base leading-6 text-foreground">{part}</Text>
      ) : null)}
    </View>
  );
}

export const MessageBubble = memo(function MessageBubble({
  entry,
  own,
  companionIcon,
  failed,
  onRetry,
}: {
  entry: TranscriptEntry;
  own: boolean;
  companionIcon?: Parameters<typeof CompanionIcon>[0]["icon"];
  failed?: boolean;
  onRetry?: () => void;
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
        <View className="min-w-0 flex-1"><RichText content={entry.content} /></View>
      </View>
    );
  }
  return (
    <View className={`${own ? "items-end" : "items-start"} px-4 py-2`}>
      <Pressable
        disabled={!failed}
        onPress={onRetry}
        accessibilityRole={failed ? "button" : undefined}
        accessibilityLabel={failed ? "Message not sent. Tap to retry." : undefined}
        className="max-w-[84%] gap-2 rounded-bubble bg-accent-tint px-4 py-3"
      >
        <Text selectable className="text-base leading-6 text-foreground">{entry.content}</Text>
        {entry.queued ? <Badge>Queued</Badge> : null}
        {failed ? <Text className="text-xs font-medium text-danger">Not sent, tap to retry</Text> : null}
      </Pressable>
    </View>
  );
});
