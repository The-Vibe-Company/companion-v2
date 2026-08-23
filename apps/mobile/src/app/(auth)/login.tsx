import { Ionicons } from "@expo/vector-icons";
import { useState } from "react";
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, View } from "react-native";

import { Button, Field } from "@/components/ui";
import { CompanionIcon, defaultCompanionIcon } from "@/components/companions/companion-icon";
import { useSession } from "@/lib/session";

export default function LoginScreen() {
  const { signIn } = useSession();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!email.trim() || !password || busy) return;
    setBusy(true);
    setError(null);
    const result = await signIn(email, password);
    if (result.error) {
      setError(result.error);
      if (result.reason === "credentials") {
        setPassword("");
        setVisible(false);
      }
    }
    setBusy(false);
  };

  return (
    <KeyboardAvoidingView className="flex-1 bg-background" behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ flexGrow: 1, justifyContent: "center", gap: 32, paddingHorizontal: 24, paddingVertical: 40 }}
      >
        <View className="items-center gap-4">
          <CompanionIcon icon={defaultCompanionIcon} size={74} />
          <View className="items-center gap-2">
            <Text className="text-2xl font-semibold text-foreground">Companion</Text>
            <Text className="text-center text-sm leading-5 text-muted">Sign in to continue your workspace conversations.</Text>
          </View>
        </View>

        <View className="gap-4 rounded-md border border-border bg-surface p-5">
          <Field
            label="Email"
            value={email}
            onChangeText={setEmail}
            placeholder="you@company.com"
            autoCapitalize="none"
            autoComplete="email"
            keyboardType="email-address"
            required
          />
          <Field
            label="Password"
            value={password}
            onChangeText={setPassword}
            placeholder="Your password"
            autoCapitalize="none"
            autoComplete="current-password"
            secureTextEntry={!visible}
            required
            error={error}
            suffix={(
              <Pressable
                onPress={() => setVisible((value) => !value)}
                accessibilityRole="button"
                accessibilityLabel={visible ? "Hide password" : "Show password"}
                hitSlop={12}
              >
                <Ionicons name={visible ? "eye-off-outline" : "eye-outline"} size={19} className="text-muted" />
              </Pressable>
            )}
          />
          <Button loading={busy} disabled={!email.trim() || !password} onPress={() => void submit()}>
            Sign in
          </Button>
        </View>

        <Text className="text-center text-xs leading-5 text-muted">
          Need an account? Sign up in the Companion web app, then return here.
        </Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
