import "../global.css";

import { useEffect } from "react";
import { Text, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { HeroUINativeProvider } from "heroui-native";
import { Stack, useRouter, useSegments } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { SafeAreaListener, SafeAreaProvider } from "react-native-safe-area-context";
import { Uniwind } from "uniwind";

import { Button } from "@/components/ui";
import { SessionProvider, useSession } from "@/lib/session";
import { sessionRedirect, type SessionLocation } from "@/lib/session-state";

void SplashScreen.preventAutoHideAsync();

function SessionRouter() {
  const { session, bootstrapError, retryBootstrap } = useSession();
  const segments = useSegments();
  const router = useRouter();

  useEffect(() => {
    if (session === undefined && !bootstrapError) return;
    void SplashScreen.hideAsync();
    if (bootstrapError) return;
    if (session === undefined) return;
    const inApp = segments[0] === "(app)";
    const inOnboarding = segments.join("/") === "(auth)/onboarding";
    const location: SessionLocation = inApp
      ? "app"
      : inOnboarding
        ? "onboarding"
        : segments.join("/") === "(auth)/login"
          ? "login"
          : "other";
    const redirect = sessionRedirect(session, location);
    if (redirect) router.replace(redirect);
  }, [bootstrapError, router, segments, session]);

  if (bootstrapError) {
    return (
      <View className="flex-1 items-center justify-center gap-4 bg-background px-8">
        <Text accessibilityRole="alert" className="text-center text-sm leading-5 text-muted">{bootstrapError}</Text>
        <Button onPress={retryBootstrap}>Try again</Button>
      </View>
    );
  }
  if (session === undefined) return <View className="flex-1 bg-background" />;
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="(auth)" />
      <Stack.Screen name="(app)" />
    </Stack>
  );
}

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <SafeAreaListener onChange={({ insets }) => Uniwind.updateInsets(insets)}>
          <HeroUINativeProvider>
            <SessionProvider>
              <View className="w-full flex-1 self-center bg-background md:max-w-[540px]">
                <SessionRouter />
              </View>
            </SessionProvider>
          </HeroUINativeProvider>
        </SafeAreaListener>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
