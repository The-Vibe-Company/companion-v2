/** Browser-supported IANA zones, with UTC and the active values retained across implementation gaps. */
export function browserTimeZones(...active: Array<string | null | undefined>): string[] {
  const supported = Intl.supportedValuesOf?.("timeZone") ?? [];
  return [...new Set(["UTC", ...active.filter((value): value is string => !!value), ...supported])]
    .sort((left, right) => left.localeCompare(right));
}

export function detectedBrowserTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

export function formatMemberDateTime(value: string | Date, timezone: string): string {
  return new Intl.DateTimeFormat(undefined, {
    timeZone: timezone,
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(value));
}
