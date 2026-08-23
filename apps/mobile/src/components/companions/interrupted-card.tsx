import { Text, View } from "react-native";

import { Button } from "@/components/ui";

export function InterruptedCard({
  queuedCount,
  busy,
  status,
  error,
  onRetry,
  onCancel,
}: {
  queuedCount: number;
  busy: boolean;
  status?: string | null;
  error?: string | null;
  onRetry: () => void;
  onCancel: () => void;
}) {
  return (
    <View className="gap-3 border-t border-warn-line bg-warn-tint px-4 py-3">
      <Text className="text-sm font-semibold text-foreground">Delivery was interrupted</Text>
      <Text className="text-sm leading-5 text-foreground">
        Earlier external effects may have succeeded. Retry starts a new attempt; Cancel releases the queue.
        {queuedCount > 0 ? ` ${queuedCount} later message${queuedCount === 1 ? " is" : "s are"} waiting.` : ""}
      </Text>
      {status ? <Text accessibilityLiveRegion="polite" className="text-sm leading-5 text-foreground">{status}</Text> : null}
      {error ? <Text accessibilityRole="alert" className="text-sm leading-5 text-danger">{error}</Text> : null}
      <View className="flex-row justify-end gap-2">
        <Button tone="secondary" disabled={busy} onPress={onCancel}>Cancel</Button>
        <Button loading={busy} onPress={onRetry}>Retry</Button>
      </View>
    </View>
  );
}
