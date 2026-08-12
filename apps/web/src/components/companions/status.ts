import type { CompanionRuntimeState } from "@companion/contracts";

export type CompanionStatusTone = "ok" | "warn" | "danger" | "unknown";

/**
 * Control-plane runtime state as one operator word. The colour tone is always rendered next to this
 * label so status never depends on colour alone.
 */
export function companionStatus(
  state: CompanionRuntimeState,
): { label: string; tone: CompanionStatusTone } {
  switch (state) {
    case "running":
      return { label: "Online", tone: "ok" };
    case "provisioning":
      return { label: "Starting", tone: "warn" };
    case "stopping":
      return { label: "Stopping", tone: "warn" };
    case "error":
      return { label: "Error", tone: "danger" };
    default:
      return { label: "Asleep", tone: "unknown" };
  }
}

const RELATIVE_UNITS: ReadonlyArray<[Intl.RelativeTimeFormatUnit, number]> = [
  ["year", 365 * 24 * 3_600_000],
  ["month", 30 * 24 * 3_600_000],
  ["day", 24 * 3_600_000],
  ["hour", 3_600_000],
  ["minute", 60_000],
];

export function relativeTime(iso: string, now: number = Date.now()): string {
  const elapsed = new Date(iso).getTime() - now;
  if (!Number.isFinite(elapsed)) return iso;
  const format = new Intl.RelativeTimeFormat("en", { numeric: "auto", style: "narrow" });
  for (const [unit, size] of RELATIVE_UNITS) {
    if (Math.abs(elapsed) >= size) return format.format(Math.round(elapsed / size), unit);
  }
  return format.format(0, "minute");
}
