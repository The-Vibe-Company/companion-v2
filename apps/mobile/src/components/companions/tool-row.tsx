import { Ionicons } from "@expo/vector-icons";
import { Image } from "expo-image";
import { memo, useState } from "react";
import { Pressable, Text, View } from "react-native";

import type { CompanionToolRun } from "@/lib/types";
import { Badge } from "@/components/ui";

export const ToolRow = memo(function ToolRow({ tool }: { tool: CompanionToolRun }) {
  const [open, setOpen] = useState(false);
  const statusTone = tool.status === "ok" ? "ok" : tool.status === "running" ? "warn" : "danger";
  return (
    <View className="mx-4 my-2 overflow-hidden rounded-md border border-border bg-surface">
      <Pressable
        onPress={() => setOpen((value) => !value)}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        className="min-h-11 flex-row items-center gap-3 px-3 py-2 active:bg-surface-raised"
      >
        <Ionicons name="terminal-outline" size={17} className="text-muted" />
        <View className="min-w-0 flex-1">
          <Text numberOfLines={1} className="text-sm font-medium text-foreground">{tool.title || tool.name}</Text>
          <Text className="text-xs text-muted">{tool.kind}</Text>
        </View>
        <Badge tone={statusTone}>{tool.status}</Badge>
        <Ionicons name={open ? "chevron-up" : "chevron-down"} size={16} className="text-muted" />
      </Pressable>
      {open && tool.detail ? (
        <Text selectable className="border-t border-separator bg-surface-sunken p-3 font-mono text-xs leading-5 text-foreground">
          {tool.detail}
        </Text>
      ) : null}
      {open && tool.screenshot ? (
        <View className="border-t border-separator bg-surface-sunken">
          <Image
            source={{ uri: tool.screenshot }}
            accessibilityLabel="Box desktop when this run ended"
            contentFit="contain"
            style={{ width: "100%", height: 200 }}
          />
        </View>
      ) : null}
    </View>
  );
});
