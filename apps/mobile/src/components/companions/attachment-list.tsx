import { Ionicons } from "@expo/vector-icons";
import { Image } from "expo-image";
import { Directory, File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";
import { memo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useCSSVariable } from "uniwind";

import { attachmentUrl, sessionHeaders } from "@/lib/api";
import { readableSize } from "@/lib/attachments";
import { isAttachmentImage, type CompanionAttachment } from "@/lib/types";

/**
 * The files one message carries, rendered inside the thread. Bytes come from the control-plane
 * attachment route, which re-decides access on every request — so an image simply carries the
 * session headers, and a document is fetched to the cache before the system share sheet opens it.
 */

/** Only a stored (uuid-named) attachment can be fetched; the composer's staged files cannot. */
const STORED_ATTACHMENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function DocumentChip({ companionId, attachment }: {
  companionId: string;
  attachment: CompanionAttachment;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);

  const open = async () => {
    if (busy) return;
    setBusy(true);
    setError(false);
    try {
      // One cache slot per attachment id keeps re-taps instant and re-downloads idempotent.
      const directory = new Directory(Paths.cache, "companion-attachments", attachment.id);
      directory.create({ intermediates: true, idempotent: true });
      const target = new File(directory, attachment.filename);
      if (!target.exists) {
        await File.downloadFileAsync(attachmentUrl(companionId, attachment.id), target, {
          headers: sessionHeaders(),
          idempotent: true,
        });
      }
      await Sharing.shareAsync(target.uri, { mimeType: attachment.content_type });
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Pressable
      onPress={() => void open()}
      accessibilityRole="button"
      accessibilityLabel={`Open ${attachment.filename}`}
      accessibilityState={{ busy }}
      className="flex-row items-center gap-2 rounded-md border border-border bg-surface px-3 py-2 active:bg-surface-raised"
    >
      <Ionicons name="document-text-outline" size={16} className="text-muted" />
      <Text numberOfLines={1} className="max-w-48 text-xs font-medium text-foreground">
        {attachment.filename}
      </Text>
      <Text className="text-xs text-muted">
        {busy ? "Opening…" : error ? "Could not open" : readableSize(attachment.byte_size)}
      </Text>
    </Pressable>
  );
}

export const AttachmentList = memo(function AttachmentList({ companionId, attachments }: {
  companionId: string;
  attachments: CompanionAttachment[];
}) {
  // expo-image is not a react-native component, so uniwind classes do not reach it; its frame is
  // styled inline from the same theme variables instead.
  const borderColor = useCSSVariable("--border");
  const imageBackground = useCSSVariable("--surface-sunken");
  if (attachments.length === 0) return null;
  return (
    <View className="flex-row flex-wrap gap-2">
      {attachments.map((attachment) => {
        if (!STORED_ATTACHMENT_ID.test(attachment.id)) {
          return (
            <View
              key={attachment.id}
              className="flex-row items-center gap-2 rounded-md border border-border px-3 py-2"
            >
              <Ionicons name="attach-outline" size={16} className="text-muted" />
              <Text numberOfLines={1} className="max-w-48 text-xs text-muted">
                {attachment.filename}
              </Text>
              <Text className="text-xs text-muted">{readableSize(attachment.byte_size)}</Text>
            </View>
          );
        }
        if (isAttachmentImage(attachment.content_type)) {
          return (
            <Image
              key={attachment.id}
              source={{
                uri: attachmentUrl(companionId, attachment.id),
                headers: sessionHeaders(),
              }}
              accessibilityLabel={attachment.filename}
              contentFit="contain"
              // A reserved floor: the payload carries no pixel size, so without it the box would
              // jump from zero once the bytes decode, shifting the bottom-anchored transcript.
              style={{
                minHeight: 128,
                maxHeight: 256,
                width: "100%",
                borderRadius: 12,
                borderWidth: 1,
                borderColor: `${borderColor ?? "transparent"}`,
                backgroundColor: `${imageBackground ?? "transparent"}`,
              }}
            />
          );
        }
        return (
          <DocumentChip key={attachment.id} companionId={companionId} attachment={attachment} />
        );
      })}
    </View>
  );
});
