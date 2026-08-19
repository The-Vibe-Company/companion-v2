const SENSITIVE_QUERY = /(?:^|[?&])(?:code|token|state|sig|access_token)=/i;

export function stripSensitiveUrl(url: string | undefined): string | undefined {
  if (!url) return url;
  return url.split("?")[0]?.split("#")[0];
}

function looksLikeUrl(value: string): boolean {
  return /^(?:https?:)?\/\//i.test(value) || (value.startsWith("/") && value.includes("?"));
}

function redactString(value: string): string {
  if (looksLikeUrl(value)) return stripSensitiveUrl(value) ?? value;
  if (SENSITIVE_QUERY.test(value)) return "[query removed]";
  return value;
}

function redactDeep(value: unknown, depth = 0): unknown {
  if (depth > 8 || value == null) return value;
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      value[index] = redactDeep(value[index], depth + 1);
    }
    return value;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const [key, nested] of Object.entries(record)) {
      record[key] = redactDeep(nested, depth + 1);
    }
  }
  return value;
}

export function sanitizeSentryEvent<T extends object>(event: T): T {
  const record = event as T & Record<string, unknown>;
  const request = record.request;
  if (request && typeof request === "object") {
    const record = request as {
      url?: string;
      query_string?: unknown;
      cookies?: unknown;
      headers?: unknown;
      data?: unknown;
    };
    record.url = stripSensitiveUrl(record.url);
    delete record.query_string;
    delete record.cookies;
    delete record.headers;
    delete record.data;
  }
  redactDeep(record.breadcrumbs);
  redactDeep(record.spans);
  redactDeep(record.extra);
  redactDeep(record.contexts);
  return event;
}

export function sentryTracesSampleRate(): number {
  return process.env.NODE_ENV === "production" ? 0.1 : 1.0;
}
