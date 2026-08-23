import { Ionicons } from "@expo/vector-icons";
import { useCallback, useState } from "react";
import { FlatList, Pressable, RefreshControl, Text, View } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";

import { CompanionRow } from "@/components/companions/companion-row";
import { Button, EmptyState } from "@/components/ui";
import { listCompanions } from "@/lib/api";
import { useSession } from "@/lib/session";
import type { Companion } from "@/lib/types";
import { ApiError } from "@/lib/types";
import { usePoll } from "@/lib/use-poll";

export default function CompanionListScreen() {
  const router = useRouter();
  const { session, signOut } = useSession();
  const [refreshing, setRefreshing] = useState(false);
  const load = useCallback(() => listCompanions(), []);
  const interval = useCallback((companions: Companion[] | null) =>
    companions?.some((companion) => companion.runtime.replying) ? 8_000 : 45_000, []);
  const poll = usePoll({ load, interval });
  const { refresh: refreshPoll } = poll;
  const gateUnavailable = poll.error instanceof ApiError
    && (poll.error.status === 403 || poll.error.status === 404);

  useFocusEffect(useCallback(() => {
    // Returning from creation must not wait for the list's long idle polling interval.
    refreshPoll();
  }, [refreshPoll]));

  const refresh = () => {
    setRefreshing(true);
    poll.refresh();
    setTimeout(() => setRefreshing(false), 600);
  };

  return (
    <View className="flex-1 bg-background pt-safe">
      <View className="min-h-16 flex-row items-center gap-3 border-b border-border bg-surface px-4 py-2">
        <View className="min-w-0 flex-1">
          <Text className="text-xl font-semibold text-foreground">Companions</Text>
          <Text numberOfLines={1} className="text-xs text-muted">{session?.user.email}</Text>
        </View>
        <Pressable
          onPress={() => void signOut()}
          accessibilityRole="button"
          accessibilityLabel="Sign out"
          hitSlop={10}
          className="h-11 w-11 items-center justify-center rounded-md active:bg-surface-raised"
        >
          <Ionicons name="log-out-outline" size={21} className="text-muted" />
        </Pressable>
        <Button size="sm" onPress={() => router.push("/(app)/create")}>New companion</Button>
      </View>

      {gateUnavailable ? (
        <EmptyState
          title="Companions are not enabled"
          description="This workspace or account does not currently have access to hosted Companions."
        />
      ) : poll.error && !poll.data ? (
        <EmptyState
          title="Could not load Companions"
          description="The server did not return the workspace roster."
          action="Try again"
          onAction={poll.refresh}
        />
      ) : poll.loading && !poll.data ? (
        <View className="gap-3 p-4">
          {[0, 1, 2].map((index) => <View key={index} className="h-16 rounded-md bg-surface-raised" />)}
        </View>
      ) : (
        <FlatList
          data={(poll.data ?? []).filter((companion) => !companion.hidden)}
          keyExtractor={(companion) => companion.id}
          renderItem={({ item }) => (
            <CompanionRow companion={item} onPress={() => router.push({ pathname: "/(app)/chat/[id]", params: { id: item.id } })} />
          )}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}
          contentContainerStyle={(poll.data?.length ?? 0) === 0 ? { flexGrow: 1 } : undefined}
          ListEmptyComponent={(
            <EmptyState
              title="No Companions yet"
              description="Create a named teammate, then send the first message to start its durable thread."
              action="Create companion"
              onAction={() => router.push("/(app)/create")}
            />
          )}
        />
      )}
    </View>
  );
}
