/** Coarse relative time. Computed server-side and passed down to avoid hydration drift. */
export function relativeTime(iso: string | null): string {
  if (!iso) return "—";
  const then = new Date(iso).getTime();
  const now = Date.now();
  const s = Math.max(0, Math.round((now - then) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d}d ago`;
  const w = Math.round(d / 7);
  if (w < 5) return `${w}w ago`;
  const mo = Math.round(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.round(d / 365)}y ago`;
}

export function formatBytes(n: number | null): string {
  if (n == null) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Stable YYYY-MM-DD (no Date.now), safe across SSR/hydration. */
export function formatDate(iso: string): string {
  return new Date(iso).toISOString().slice(0, 10);
}

export function clockTime(date = new Date()): string {
  return date.toISOString().slice(11, 19);
}

/** Compact duration for provision steps / tool runs: 0.6s, 1.2s, 12s, 60s. */
export function formatDurationSeconds(ms: number | null): string {
  if (ms == null) return "";
  const s = ms / 1000;
  if (s < 10) return `${(Math.round(s * 10) / 10).toFixed(1)}s`;
  return `${Math.round(s)}s`;
}

/** "Mar 12, 2026" — pinned to UTC so SSR and client render identical text. */
export function formatHumanDateUTC(iso: string | null): string {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(iso));
}
