import { memo, useState } from "react";
import { Pressable, Text, View } from "react-native";

import type {
  CompanionConfigProposal,
  CompanionDecision,
  CompanionRoutineProposal,
  CompanionTriggerProposal,
  NamedResource,
} from "@/lib/types";
import { Badge, Button, Field } from "@/components/ui";

/**
 * One permission card in the thread. Pi is blocked while it is pending, so an Owner/Editor gets the
 * controls right here — a question takes an answer, a shell/file request takes Allow/Deny, and a
 * config/routine/trigger proposal shows what would change and takes Approve/Deny, exactly as the web
 * card does. Resource names come from catalogs this surface loaded, never from the Pi payload.
 */

const UNKNOWN_RESOURCE = "a resource owned by another member";

function namedLabel(id: string, catalog: readonly NamedResource[]): { label: string; known: boolean } {
  const match = catalog.find((item) => item.id === id);
  return match ? { label: match.label, known: true } : { label: UNKNOWN_RESOURCE, known: false };
}

/** A closed-by-default prompt disclosure, shared by routine and trigger proposals. */
function PromptDisclosure({ prompt }: { prompt: string }) {
  const [open, setOpen] = useState(false);
  return (
    <View className="gap-1">
      <Pressable
        onPress={() => setOpen((value) => !value)}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
      >
        <Text className="text-xs font-medium text-muted">{open ? "Hide prompt" : "Show prompt"}</Text>
      </Pressable>
      {open ? <Text selectable className="text-sm leading-5 text-foreground">{prompt}</Text> : null}
    </View>
  );
}

function ConfigChanges({ proposal, skills, plugins, models }: {
  proposal: CompanionConfigProposal;
  skills: readonly NamedResource[];
  plugins: readonly NamedResource[];
  models: readonly NamedResource[];
}) {
  if (proposal.connect_plugin) {
    return (
      <View className="gap-1">
        <Text className="text-sm text-foreground">
          Connect <Text className="font-medium capitalize">{proposal.connect_plugin.server_name}</Text>
          {proposal.connect_plugin.reason ? ` — ${proposal.connect_plugin.reason}` : ""}
        </Text>
        <Text className="text-xs text-muted">Finish this connection in Plugins on the web.</Text>
      </View>
    );
  }
  const rows: { sign: string; label: string; known: boolean }[] = [];
  for (const id of proposal.add_skill_ids ?? []) {
    const named = namedLabel(id, skills);
    rows.push({ sign: "+", label: named.label, known: named.known });
  }
  for (const id of proposal.remove_skill_ids ?? []) {
    const named = namedLabel(id, skills);
    rows.push({ sign: "−", label: named.label, known: named.known });
  }
  for (const id of proposal.attach_plugin_ids ?? []) {
    const named = namedLabel(id, plugins);
    rows.push({ sign: "+", label: `plugin ${named.label}`, known: named.known });
  }
  for (const id of proposal.detach_plugin_ids ?? []) {
    const named = namedLabel(id, plugins);
    rows.push({ sign: "−", label: `plugin ${named.label}`, known: named.known });
  }
  if (proposal.model_id) {
    const named = namedLabel(proposal.model_id, models);
    rows.push({ sign: "→", label: `model ${named.known ? named.label : proposal.model_id}`, known: true });
  }
  return (
    <View className="gap-1">
      {rows.map((row, index) => (
        <View key={`${row.sign}:${row.label}:${index}`} className="flex-row gap-2">
          <Text className="w-3 font-mono text-sm text-muted">{row.sign}</Text>
          <Text className={`min-w-0 flex-1 text-sm ${row.known ? "text-foreground" : "text-muted"}`}>
            {row.label}
          </Text>
        </View>
      ))}
      {proposal.persona !== undefined ? (
        <View className="gap-0.5">
          <Text className="text-xs font-medium text-muted">Persona</Text>
          <Text selectable className="text-sm text-foreground">
            {proposal.persona?.trim() ? proposal.persona : "(empty)"}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

function RoutineDetails({ proposal }: { proposal: CompanionRoutineProposal }) {
  return (
    <View className="gap-1">
      <Text className="text-sm text-foreground">
        <Text className="font-medium">{proposal.name}</Text>
        <Text className="text-muted"> · </Text>
        <Text className="font-mono text-xs">{proposal.cron}</Text>
        <Text className="text-muted"> · {proposal.timezone}</Text>
      </Text>
      <PromptDisclosure prompt={proposal.prompt} />
    </View>
  );
}

function TriggerDetails({ proposal }: { proposal: CompanionTriggerProposal }) {
  return (
    <View className="gap-1">
      <Text className="text-sm text-foreground">
        <Text className="font-medium">{proposal.name}</Text>
        <Text className="text-muted"> · </Text>
        <Text className="font-mono text-xs">{proposal.provider}</Text>
        {proposal.target?.repo ? <Text className="text-muted"> · {proposal.target.repo}</Text> : null}
      </Text>
      <PromptDisclosure prompt={proposal.prompt} />
    </View>
  );
}

const STATUS_LABELS = {
  pending: "waiting",
  allowed: "allowed",
  denied: "denied",
  answered: "answered",
  expired: "timed out",
} as const;

export const DecisionCard = memo(function DecisionCard({
  decision,
  companionName,
  canAct,
  skills,
  plugins,
  models,
  onDecide,
}: {
  decision: CompanionDecision;
  companionName: string;
  canAct: boolean;
  skills: readonly NamedResource[];
  plugins: readonly NamedResource[];
  models: readonly NamedResource[];
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

  const heading = decision.kind === "question"
    ? "Question"
    : decision.kind === "config"
      ? `${companionName} proposes these changes`
      : decision.kind === "routine"
        ? `${companionName} proposes this routine`
        : decision.kind === "trigger"
          ? `${companionName} proposes this trigger`
          : "Permission requested";

  return (
    <View className="mx-4 my-2 gap-3 rounded-md border border-warn-line bg-warn-tint p-4">
      <View className="flex-row items-center justify-between gap-3">
        <Text className="min-w-0 flex-1 text-sm font-semibold text-foreground">{heading}</Text>
        <Badge tone={pending ? "warn" : "neutral"}>{STATUS_LABELS[decision.status]}</Badge>
      </View>

      {decision.proposal?.kind === "config" ? (
        <ConfigChanges proposal={decision.proposal} skills={skills} plugins={plugins} models={models} />
      ) : decision.proposal?.kind === "routine" ? (
        <RoutineDetails proposal={decision.proposal} />
      ) : decision.proposal?.kind === "trigger" ? (
        <TriggerDetails proposal={decision.proposal} />
      ) : (
        <>
          <Text className="text-base leading-6 text-foreground">{decision.title}</Text>
          {decision.detail ? (
            <Text selectable className="font-mono text-xs leading-5 text-muted">{decision.detail}</Text>
          ) : null}
        </>
      )}

      {decision.kind === "question" && decision.answer ? (
        <Text selectable className="text-sm text-foreground">{decision.answer}</Text>
      ) : null}
      {decision.kind === "trigger" && decision.status === "allowed" && canAct ? (
        <Text className="text-xs text-muted">Copy the webhook URL from the Triggers panel on the web.</Text>
      ) : null}

      {pending && canAct && decision.kind === "question" ? (
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
          <Button loading={busy} onPress={() => void act({ action: "allow" })}>
            {proposal ? "Approve" : "Allow"}
          </Button>
        </View>
      ) : null}
      {pending && !canAct ? (
        <Text className="text-xs text-muted">Waiting for an Owner or Editor</Text>
      ) : null}
      {!pending && decision.decided_by_name ? (
        <Text className="text-xs text-muted">
          {STATUS_LABELS[decision.status]} by {decision.decided_by_name}
        </Text>
      ) : null}
      {decision.status === "expired" && !decision.decided_by_name ? (
        <Text className="text-xs text-muted">Timed out, denied</Text>
      ) : null}
      {error ? <Text accessibilityRole="alert" className="text-sm text-danger">{error}</Text> : null}
    </View>
  );
});
