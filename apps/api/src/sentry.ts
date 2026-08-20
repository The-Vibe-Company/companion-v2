import * as Sentry from "@sentry/node";
import { sanitizeSentryEvent } from "./sentrySanitize";

const SERVICE = "api";

const dsn = process.env.SENTRY_DSN;
if (dsn) {
  Sentry.init({
    dsn,
    sendDefaultPii: false,
    environment: process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || "development",
    tracesSampleRate: process.env.NODE_ENV === "production" ? 0.1 : 1.0,
    initialScope: { tags: { service: SERVICE } },
    beforeSend: sanitizeSentryEvent,
    beforeSendTransaction: sanitizeSentryEvent,
  });
}

export function captureServerError(error: unknown): void {
  Sentry.captureException(error);
}

export { Sentry };
