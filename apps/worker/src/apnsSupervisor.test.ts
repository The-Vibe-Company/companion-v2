/* oxlint-disable anti-slop/no-shape-in-symbol-names -- Companion icons use "shape" as the geometric catalog field in the shared wire contract. */

import { generateKeyPairSync, verify } from "node:crypto";
import { createServer } from "node:http2";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";

import type { CompanionNotificationDeliveryClaim } from "@companion/core";

import {
  apnsCollapseId,
  apnsOrigin,
  apnsPayload,
  classifyApnsResponse,
  createApnsJwt,
  Http2ApnsSender,
  readApnsConfiguration,
} from "./apnsSupervisor";

function keyMaterial() {
  const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return {
    privateKey: pair.privateKey,
    encoded: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString("base64"),
    publicKey: pair.publicKey,
  };
}

const claim: CompanionNotificationDeliveryClaim = {
  deliveryId: "11111111-1111-4111-8111-111111111111",
  claimToken: "22222222-2222-4222-8222-222222222222",
  deviceId: "33333333-3333-4333-8333-333333333333",
  deviceToken: "ab".repeat(32),
  environment: "sandbox",
  bundleId: "dev.companion.mobile.dev",
  orgId: "44444444-4444-4444-8444-444444444444",
  companionId: "55555555-5555-4555-8555-555555555555",
  companionName: "Luna",
  icon: { shape: 6, mouth: 4, accessory: 3, color: 8 },
  event: "reply",
  eventKey: "turn:66666666-6666-4666-8666-666666666666:succeeded",
  title: "Luna replied",
  body: "The release is ready.",
  expiresAt: new Date("2026-08-25T15:00:00.000Z"),
  attemptCount: 1,
};

describe("APNs delivery", () => {
  it("stays disabled without credentials and rejects partial configuration", () => {
    expect(readApnsConfiguration({})).toBeNull();
    expect(() => readApnsConfiguration({ COMPANION_APNS_KEY_ID: "ABCDEFGHIJ" })).toThrow();
  });

  it("creates a valid ES256 provider token with Apple claims", () => {
    const keys = keyMaterial();
    const token = createApnsJwt({
      configuration: {
        keyId: "ABCDEFGHIJ",
        teamId: "KLMNOPQRST",
        privateKey: keys.privateKey,
      },
      issuedAtSeconds: 1_790_000_000,
    });
    const [header, payload, signature] = token.split(".");
    expect(JSON.parse(Buffer.from(header!, "base64url").toString())).toEqual({
      alg: "ES256",
      kid: "ABCDEFGHIJ",
    });
    expect(JSON.parse(Buffer.from(payload!, "base64url").toString())).toEqual({
      iss: "KLMNOPQRST",
      iat: 1_790_000_000,
    });
    expect(verify("sha256", Buffer.from(`${header}.${payload}`), {
      key: keys.publicKey,
      dsaEncoding: "ieee-p1363",
    }, Buffer.from(signature!, "base64url"))).toBe(true);
  });

  it("builds a versioned alert without a numeric badge", () => {
    expect(apnsOrigin("sandbox")).toContain("development");
    expect(apnsOrigin("production")).toBe("https://api.push.apple.com");
    const payload = apnsPayload(claim);
    expect(payload).toEqual({
      aps: {
        alert: { title: "Luna replied", body: "The release is ready." },
        "content-available": 1,
        sound: "default",
        "thread-id": claim.companionId,
        "mutable-content": 1,
      },
      version: 1,
      org_id: claim.orgId,
      companion_id: claim.companionId,
      event: "reply",
      companion_name: "Luna",
      companion_icon: { shape: 6, mouth: 4, accessory: 3, color: 8 },
    });
    expect("badge" in payload.aps).toBe(false);
    expect(apnsCollapseId(claim.eventKey)).toHaveLength(64);
  });

  it.each(["input_required", "failed", "interrupted"] as const)(
    "keeps %s alerts plain and omits avatar application data",
    (event) => {
      const payload = apnsPayload({
        ...claim,
        event,
      });
      expect(payload.aps["mutable-content"]).toBeUndefined();
      expect(payload.aps["content-available"]).toBe(1);
      expect(payload.companion_name).toBeUndefined();
      expect(payload.companion_icon).toBeUndefined();
    },
  );

  it("builds a plain-text alert from a Markdown reply", () => {
    const payload = apnsPayload({
      ...claim,
      body: "## Result\n\nThe **release** is ready. Read [the notes](https://example.com).",
    });
    expect(payload.aps.alert.body).toBe("Result The release is ready. Read the notes.");
  });

  it("classifies successful, revoked, transient, and permanent responses", () => {
    expect(classifyApnsResponse({ status: 200 })).toBe("complete");
    expect(classifyApnsResponse({ status: 410, reason: "Unregistered" })).toBe("invalidate");
    expect(classifyApnsResponse({ status: 400, reason: "BadDeviceToken" })).toBe("invalidate");
    expect(classifyApnsResponse({ status: 429 })).toBe("retry");
    expect(classifyApnsResponse({ status: 503 })).toBe("retry");
    expect(classifyApnsResponse({ status: 400, reason: "PayloadEmpty" })).toBe("complete");
  });

  it("bounds a hung APNs stream with a request timeout", async () => {
    const server = createServer();
    server.on("stream", (stream) => {
      // Deliberately leave the stream open to model a connected APNs request that never responds.
      stream.on("error", () => undefined);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    // SAFETY: listening with an explicit TCP host makes Node return AddressInfo, never a pipe name.
    const address = server.address() as AddressInfo | null;
    if (!address) throw new Error("HTTP/2 test server has no port");
    const keys = keyMaterial();
    const sender = new Http2ApnsSender(
      { keyId: "ABCDEFGHIJ", teamId: "KLMNOPQRST", privateKey: keys.privateKey },
      Date.now,
      20,
      undefined,
      () => `http://127.0.0.1:${address.port}`,
    );
    try {
      await expect(sender.send(claim)).rejects.toThrow("APNs request timed out");
    } finally {
      await sender.close();
      await new Promise<void>((resolve, reject) => server.close((error) => {
        if (error) reject(error);
        else resolve();
      }));
    }
  });
});
