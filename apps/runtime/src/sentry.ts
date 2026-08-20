import { describeThrownError, expurgateRuntimeMessage } from "@companion/companion-runtime";
import * as Sentry from "@sentry/node";
import { sanitizeSentryEvent } from "./sentrySanitize";

const SERVICE = "runtime";

function sanitizeRuntimeEvent<T extends object>(event: T): T {
  sanitizeSentryEvent(event);
  const exception = (event as T & { exception?: { values?: Array<{ value?: string }> } }).exception;
  if (exception && typeof exception === "object") {
    const values = (exception as { values?: Array<{ value?: string }> }).values;
    if (values) {
      for (const value of values) {
        if (value.value) value.value = expurgateRuntimeMessage(value.value);
      }
    }
  }
  return event;
}

const dsn = process.env.SENTRY_DSN;
if (dsn) {
  Sentry.init({
    dsn,
    sendDefaultPii: false,
    environment: process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || "development",
    tracesSampleRate: 0,
    initialScope: { tags: { service: SERVICE } },
    beforeSend: sanitizeRuntimeEvent,
  });
}

export function captureRuntimeException(error: unknown): void {
  const described = describeThrownError(error);
  const sanitized = new Error(described.message);
  sanitized.name = typeof described.name === "string" ? described.name : "Error";
  if (typeof described.stack === "string") sanitized.stack = described.stack;
  Sentry.captureException(sanitized);
}

export { Sentry };
