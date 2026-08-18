import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const DESKTOP_REQUEST_PATH = "/v1/desktop";
export const DESKTOP_REQUEST_MAX_SKEW_SECONDS = 30;
export const DESKTOP_SIGNATURE_HEADER = "x-companion-runtime-signature";
export const DESKTOP_TIMESTAMP_HEADER = "x-companion-runtime-timestamp";
export const DESKTOP_REQUEST_ID_HEADER = "x-companion-runtime-request-id";

export interface DesktopRequestAuthInput {
  method: string;
  pathname: string;
  timestamp: number;
  requestId: string;
  rawBody: Uint8Array;
}

/** Shared PR6/PR7 wire contract. The URL query is forbidden by the endpoint and is not canonical. */
export function canonicalDesktopRequest(input: DesktopRequestAuthInput): string {
  if (!Number.isSafeInteger(input.timestamp) || input.timestamp < 0) {
    throw new Error("desktop request timestamp must be a non-negative safe integer");
  }
  if (!/^[A-Za-z0-9._:-]{16,128}$/.test(input.requestId)) {
    throw new Error("desktop request id is invalid");
  }
  const method = input.method.toUpperCase();
  if (!/^[A-Z]+$/.test(method) || !input.pathname.startsWith("/") || /[\r\n]/.test(input.pathname)) {
    throw new Error("desktop request method or pathname is invalid");
  }
  const bodyDigest = createHash("sha256").update(input.rawBody).digest("hex");
  return `${method}\n${input.pathname}\n${input.timestamp}\n${input.requestId}\n${bodyDigest}`;
}

export function signDesktopRequest(
  input: DesktopRequestAuthInput,
  secret: Uint8Array,
): string {
  requireHmacSecret(secret);
  const signature = createHmac("sha256", secret)
    .update(canonicalDesktopRequest(input), "utf8")
    .digest("hex");
  return `v1=${signature}`;
}

export function verifyDesktopRequest(input: DesktopRequestAuthInput & {
  signature: string;
  nowMs?: number;
  maxSkewSeconds?: number;
}, secret: Uint8Array): boolean {
  requireHmacSecret(secret);
  const nowSeconds = Math.floor((input.nowMs ?? Date.now()) / 1_000);
  const maxSkew = input.maxSkewSeconds ?? DESKTOP_REQUEST_MAX_SKEW_SECONDS;
  if (!Number.isSafeInteger(maxSkew) || maxSkew < 1) return false;
  if (Math.abs(nowSeconds - input.timestamp) > maxSkew) return false;
  const match = /^v1=([a-f0-9]{64})$/.exec(input.signature);
  if (!match?.[1]) return false;
  let expected: Buffer;
  try {
    expected = Buffer.from(signDesktopRequest(input, secret).slice(3), "hex");
  } catch {
    return false;
  }
  const supplied = Buffer.from(match[1], "hex");
  return supplied.byteLength === expected.byteLength && timingSafeEqual(supplied, expected);
}

function requireHmacSecret(secret: Uint8Array): void {
  if (secret.byteLength < 32) throw new Error("desktop HMAC secret must contain at least 32 bytes");
}
