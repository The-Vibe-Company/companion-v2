import { Redirect, Stack } from "expo-router";

import { useSession } from "@/lib/session";

export default function AppLayout() {
  const { session } = useSession();
  if (!session) return <Redirect href="/(auth)/login" />;
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="index" />
      <Stack.Screen name="chat/[id]" />
      <Stack.Screen name="create" options={{ presentation: "modal" }} />
    </Stack>
  );
}
