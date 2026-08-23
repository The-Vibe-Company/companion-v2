import { useEffect, useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, Text, View } from "react-native";
import { useRouter } from "expo-router";

import { IconPicker, randomIcon } from "@/components/companions/icon-picker";
import { Button, Field, ScreenHeader } from "@/components/ui";
import { createCompanion, getProviders } from "@/lib/api";
import type { CreateCompanionInput, ProvidersResponse } from "@/lib/types";
import { ApiError } from "@/lib/types";

export default function CreateCompanionScreen() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [persona, setPersona] = useState("");
  const [icon, setIcon] = useState(randomIcon);
  const [providers, setProviders] = useState<ProvidersResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getProviders()
      .then((value) => {
        if (!cancelled) setProviders(value);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  // The create request omits provider fields, so the API uses only this organization default.
  const providerId = providers?.default_provider_id ?? null;
  const provider = providers?.catalog.find((item) => item.id === providerId) ?? null;
  const model = provider?.models.find((item) => item.default) ?? provider?.models[0] ?? null;
  const providerSummary = !providers
    ? "Uses the workspace default"
    : provider && model
      ? `Uses ${provider.name} · ${model.id}`
      : providers.default_provider_id
        ? "Uses the workspace default"
        : "No workspace default is configured";

  const submit = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const input: CreateCompanionInput = {
        name: name.trim(),
        icon,
      };
      if (persona.trim()) input.persona = persona.trim();
      const companion = await createCompanion(input);
      router.replace({ pathname: "/(app)/chat/[id]", params: { id: companion.id } });
    } catch (cause) {
      if (cause instanceof ApiError && cause.code === "provider_not_configured") {
        setError("No model provider is configured for this workspace. Connect one on the web, then try again.");
      } else {
        setError(cause instanceof Error ? cause.message : "The Companion could not be created.");
      }
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView className="flex-1 bg-background pt-safe" behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <ScreenHeader title="New companion" onBack={() => router.back()} />
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ gap: 24, paddingHorizontal: 20, paddingTop: 24, paddingBottom: 40 }}
      >
        <IconPicker value={icon} onChange={setIcon} />
        <View className="gap-4">
          <Field
            label="Name"
            value={name}
            onChangeText={setName}
            placeholder="Luna"
            maxLength={120}
            required
          />
          <Field
            label="What it does"
            description="Optional, up to 280 characters."
            value={persona}
            onChangeText={setPersona}
            placeholder="Helps triage incidents and write clear updates"
            maxLength={280}
            multiline
            className="min-h-24 py-3"
          />
        </View>
        <View className="gap-1 border-y border-separator py-3">
          <Text className="text-xs text-muted">Model provider</Text>
          <Text className="font-mono text-sm text-foreground">
            {providerSummary}
          </Text>
        </View>
        {error ? <Text accessibilityRole="alert" className="rounded-md border border-danger-line bg-danger-tint p-3 text-sm leading-5 text-danger">{error}</Text> : null}
        <View className="flex-row justify-end gap-2">
          <Button tone="secondary" disabled={busy} onPress={() => router.back()}>Cancel</Button>
          <Button loading={busy} disabled={!name.trim()} onPress={() => void submit()}>Create companion</Button>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
