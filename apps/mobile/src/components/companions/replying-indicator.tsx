import { Pressable, Text, View } from "react-native";

export function ReplyingIndicator({ name, onStop, stopping }: {
  name: string;
  /** Cancel the active turn; absent for a Viewer. */
  onStop?: () => void;
  stopping?: boolean;
}) {
  return (
    <View className="flex-row items-center gap-2 px-4 py-3" accessibilityLabel={`${name} is replying`}>
      <View className="flex-row gap-1">
        <View className="h-1.5 w-1.5 rounded-full bg-muted" />
        <View className="h-1.5 w-1.5 rounded-full bg-muted" />
        <View className="h-1.5 w-1.5 rounded-full bg-muted" />
      </View>
      <Text className="flex-1 text-sm text-muted">{name} is replying...</Text>
      {onStop ? (
        <Pressable
          onPress={onStop}
          disabled={stopping}
          accessibilityRole="button"
          accessibilityLabel="Stop this turn"
          accessibilityState={{ disabled: stopping }}
          hitSlop={8}
          className="rounded-md border border-border px-3 py-1.5 disabled:opacity-40"
        >
          <Text className="text-xs font-medium text-foreground">{stopping ? "Stopping…" : "Stop"}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}
