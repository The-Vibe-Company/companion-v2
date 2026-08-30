import * as Sentry from "@sentry/nextjs";
import { sanitizeSentryEvent, sentryTracesSampleRate } from "./sentry.shared";

const SENTRY_DSN = process.env.NEXT_PUBLIC_SENTRY_DSN || process.env.SENTRY_DSN;

if (SENTRY_DSN) {
  Sentry.init({
    dsn: SENTRY_DSN,
    release: process.env.SENTRY_RELEASE ?? process.env.NEXT_PUBLIC_SENTRY_RELEASE,
    attachStacktrace: true,
    sendDefaultPii: false,
    tracesSampleRate: sentryTracesSampleRate(),
    environment:
      process.env.SENTRY_ENVIRONMENT || process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT || process.env.NODE_ENV || "development",
    initialScope: { tags: { service: "web" } },
    beforeSend: sanitizeSentryEvent,
    beforeSendTransaction: sanitizeSentryEvent,
  });
}
