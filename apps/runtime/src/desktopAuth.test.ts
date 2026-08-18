import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  canonicalDesktopRequest,
  DESKTOP_REQUEST_PATH,
  signDesktopRequest,
  verifyDesktopRequest,
} from "./desktopAuth";

const secret = Buffer.alloc(32, 19);
const timestamp = 1_800_000_000;
const requestId = "11111111-1111-4111-8111-111111111111";
const rawBody = Buffer.from('{"orgId":"org-1"}', "utf8");

describe("desktop request HMAC", () => {
  it("canonicalizes method, pathname, timestamp, and the exact raw body digest", () => {
    expect(canonicalDesktopRequest({
      method: "post",
      pathname: DESKTOP_REQUEST_PATH,
      timestamp,
      requestId,
      rawBody,
    })).toBe([
      "POST",
      DESKTOP_REQUEST_PATH,
      String(timestamp),
      requestId,
      createHash("sha256").update(rawBody).digest("hex"),
    ].join("\n"));
  });

  it("accepts only an unmodified request inside the thirty-second window", () => {
    const request = {
      method: "POST",
      pathname: DESKTOP_REQUEST_PATH,
      timestamp,
      requestId,
      rawBody,
    };
    const signature = signDesktopRequest(request, secret);
    expect(signature).toMatch(/^v1=[a-f0-9]{64}$/);
    expect(verifyDesktopRequest({
      ...request,
      signature,
      nowMs: timestamp * 1_000 + 30_000,
    }, secret)).toBe(true);
    expect(verifyDesktopRequest({
      ...request,
      signature,
      nowMs: timestamp * 1_000 + 31_000,
    }, secret)).toBe(false);
    expect(verifyDesktopRequest({
      ...request,
      pathname: "/v1/other",
      signature,
      nowMs: timestamp * 1_000,
    }, secret)).toBe(false);
    expect(verifyDesktopRequest({
      ...request,
      rawBody: Buffer.from('{"orgId":"org-2"}'),
      signature,
      nowMs: timestamp * 1_000,
    }, secret)).toBe(false);
    expect(verifyDesktopRequest({
      ...request,
      method: "GET",
      signature,
      nowMs: timestamp * 1_000,
    }, secret)).toBe(false);
    expect(verifyDesktopRequest({
      ...request,
      signature: `${signature.slice(0, -1)}${signature.endsWith("0") ? "1" : "0"}`,
      nowMs: timestamp * 1_000,
    }, secret)).toBe(false);
  });
});
