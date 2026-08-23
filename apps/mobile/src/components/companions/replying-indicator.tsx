import { Text, View } from "react-native";

export function ReplyingIndicator({ name }: { name: string }) {
  return (
    <View className="flex-row items-center gap-2 px-4 py-3" accessibilityLabel={`${name} is replying`}>
      <View className="flex-row gap-1">
        <View className="h-1.5 w-1.5 rounded-full bg-muted" />
        <View className="h-1.5 w-1.5 rounded-full bg-muted" />
        <View className="h-1.5 w-1.5 rounded-full bg-muted" />
      </View>
      <Text className="text-sm text-muted">{name} is replying...</Text>
    </View>
  );
}
