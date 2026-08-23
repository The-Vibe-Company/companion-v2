import { Ionicons } from "@expo/vector-icons";
import { Text, View } from "react-native";

import { Button } from "./button";

export function EmptyState({
  title,
  description,
  action,
  onAction,
}: {
  title: string;
  description: string;
  action?: string;
  onAction?: () => void;
}) {
  return (
    <View className="flex-1 items-center justify-center gap-3 px-8 py-12">
      <Ionicons name="chatbubbles-outline" size={30} className="text-muted" />
      <Text className="text-center text-lg font-semibold text-foreground">{title}</Text>
      <Text className="max-w-80 text-center text-sm leading-5 text-muted">{description}</Text>
      {action && onAction ? <Button onPress={onAction}>{action}</Button> : null}
    </View>
  );
}
