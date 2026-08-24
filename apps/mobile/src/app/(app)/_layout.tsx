import { Redirect, Stack } from "expo-router";

import { useSession } from "@/lib/session";

export default function AppLayout() {
  const { session } = useSession();
  if (!session) return <Redirect href="/(auth)/login" />;
  if (session.needsOnboarding) return <Redirect href="/(auth)/onboarding" />;
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="index" />
      <Stack.Screen name="chat/[id]" />
      <Stack.Screen name="create" options={{ presentation: "modal" }} />
      <Stack.Screen
        name="profile"
        options={{
          presentation: "formSheet",
          sheetAllowedDetents: [0.65, 1],
          sheetGrabberVisible: true,
        }}
      />
    </Stack>
  );
}
