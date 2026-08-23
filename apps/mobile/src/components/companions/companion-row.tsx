import { Pressable, Text, View } from "react-native";

import type { Companion } from "@/lib/types";
import { CompanionIcon } from "./companion-icon";

function relativeTime(value: string): string {
  const elapsed = Math.max(0, Date.now() - new Date(value).getTime());
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return "Now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function preview(companion: Companion): string {
  const message = companion.last_message;
  if (!message) return companion.persona ?? "No messages yet";
  if (message.routine_name) return `Routine: ${message.routine_name}`;
  if (message.trigger_name) return `Trigger: ${message.trigger_name}`;
  const author = message.role === "assistant" ? "" : message.author_name ? `${message.author_name}: ` : "You: ";
  return `${author}${message.preview}`;
}

export function CompanionRow({ companion, onPress }: { companion: Companion; onPress: () => void }) {
  const status = companion.runtime.replying ? "Replying" : companion.runtime.state;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${companion.name}, ${status}${companion.unread ? ", unread" : ""}`}
      className="min-h-18 flex-row items-center gap-3 border-b border-separator bg-surface px-4 py-3 active:bg-surface-raised"
    >
      <CompanionIcon icon={companion.icon} size={34} />
      <View className="min-w-0 flex-1 gap-1">
        <View className="flex-row items-center gap-2">
          <Text numberOfLines={1} className="min-w-0 flex-1 text-base font-semibold text-foreground">
            {companion.name}
          </Text>
          {companion.last_message ? (
            <Text className="text-xs text-muted">{relativeTime(companion.last_message.created_at)}</Text>
          ) : null}
        </View>
        <View className="flex-row items-center gap-2">
          <Text numberOfLines={1} className="min-w-0 flex-1 text-sm text-muted">
            {companion.runtime.replying ? "Replying..." : preview(companion)}
          </Text>
          {companion.unread ? <View className="h-2 w-2 rounded-full bg-accent" accessibilityLabel="Unread" /> : null}
        </View>
      </View>
    </Pressable>
  );
}
