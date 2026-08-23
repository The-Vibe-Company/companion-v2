import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, type AppStateStatus } from "react-native";

export function usePoll<T>({
  load,
  interval,
  enabled = true,
  onData,
}: {
  load: () => Promise<T>;
  interval: (value: T | null) => number;
  enabled?: boolean;
  onData?: (value: T) => void;
}) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const current = useRef<T | null>(null);
  const failures = useRef(0);
  const active = useRef(AppState.currentState === "active");

  const refresh = useCallback(() => {
    failures.current = 0;
    setRevision((value) => value + 1);
  }, []);

  useEffect(() => {
    const change = (state: AppStateStatus) => {
      const resumed = state === "active" && !active.current;
      active.current = state === "active";
      if (resumed) refresh();
    };
    const subscription = AppState.addEventListener("change", change);
    return () => subscription.remove();
  }, [refresh]);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const tick = async () => {
      if (!active.current) return;
      try {
        const value = await load();
        if (cancelled) return;
        failures.current = 0;
        current.current = value;
        setData(value);
        setError(null);
        onData?.(value);
      } catch (cause) {
        if (cancelled) return;
        failures.current += 1;
        setError(cause);
      } finally {
        if (!cancelled) {
          setLoading(false);
          const base = interval(current.current);
          const delay = Math.min(base * (2 ** Math.min(failures.current, 3)), 15_000);
          timer = setTimeout(tick, delay);
        }
      }
    };

    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [enabled, interval, load, onData, revision]);

  return { data, error, loading, refresh, setData };
}
