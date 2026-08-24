import { Ionicons } from "@expo/vector-icons";
import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import { useState } from "react";
import { Alert, Pressable, Text, TextInput, View } from "react-native";
import { useCSSVariable } from "uniwind";

import type { PickedAttachment } from "@/lib/api";
import { acceptAttachments, PICKABLE_MIME_TYPES, readableSize } from "@/lib/attachments";
import { ATTACHMENT_MAX_COUNT } from "@/lib/types";

export function Composer({
  disabled,
  hint,
  onSend,
}: {
  disabled: boolean;
  hint: string;
  onSend: (content: string, files: readonly PickedAttachment[]) => Promise<boolean>;
}) {
  const [content, setContent] = useState("");
  const [busy, setBusy] = useState(false);
  const [files, setFiles] = useState<readonly PickedAttachment[]>([]);
  const [fileError, setFileError] = useState<string | null>(null);
  const muted = useCSSVariable("--muted");

  const stage = (incoming: readonly { uri: string; name: string; type: string; byteSize: number }[]) => {
    setFiles((staged) => {
      const accepted = acceptAttachments(staged, incoming);
      setFileError(accepted.error);
      return accepted.files;
    });
  };

  const pickPhotos = async () => {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      allowsMultipleSelection: true,
      selectionLimit: ATTACHMENT_MAX_COUNT,
      quality: 1,
    });
    if (result.canceled) return;
    stage(result.assets.map((asset, index) => ({
      uri: asset.uri,
      name: asset.fileName ?? `photo-${index}.jpg`,
      type: asset.mimeType ?? "image/jpeg",
      byteSize: asset.fileSize ?? 1,
    })));
  };

  const pickDocuments = async () => {
    const result = await DocumentPicker.getDocumentAsync({
      multiple: true,
      copyToCacheDirectory: true,
      type: PICKABLE_MIME_TYPES,
    });
    if (result.canceled) return;
    stage(result.assets.map((asset, index) => ({
      uri: asset.uri,
      name: asset.name || `file-${index}`,
      type: asset.mimeType ?? "",
      byteSize: asset.size ?? 1,
    })));
  };

  const attach = () => {
    Alert.alert("Attach to this message", undefined, [
      { text: "Photo library", onPress: () => void pickPhotos().catch(() => undefined) },
      { text: "Choose a file", onPress: () => void pickDocuments().catch(() => undefined) },
      { text: "Cancel", style: "cancel" },
    ]);
  };

  const send = async () => {
    const message = content.trim();
    if (!message || disabled || busy) return;
    setBusy(true);
    const accepted = await onSend(message, files);
    if (accepted) {
      setContent("");
      setFiles([]);
      setFileError(null);
    }
    setBusy(false);
  };

  return (
    <View className="gap-2 border-t border-border bg-surface px-4 pb-safe-offset-2 pt-3">
      {files.length > 0 ? (
        <View className="flex-row flex-wrap gap-2">
          {files.map((file, index) => (
            <View
              key={`${file.uri}:${index}`}
              className="flex-row items-center gap-2 rounded-md border border-border bg-field-background px-2 py-1.5"
            >
              <Ionicons
                name={file.type.startsWith("image/") ? "image-outline" : "document-text-outline"}
                size={14}
                className="text-muted"
              />
              <Text numberOfLines={1} className="max-w-40 text-xs font-medium text-foreground">
                {file.name}
              </Text>
              <Text className="text-xs text-muted">{readableSize(file.byteSize)}</Text>
              <Pressable
                onPress={() => setFiles((staged) => staged.filter((_, at) => at !== index))}
                accessibilityRole="button"
                accessibilityLabel={`Remove ${file.name}`}
                hitSlop={8}
              >
                <Ionicons name="close" size={14} className="text-muted" />
              </Pressable>
            </View>
          ))}
        </View>
      ) : null}
      {fileError ? (
        <Text accessibilityRole="alert" className="text-xs text-danger">{fileError}</Text>
      ) : null}
      <View className="min-h-12 flex-row items-end gap-2 rounded-bubble border border-border bg-field-background px-3 py-2">
        <Pressable
          onPress={attach}
          disabled={disabled || busy}
          accessibilityRole="button"
          accessibilityLabel="Attach a photo or file"
          accessibilityState={{ disabled: disabled || busy }}
          className="h-11 w-9 items-center justify-center disabled:opacity-40"
        >
          <Ionicons name="add" size={22} className="text-muted" />
        </Pressable>
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
