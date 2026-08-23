import { Text, View } from "react-native";

import { cn } from "@/lib/cn";

export function Badge({ children, tone = "neutral" }: {
  children: string;
  tone?: "neutral" | "ok" | "warn" | "danger";
}) {
  return (
    <View className={cn(
      "self-start rounded-sm border px-2 py-1",
      tone === "neutral" && "border-border bg-surface-raised",
      tone === "ok" && "border-ok-line bg-ok-tint",
      tone === "warn" && "border-warn-line bg-warn-tint",
      tone === "danger" && "border-danger-line bg-danger-tint",
    )}>
      <Text className="text-xs font-medium text-foreground">{children}</Text>
    </View>
  );
}
