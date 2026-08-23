import { Ionicons } from "@expo/vector-icons";
import { useState } from "react";
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, View } from "react-native";

import { Button, Field, GoogleMark } from "@/components/ui";
import { CompanionIcon, defaultCompanionIcon } from "@/components/companions/companion-icon";
import { useSession } from "@/lib/session";

export default function LoginScreen() {
  const { signIn, signInWithGoogle } = useSession();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [visible, setVisible] = useState(false);
  const [emailBusy, setEmailBusy] = useState(false);
  const [googleBusy, setGoogleBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!email.trim() || !password || emailBusy || googleBusy) return;
    setEmailBusy(true);
    setError(null);
    const result = await signIn(email, password);
    if (result.error) {
      setError(result.error);
      if (result.reason === "credentials") {
        setPassword("");
        setVisible(false);
      }
    }
    setEmailBusy(false);
  };

  const submitGoogle = async () => {
    if (emailBusy || googleBusy) return;
    setGoogleBusy(true);
    setError(null);
    const result = await signInWithGoogle();
    if (result.error) setError(result.error);
    setGoogleBusy(false);
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
          <Button
            tone="secondary"
            loading={googleBusy}
            disabled={emailBusy}
            prefix={<GoogleMark />}
            onPress={() => void submitGoogle()}
          >
            Continue with Google
          </Button>
          <View className="flex-row items-center gap-3" accessibilityElementsHidden>
            <View className="h-px flex-1 bg-separator" />
            <Text className="text-xs text-muted">or</Text>
            <View className="h-px flex-1 bg-separator" />
          </View>
          <Field
            label="Email"
            value={email}
            onChangeText={setEmail}
            placeholder="you@company.com"
            autoCapitalize="none"
            autoComplete="email"
            keyboardType="email-address"
            required
            disabled={googleBusy}
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
            disabled={googleBusy}
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
          {error ? (
            <Text accessibilityRole="alert" className="text-sm leading-5 text-danger">{error}</Text>
          ) : null}
          <Button
            loading={emailBusy}
            disabled={!email.trim() || !password || googleBusy}
            onPress={() => void submit()}
          >
            Sign in
          </Button>
        </View>

        <Text className="text-center text-xs leading-5 text-muted">
          New here? Continue with Google, or create an email account in the Companion web app.
        </Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
