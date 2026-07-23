import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { RUN_ARTIFACT_PREVIEW_TTL_MS } from "@companion/contracts";

export const RUN_HTML_PREVIEW_TTL_MS = RUN_ARTIFACT_PREVIEW_TTL_MS;
export const RUN_HTML_PREVIEW_CLOCK_SKEW_MS = 60 * 1_000;
export const RUN_HTML_PREVIEW_MAX_REQUESTS = 512;
export const RUN_HTML_PREVIEW_MAX_BYTES = 512 * 1024 * 1024;
export const RUN_HTML_PREVIEW_MAX_CONCURRENT = 8;
const RUN_HTML_PREVIEW_MAX_ACTIVE_TICKETS = 10_000;

export type RunHtmlPreviewTicket = {
  version: 1;
  orgId: string;
  runId: string;
  userId: string;
  expiresAt: number;
  nonce: string;
};

export type RunHtmlPreviewReservation = {
  chargeBytes: (bytes: number) => void;
  release: () => void;
};

/**
 * Bound the work a capability can trigger on one API replica. The ticket lifetime already bounds
 * the entry lifetime; the request, byte and concurrency ceilings additionally prevent copied
 * capabilities from driving unlimited database, object-storage or connection load.
 */
export function createRunHtmlPreviewLimiter(options: {
  maxRequests?: number;
  maxBytes?: number;
  maxConcurrent?: number;
  maxActiveTickets?: number;
} = {}): {
  begin: (input: { ticket: string; expiresAt: number; now?: number }) => RunHtmlPreviewReservation;
} {
  const maxRequests = options.maxRequests ?? RUN_HTML_PREVIEW_MAX_REQUESTS;
  const maxBytes = options.maxBytes ?? RUN_HTML_PREVIEW_MAX_BYTES;
  const maxConcurrent = options.maxConcurrent ?? RUN_HTML_PREVIEW_MAX_CONCURRENT;
  const maxActiveTickets = options.maxActiveTickets ?? RUN_HTML_PREVIEW_MAX_ACTIVE_TICKETS;
  const usage = new Map<string, { expiresAt: number; requests: number; bytes: number; concurrent: number }>();

  return {
    begin(input) {
      const now = input.now ?? Date.now();
      for (const [key, value] of usage) {
        if (value.expiresAt <= now && value.concurrent === 0) usage.delete(key);
      }
      const key = createHash("sha256").update(input.ticket).digest("base64url");
      let current = usage.get(key);
      if (!current) {
        if (usage.size >= maxActiveTickets) throw new Error("preview capacity exceeded");
        current = { expiresAt: input.expiresAt, requests: 0, bytes: 0, concurrent: 0 };
        usage.set(key, current);
      }
      if (
        current.expiresAt !== input.expiresAt
        || current.requests >= maxRequests
        || current.concurrent >= maxConcurrent
      ) throw new Error("preview budget exceeded");
      current.requests += 1;
      current.concurrent += 1;
      let active = true;
      return {
        chargeBytes(bytes) {
          if (!active || !Number.isSafeInteger(bytes) || bytes < 0 || current.bytes + bytes > maxBytes) {
            throw new Error("preview budget exceeded");
          }
          current.bytes += bytes;
        },
        release() {
          if (!active) return;
          active = false;
          current.concurrent = Math.max(0, current.concurrent - 1);
        },
      };
    },
  };
}

function signature(encoded: string, secret: string): Buffer {
  return createHmac("sha256", secret)
    .update("companion-run-html-preview:v1\0")
    .update(encoded)
    .digest();
}

export function issueRunHtmlPreviewTicket(input: {
  orgId: string;
  runId: string;
  userId: string;
  secret: string;
  now?: number;
}): { ticket: string; expiresAt: number } {
  const expiresAt = (input.now ?? Date.now()) + RUN_HTML_PREVIEW_TTL_MS;
  const payload: RunHtmlPreviewTicket = {
    version: 1,
    orgId: input.orgId,
    runId: input.runId,
    userId: input.userId,
    expiresAt,
    nonce: randomBytes(16).toString("base64url"),
  };
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return { ticket: `${encoded}.${signature(encoded, input.secret).toString("base64url")}`, expiresAt };
}

export function verifyRunHtmlPreviewTicket(input: {
  ticket: string;
  secret: string;
  now?: number;
}): RunHtmlPreviewTicket {
  const [encoded, rawSignature, extra] = input.ticket.split(".");
  if (!encoded || !rawSignature || extra !== undefined) throw new Error("invalid preview ticket");
  const expected = signature(encoded, input.secret);
  const actual = Buffer.from(rawSignature, "base64url");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new Error("invalid preview ticket");
  }
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    throw new Error("invalid preview ticket");
  }
  if (
    !payload
    || typeof payload !== "object"
    || (payload as Partial<RunHtmlPreviewTicket>).version !== 1
    || typeof (payload as Partial<RunHtmlPreviewTicket>).orgId !== "string"
    || typeof (payload as Partial<RunHtmlPreviewTicket>).runId !== "string"
    || typeof (payload as Partial<RunHtmlPreviewTicket>).userId !== "string"
    || typeof (payload as Partial<RunHtmlPreviewTicket>).nonce !== "string"
    || typeof (payload as Partial<RunHtmlPreviewTicket>).expiresAt !== "number"
  ) throw new Error("invalid preview ticket");
  const verified = payload as RunHtmlPreviewTicket;
  const now = input.now ?? Date.now();
  if (
    verified.expiresAt <= now
    || verified.expiresAt > now + RUN_HTML_PREVIEW_TTL_MS + RUN_HTML_PREVIEW_CLOCK_SKEW_MS
    || !verified.orgId
    || !verified.runId
    || !verified.userId
    || !verified.nonce
  ) throw new Error("preview ticket expired");
  return verified;
}

export function runHtmlPreviewOrigin(env: NodeJS.ProcessEnv = process.env): string | null {
  const configured = env.COMPANION_PREVIEW_URL?.trim();
  if (!configured) return null;
  try {
    const url = new URL(configured);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
      return null;
    }
    const webHostname = env.COMPANION_WEB_URL ? new URL(env.COMPANION_WEB_URL).hostname : null;
    const apiHostname = env.COMPANION_API_URL ? new URL(env.COMPANION_API_URL).hostname : null;
    if (url.hostname === webHostname || url.hostname === apiHostname) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function isRunHtmlPreviewRequest(requestUrl: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const previewOrigin = runHtmlPreviewOrigin(env);
  if (previewOrigin === null) return false;
  try {
    // TLS commonly terminates before the Node listener, so the internal request URL can be
    // `http:` even when the configured public preview origin is `https:`. The dedicated host
    // (including an explicit port), not the transport between the proxy and Node, is the routing
    // boundary. Reverse proxies must preserve the public Host header.
    return new URL(requestUrl).host === new URL(previewOrigin).host;
  } catch {
    return false;
  }
}

/** Sandboxed opaque-origin documents must never be able to mutate the authenticated control plane. */
export function isOpaqueOriginMutation(method: string, origin: string | undefined): boolean {
  return !["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase())
    && origin?.trim().toLowerCase() === "null";
}

export function runHtmlPreviewArtifactPath(raw: string): string {
  if (!raw || raw.includes("\0") || raw.includes("\\") || raw.length > 1_014) {
    throw new Error("invalid preview path");
  }
  let segments: string[];
  try {
    segments = raw.split("/").map((segment) => decodeURIComponent(segment));
  } catch {
    throw new Error("invalid preview path");
  }
  if (segments.some((segment) => (
    !segment
    || segment === "."
    || segment === ".."
    || segment.startsWith(".")
    || segment.includes("/")
    || segment.includes("\\")
    || segment.includes("\0")
  ))) {
    throw new Error("invalid preview path");
  }
  return `artifacts/${segments.join("/")}`;
}

export function runHtmlPreviewUrl(input: {
  origin: string;
  ticket: string;
  artifactPath: string;
}): string {
  if (!input.artifactPath.startsWith("artifacts/")) throw new Error("HTML artifact is outside artifacts/");
  const relative = input.artifactPath.slice("artifacts/".length).split("/").map(encodeURIComponent).join("/");
  return `${input.origin}/v1/run-previews/${encodeURIComponent(input.ticket)}/artifacts/${relative}`;
}
