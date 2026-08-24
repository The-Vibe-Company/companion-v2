import { Ionicons } from "@expo/vector-icons";
import { useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, Text, View } from "react-native";
import { useRouter } from "expo-router";

import { Button, Field, ScreenHeader } from "@/components/ui";
import { useSession } from "@/lib/session";
import { profileInitials } from "@/lib/session-state";

export default function ProfileScreen() {
  const router = useRouter();
  const { session, signOut, updateProfile } = useSession();
  const currentName = session?.user.name?.trim() || session?.user.email.split("@")[0] || "You";
  const [draftName, setDraftName] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const name = draftName ?? currentName;
  const dirty = draftName !== null;
  const normalizedName = name.trim();

  const save = async () => {
    if (!dirty || !normalizedName || normalizedName === currentName || saving) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await updateProfile(normalizedName);
      setDraftName(null);
      setSaved(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Your profile could not be updated.");
    } finally {
      setSaving(false);
    }
  };

  const logout = async () => {
    if (signingOut) return;
    setSigningOut(true);
    await signOut();
  };

  return (
    <KeyboardAvoidingView
      className="flex-1 bg-background"
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <View collapsable={false} className="flex-1 pt-safe">
        <ScreenHeader title="Account" onBack={() => router.back()} />
        <ScrollView
          className="flex-1"
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ gap: 28, paddingHorizontal: 20, paddingTop: 24, paddingBottom: 40 }}
        >
          <View className="flex-row items-center gap-4">
            <View className="h-16 w-16 items-center justify-center rounded-full border border-border bg-surface-raised">
              <Text className="text-xl font-semibold text-foreground">{profileInitials(currentName)}</Text>
            </View>
            <View className="min-w-0 flex-1 gap-1">
              <Text numberOfLines={1} className="text-lg font-semibold text-foreground">{currentName}</Text>
              <Text numberOfLines={1} className="text-sm text-muted">{session?.user.email}</Text>
            </View>
          </View>

          <View className="gap-4">
            <View className="gap-1">
              <Text className="text-base font-semibold text-foreground">Profile</Text>
              <Text className="text-sm leading-5 text-muted">This is how you appear across your workspaces.</Text>
            </View>
            <Field
              label="Full name"
              value={name}
              onChangeText={(value) => {
                setDraftName(value);
                setError(null);
                setSaved(false);
              }}
              autoCapitalize="words"
              autoComplete="name"
              maxLength={120}
              returnKeyType="done"
              onSubmitEditing={() => void save()}
              required
              disabled={saving || signingOut}
              error={error}
            />
            {saved ? (
              <Text accessibilityLiveRegion="polite" className="text-sm text-ok">Profile updated.</Text>
            ) : null}
            <View className="flex-row justify-end">
              <Button
                loading={saving}
                disabled={!dirty || !normalizedName || normalizedName === currentName || signingOut}
                onPress={() => void save()}
              >
                Save changes
              </Button>
            </View>
          </View>

          <View className="gap-4 border-t border-separator pt-6">
            <View className="gap-1">
              <Text className="text-base font-semibold text-foreground">Session</Text>
              <Text className="text-sm leading-5 text-muted">Sign out of Companion on this device.</Text>
            </View>
            <View className="flex-row">
              <Button
                tone="danger"
                loading={signingOut}
                disabled={saving}
                onPress={() => void logout()}
                prefix={<Ionicons name="log-out-outline" size={18} className="text-danger-foreground" />}
              >
                Sign out
              </Button>
            </View>
          </View>
        </ScrollView>
      </View>
    </KeyboardAvoidingView>
  );
}
