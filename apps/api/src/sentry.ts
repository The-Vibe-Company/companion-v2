import * as Sentry from "@sentry/node";
import { sanitizeSentryEvent } from "./sentrySanitize";

const SERVICE = "api";
type CapturedException = Parameters<typeof Sentry.captureException>[0];

export interface ServerErrorContext {
  operation?: string;
  method?: string;
  route?: string;
  status?: number;
  level?: "warning" | "error" | "fatal";
  retryable?: boolean;
}

const dsn = process.env.SENTRY_DSN;
if (dsn) {
  Sentry.init({
    dsn,
    sendDefaultPii: false,
    environment: process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || "development",
    tracesSampleRate: process.env.NODE_ENV === "production" ? 0.1 : 1.0,
    release: process.env.SENTRY_RELEASE,
    attachStacktrace: true,
    initialScope: { tags: { service: SERVICE } },
    beforeSend: sanitizeSentryEvent,
    beforeSendTransaction: sanitizeSentryEvent,
  });
}

export function captureServerError(error: CapturedException, context: ServerErrorContext = {}): void {
  Sentry.withScope((scope) => {
    scope.setLevel(context.level ?? "error");
    if (context.operation) scope.setTag("operation", context.operation);
    if (context.method) scope.setTag("http.method", context.method);
    if (context.route) scope.setTag("http.route", context.route);
    if (context.status !== undefined) scope.setTag("http.status_code", String(context.status));
    if (context.retryable !== undefined) scope.setTag("error.retryable", String(context.retryable));
    if (context.operation) scope.setFingerprint([SERVICE, context.operation, "{{ default }}"]);
    Sentry.captureException(error);
  });
}

export { Sentry };
