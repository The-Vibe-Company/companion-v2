import { Ionicons } from "@expo/vector-icons";
import { Pressable, Text, View } from "react-native";

export function ScreenHeader({
  title,
  subtitle,
  onBack,
  action,
}: {
  title: string;
  subtitle?: string;
  onBack?: () => void;
  action?: React.ReactNode;
}) {
  return (
    <View collapsable={false} className="min-h-14 flex-row items-center gap-3 border-b border-border bg-surface px-4 py-2">
      {onBack ? (
        <Pressable
          onPress={onBack}
          accessibilityRole="button"
          accessibilityLabel="Go back"
          hitSlop={10}
          className="h-11 w-11 items-center justify-center rounded-md active:bg-surface-raised"
        >
          <Ionicons name="chevron-back" size={22} className="text-foreground" />
        </Pressable>
      ) : null}
      <View className="min-w-0 flex-1">
        <Text numberOfLines={1} className="text-lg font-semibold text-foreground">{title}</Text>
        {subtitle ? <Text numberOfLines={1} className="text-xs text-muted">{subtitle}</Text> : null}
      </View>
      {action}
    </View>
  );
}
