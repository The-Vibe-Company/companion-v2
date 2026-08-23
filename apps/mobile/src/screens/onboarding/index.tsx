import { Ionicons } from "@expo/vector-icons";
import { useCallback, useEffect, useState } from "react";
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, View } from "react-native";

import { CompanionIcon, defaultCompanionIcon } from "@/components/companions/companion-icon";
import { Button, Field } from "@/components/ui";
import { createOnboardingOrg, getOnboardingContext, joinOnboardingOrg } from "@/lib/api";
import { useSession } from "@/lib/session";
import type { OnboardingContext } from "@/lib/types";

type Mode = "choose" | "create";

export function OnboardingScreen() {
  const { finishOnboarding, session, signOut } = useSession();
  const [context, setContext] = useState<OnboardingContext | null>(null);
  const [mode, setMode] = useState<Mode>("create");
  const [selectedOrgId, setSelectedOrgId] = useState<string | null>(null);
  const [workspaceName, setWorkspaceName] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const applyContext = useCallback((next: OnboardingContext) => {
    const first = next.matched_orgs[0] ?? null;
    setContext(next);
    setSelectedOrgId(first?.id ?? null);
    setMode(first ? "choose" : "create");
    setWorkspaceName((current) => {
      if (current) return current;
      const owner = session?.user.name?.trim() || session?.user.email.split("@")[0] || "My";
      return `${owner}'s workspace`;
    });
  }, [session?.user.email, session?.user.name]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      applyContext(await getOnboardingContext());
    } catch {
      setError("The onboarding details could not be loaded. Check your connection and try again.");
    } finally {
      setLoading(false);
    }
  }, [applyContext]);

  useEffect(() => {
    let cancelled = false;
    void getOnboardingContext()
      .then((next) => {
        if (!cancelled) applyContext(next);
      })
      .catch(() => {
        if (!cancelled) setError("The onboarding details could not be loaded. Check your connection and try again.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [applyContext]);

  const join = async () => {
    if (!selectedOrgId || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await joinOnboardingOrg(selectedOrgId);
      await finishOnboarding(result.orgId);
    } catch {
      setError("This workspace could not be joined. Refresh the available workspaces and try again.");
      setBusy(false);
    }
  };

  const create = async () => {
    const name = workspaceName.trim();
    if (!name || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await createOnboardingOrg(name);
      await finishOnboarding(result.orgId);
    } catch {
      setError("The workspace could not be created. Check the name and try again.");
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView className="flex-1 bg-background" behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ flexGrow: 1, justifyContent: "center", gap: 24, paddingHorizontal: 24, paddingVertical: 40 }}
      >
        <View className="items-center gap-4">
          <CompanionIcon icon={defaultCompanionIcon} size={64} />
          <View className="items-center gap-2">
            <Text className="text-2xl font-semibold text-foreground">Set up your workspace</Text>
            <Text className="text-center text-sm leading-5 text-muted">
              Join your organization or create a workspace for your Companions.
            </Text>
          </View>
        </View>

        <View className="gap-4 rounded-md border border-border bg-surface p-5">
          {loading ? (
            <View className="items-center gap-3 py-6">
              <Text className="text-sm text-muted">Loading workspace options…</Text>
            </View>
          ) : !context ? (
            <View className="gap-3 rounded-md border border-danger-line bg-danger-tint p-3">
              <Text accessibilityRole="alert" className="text-sm leading-5 text-foreground">
                {error ?? "Workspace options could not be loaded."}
              </Text>
              <Button tone="secondary" onPress={() => void load()}>Try again</Button>
            </View>
          ) : mode === "choose" && context?.matched_orgs.length ? (
            <>
              <View className="gap-1">
                <Text className="text-base font-semibold text-foreground">Available workspaces</Text>
                <Text className="text-sm leading-5 text-muted">Your verified email can join one of these organizations.</Text>
              </View>
              <View className="gap-2">
                {context.matched_orgs.map((org) => {
                  const selected = org.id === selectedOrgId;
                  return (
                    <Pressable
                      key={org.id}
                      accessibilityRole="radio"
                      accessibilityState={{ checked: selected }}
                      onPress={() => setSelectedOrgId(org.id)}
                      className={`min-h-16 flex-row items-center gap-3 rounded-md border p-3 ${selected ? "border-accent-line bg-accent-tint" : "border-border bg-surface"}`}
                    >
                      <Ionicons
                        name={selected ? "radio-button-on" : "radio-button-off"}
                        size={20}
                        className={selected ? "text-foreground" : "text-muted"}
                      />
                      <View className="min-w-0 flex-1">
                        <Text className="font-semibold text-foreground">{org.name}</Text>
                        <Text className="text-xs text-muted">
                          {org.domain} · {org.member_count} {org.member_count === 1 ? "member" : "members"}
                        </Text>
                      </View>
                    </Pressable>
                  );
                })}
              </View>
              <Button loading={busy} disabled={!selectedOrgId} onPress={() => void join()}>Join workspace</Button>
              <Button tone="ghost" disabled={busy} onPress={() => { setError(null); setMode("create"); }}>
                Create a different workspace
              </Button>
            </>
          ) : (
            <>
              <View className="gap-1">
                <Text className="text-base font-semibold text-foreground">Create a workspace</Text>
                <Text className="text-sm leading-5 text-muted">
                  Invitations, branding, and domain access can be configured later in the web app.
                </Text>
              </View>
              <Field
                label="Workspace name"
                value={workspaceName}
                onChangeText={setWorkspaceName}
                autoCapitalize="words"
                maxLength={120}
                required
                disabled={busy}
              />
              <Button loading={busy} disabled={!workspaceName.trim()} onPress={() => void create()}>
                Create workspace
              </Button>
              {context?.matched_orgs.length ? (
                <Button tone="ghost" disabled={busy} onPress={() => { setError(null); setMode("choose"); }}>
                  Back to available workspaces
                </Button>
              ) : null}
            </>
          )}

          {error && context ? (
            <Text accessibilityRole="alert" className="rounded-md border border-danger-line bg-danger-tint p-3 text-sm leading-5 text-foreground">
              {error}
            </Text>
          ) : null}
        </View>

        <Button tone="ghost" disabled={busy} onPress={() => void signOut()}>Sign out</Button>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
