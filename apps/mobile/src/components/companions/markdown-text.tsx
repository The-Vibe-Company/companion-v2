import { memo } from "react";
import { Linking, Text, View } from "react-native";

import { parseMarkdown, type BlockNode, type InlineNode } from "@/lib/markdown";

function InlineNodes({ nodes }: { nodes: InlineNode[] }) {
  return (
    <>
      {nodes.map((node, index) => {
        const key = `${node.kind}-${index}`;
        switch (node.kind) {
          case "bold":
            return (
              <Text key={key} className="font-semibold">
                <InlineNodes nodes={node.children} />
              </Text>
            );
          case "italic":
            return (
              <Text key={key} className="italic">
                <InlineNodes nodes={node.children} />
              </Text>
            );
          case "code":
            return (
              <Text key={key} className="rounded-sm bg-surface-sunken font-mono text-sm">
                {node.text}
              </Text>
            );
          case "link":
            return (
              <Text
                key={key}
                accessibilityRole="link"
                className="text-accent underline"
                onPress={() => void Linking.openURL(node.href).catch(() => undefined)}
              >
                {node.label}
              </Text>
            );
          default:
            return <Text key={key}>{node.text}</Text>;
        }
      })}
    </>
  );
}

function Block({ block }: { block: BlockNode }) {
  switch (block.kind) {
    case "heading":
      return (
        <Text
          selectable
          accessibilityRole="header"
          className={`${block.level <= 2 ? "text-lg" : "text-base"} font-semibold leading-6 text-foreground`}
        >
          <InlineNodes nodes={block.children} />
        </Text>
      );
    case "code":
      return (
        <Text
          selectable
          className="rounded-md bg-surface-sunken p-3 font-mono text-sm leading-5 text-foreground"
        >
          {block.text}
        </Text>
      );
    case "list":
      return (
        <View className="gap-1">
          {block.items.map((item, index) => (
            // A transcript block never reorders, so the position is the identity of its row.
            // oxlint-disable-next-line react/no-array-index-key
            <View key={index} className="flex-row gap-2">
              <Text className="text-base leading-6 text-muted">
                {block.ordered ? `${index + 1}.` : "•"}
              </Text>
              <Text selectable className="min-w-0 flex-1 text-base leading-6 text-foreground">
                <InlineNodes nodes={item} />
              </Text>
            </View>
          ))}
        </View>
      );
    case "quote":
      return (
        <View className="border-l-2 border-border pl-3">
          <Text selectable className="text-base leading-6 text-muted">
            <InlineNodes nodes={block.children} />
          </Text>
        </View>
      );
    case "rule":
      return <View className="h-px bg-border" />;
    default:
      return (
        <Text selectable className="text-base leading-6 text-foreground">
          <InlineNodes nodes={block.children} />
        </Text>
      );
  }
}

export const MarkdownText = memo(function MarkdownText({ content }: { content: string }) {
  const blocks = parseMarkdown(content);
  return (
    <View className="gap-2">
      {blocks.map((block, index) => (
        // Blocks of one immutable entry never reorder; the position is the block's identity.
        // oxlint-disable-next-line react/no-array-index-key
        <Block key={index} block={block} />
      ))}
    </View>
  );
});
