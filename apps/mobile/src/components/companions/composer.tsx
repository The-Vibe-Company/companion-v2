import { Ionicons } from "@expo/vector-icons";
import { useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { useCSSVariable } from "uniwind";

export function Composer({
  disabled,
  hint,
  onSend,
}: {
  disabled: boolean;
  hint: string;
  onSend: (content: string) => Promise<boolean>;
}) {
  const [content, setContent] = useState("");
  const [busy, setBusy] = useState(false);
  const muted = useCSSVariable("--muted");
  const send = async () => {
    const message = content.trim();
    if (!message || disabled || busy) return;
    setBusy(true);
    const accepted = await onSend(message);
    if (accepted) setContent("");
    setBusy(false);
  };
  return (
    <View className="gap-2 border-t border-border bg-surface px-4 pb-safe-offset-2 pt-3">
      <View className="min-h-12 flex-row items-end gap-2 rounded-bubble border border-border bg-field-background px-3 py-2">
        <TextInput
          value={content}
          onChangeText={setContent}
          editable={!disabled && !busy}
          multiline
          maxLength={16_384}
          placeholder="Message your companion"
          placeholderTextColor={`${muted ?? ""}`}
          className="max-h-32 min-h-8 flex-1 py-1 text-base text-foreground"
          accessibilityLabel="Message"
        />
        <Pressable
          onPress={() => void send()}
          disabled={!content.trim() || disabled || busy}
          accessibilityRole="button"
          accessibilityLabel="Send message"
          accessibilityState={{ disabled: !content.trim() || disabled || busy }}
          className="h-11 w-11 items-center justify-center rounded-md bg-accent disabled:opacity-40"
        >
          <Ionicons name="arrow-up" size={21} className="text-accent-foreground" />
        </Pressable>
      </View>
      <Text className="text-xs leading-4 text-muted">{hint}</Text>
    </View>
  );
}
