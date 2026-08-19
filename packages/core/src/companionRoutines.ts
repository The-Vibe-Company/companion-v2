import { CronExpressionParser } from "cron-parser";
import {
  COMPANION_ROUTINE_CRON_MAX_CHARACTERS,
  COMPANION_ROUTINE_MIN_INTERVAL_MS,
  COMPANION_ROUTINE_TIMEZONE_MAX_CHARACTERS,
} from "@companion/contracts";

function parseCron(cron: string, timezone: string, currentDate?: Date) {
  return CronExpressionParser.parse(cron, {
    tz: timezone,
    currentDate,
  });
}

export function isIanaTimeZone(timezone: string): boolean {
  if (!timezone || timezone.length > COMPANION_ROUTINE_TIMEZONE_MAX_CHARACTERS) return false;
  try {
    Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

/**
 * Next fire strictly after `after`. DST behavior is whatever `cron-parser` computes for the
 * IANA zone; the deterministic message id prevents a duplicated turn if that instant is revisited.
 */
export function computeNextFireAt(cron: string, timezone: string, after: Date): Date {
  const expression = parseCron(cron, timezone, after);
  const next = expression.next().toDate();
  if (!(next instanceof Date) || Number.isNaN(next.getTime()) || next.getTime() <= after.getTime()) {
    throw new Error("routine cron did not produce a future fire");
  }
  return next;
}

export type RoutineScheduleValidation =
  | { ok: true; nextFireAt: Date }
  | { ok: false; code: "invalid_cron" | "invalid_timezone" | "interval_too_short" };

const SAMPLE_OCCURRENCES = 10;

export function validateRoutineSchedule(input: {
  cron: string;
  timezone: string;
  after?: Date;
}): RoutineScheduleValidation {
  const cron = input.cron.trim();
  const timezone = input.timezone.trim();
  if (!cron || cron.length > COMPANION_ROUTINE_CRON_MAX_CHARACTERS || /[\n\r]/.test(cron)) {
    return { ok: false, code: "invalid_cron" };
  }
  if (cron.trim().split(/\s+/).length !== 5) {
    return { ok: false, code: "invalid_cron" };
  }
  if (!isIanaTimeZone(timezone)) return { ok: false, code: "invalid_timezone" };
  const after = input.after ?? new Date();
  const occurrences: Date[] = [];
  let cursor = after;
  try {
    for (let i = 0; i < SAMPLE_OCCURRENCES; i += 1) {
      const next = computeNextFireAt(cron, timezone, cursor);
      occurrences.push(next);
      cursor = next;
    }
  } catch {
    return { ok: false, code: "invalid_cron" };
  }
  const nextFireAt = occurrences[0]!;
  for (let i = 1; i < occurrences.length; i += 1) {
    if (occurrences[i]!.getTime() - occurrences[i - 1]!.getTime() < COMPANION_ROUTINE_MIN_INTERVAL_MS) {
      return { ok: false, code: "interval_too_short" };
    }
  }
  return { ok: true, nextFireAt };
}
