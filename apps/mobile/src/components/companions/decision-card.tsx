import { memo, useState } from "react";
import { Text, View } from "react-native";

import type { CompanionDecision } from "@/lib/types";
import { Badge, Button, Field } from "@/components/ui";

export const DecisionCard = memo(function DecisionCard({
  decision,
  canAct,
  onDecide,
}: {
  decision: CompanionDecision;
  canAct: boolean;
  onDecide: (input: { action: "allow" | "deny" } | { action: "answer"; answer: string }) => Promise<void>;
}) {
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = decision.status === "pending";
  const proposal = decision.kind === "config" || decision.kind === "routine" || decision.kind === "trigger";

  const act = async (input: { action: "allow" | "deny" } | { action: "answer"; answer: string }) => {
    setBusy(true);
    setError(null);
    try {
      await onDecide(input);
    } catch {
      setError("The response was not saved. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <View className="mx-4 my-2 gap-3 rounded-md border border-warn-line bg-warn-tint p-4">
      <View className="flex-row items-center justify-between gap-3">
        <Text className="min-w-0 flex-1 text-sm font-semibold text-foreground">
          {decision.kind === "question" ? "Question" : proposal ? "Proposal" : "Permission requested"}
        </Text>
        <Badge tone={pending ? "warn" : "neutral"}>{decision.status}</Badge>
      </View>
      <Text className="text-base leading-6 text-foreground">{decision.title}</Text>
      {decision.detail ? <Text selectable className="font-mono text-xs leading-5 text-muted">{decision.detail}</Text> : null}
      {proposal ? (
        <Text className="text-sm text-muted">Review this proposal on the web.</Text>
      ) : pending && canAct && decision.kind === "question" ? (
        <View className="gap-3">
          <Field
            label="Your answer"
            value={answer}
            onChangeText={setAnswer}
            maxLength={8_000}
            multiline
            className="min-h-20 py-3"
          />
          <View className="flex-row justify-end gap-2">
            <Button tone="secondary" disabled={busy} onPress={() => void act({ action: "deny" })}>Deny</Button>
            <Button loading={busy} disabled={!answer.trim()} onPress={() => void act({ action: "answer", answer: answer.trim() })}>Send answer</Button>
          </View>
        </View>
      ) : pending && canAct ? (
        <View className="flex-row justify-end gap-2">
          <Button tone="secondary" disabled={busy} onPress={() => void act({ action: "deny" })}>Deny</Button>
          <Button loading={busy} onPress={() => void act({ action: "allow" })}>Allow</Button>
        </View>
      ) : null}
      {error ? <Text accessibilityRole="alert" className="text-sm text-danger">{error}</Text> : null}
    </View>
  );
});
