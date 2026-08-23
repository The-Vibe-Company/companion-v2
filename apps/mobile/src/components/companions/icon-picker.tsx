import { Text, View } from "react-native";

import { Button } from "@/components/ui";
import type { CompanionIconValue } from "@/lib/types";
import { CompanionIcon, iconCatalog } from "./companion-icon";

/* The persisted icon catalog calls its geometric body index "shape". */
/* oxlint-disable anti-slop/no-shape-in-symbol-names */

const labels = ["Shape", "Mouth", "Accessory", "Color"] as const;
const fields = ["shape", "mouth", "accessory", "color"] as const;

export function randomIcon(): CompanionIconValue {
  return {
    shape: Math.floor(Math.random() * iconCatalog.shapes),
    mouth: Math.floor(Math.random() * iconCatalog.mouths),
    accessory: Math.floor(Math.random() * iconCatalog.accessories),
    color: Math.floor(Math.random() * iconCatalog.colors),
  };
}

export function IconPicker({ value, onChange }: {
  value: CompanionIconValue;
  onChange: (value: CompanionIconValue) => void;
}) {
  return (
    <View className="gap-4">
      <View className="items-center gap-3">
        <CompanionIcon icon={value} size={92} />
        <Button tone="secondary" size="sm" onPress={() => onChange(randomIcon())}>Randomize</Button>
      </View>
      <View className="gap-2">
        {fields.map((field, index) => {
          const count = iconCatalog[field === "shape" ? "shapes" : field === "mouth" ? "mouths" : field === "accessory" ? "accessories" : "colors"];
          return (
            <View key={field} className="min-h-11 flex-row items-center gap-3 border-b border-separator py-2">
              <Text className="flex-1 text-sm font-medium text-foreground">{labels[index]}</Text>
              <Button
                tone="ghost"
                size="sm"
                accessibilityLabel={`Previous ${labels[index]}, current value ${value[field] + 1}`}
                onPress={() => onChange({ ...value, [field]: (value[field] - 1 + count) % count })}
              >Previous</Button>
              <Text className="w-8 text-center font-mono text-xs text-muted">{value[field] + 1}</Text>
              <Button
                tone="ghost"
                size="sm"
                accessibilityLabel={`Next ${labels[index]}, current value ${value[field] + 1}`}
                onPress={() => onChange({ ...value, [field]: (value[field] + 1) % count })}
              >Next</Button>
            </View>
          );
        })}
      </View>
    </View>
  );
}
