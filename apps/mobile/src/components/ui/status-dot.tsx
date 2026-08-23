import { Text, View } from "react-native";

import { cn } from "@/lib/cn";

export function StatusDot({ label, tone }: {
  label: string;
  tone: "ok" | "warn" | "danger" | "unknown";
}) {
  return (
    <View className="flex-row items-center gap-2" accessibilityLabel={label}>
      <View className={cn(
        "h-2 w-2 rounded-full",
        tone === "ok" && "bg-ok",
        tone === "warn" && "bg-warn",
        tone === "danger" && "bg-danger",
        tone === "unknown" && "bg-muted",
      )} />
      <Text className="text-xs text-muted">{label}</Text>
    </View>
  );
}
