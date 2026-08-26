import { createHash, createPrivateKey, randomUUID, sign } from "node:crypto";
import { connect, constants, type ClientHttp2Session } from "node:http2";

import {
  claimCompanionNotificationDeliveries,
  companionsEnabled,
  completeCompanionNotificationDelivery,
  deferCompanionNotificationDelivery,
  invalidateCompanionNotificationDevice,
  validateCompanionNotificationDelivery,
  type CompanionNotificationDeliveryClaim,
} from "@companion/core";
import { db, type Db } from "@companion/db";

import type { Supervisor } from "./billingSupervisor";
import { plainTextNotificationBody } from "./notificationText";

const CLAIM_INTERVAL_MS = 2_000;
const CLAIM_LIMIT = 50;
const LEASE_SECONDS = 60;
const SEND_CONCURRENCY = 8;
const JWT_REFRESH_SECONDS = 50 * 60;
const APNS_REQUEST_TIMEOUT_MS = 15_000;

export interface ApnsConfiguration {
  keyId: string;
  teamId: string;
  privateKey: ReturnType<typeof createPrivateKey>;
}

export interface ApnsResponse {
  status: number;
  reason?: string;
  retryAfterSeconds?: number;
}

export interface ApnsSender {
  send(claim: CompanionNotificationDeliveryClaim): Promise<ApnsResponse>;
  close(): Promise<void>;
}

export interface CompanionApnsPayload {
  aps: {
    alert: { title: string; body: string };
    sound: "default";
    "thread-id": string;
    "mutable-content"?: 1;
  };
  version: 1;
  org_id: string;
  companion_id: string;
  event: CompanionNotificationDeliveryClaim["event"];
  companion_name?: string;
  companion_icon?: CompanionNotificationDeliveryClaim["icon"];
}

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

export function readApnsConfiguration(
  env: NodeJS.ProcessEnv = process.env,
): ApnsConfiguration | null {
  const keyId = env.COMPANION_APNS_KEY_ID?.trim();
  const teamId = env.COMPANION_APNS_TEAM_ID?.trim();
  const encodedKey = env.COMPANION_APNS_PRIVATE_KEY_BASE64?.trim();
  if (!keyId && !teamId && !encodedKey) return null;
  if (!keyId || !teamId || !encodedKey) {
    throw new Error("APNs configuration requires key id, team id, and private key");
  }
  if (!/^[A-Z0-9]{10}$/.test(keyId) || !/^[A-Z0-9]{10}$/.test(teamId)) {
    throw new Error("APNs key id and team id must be ten uppercase letters or digits");
  }
  const keyBytes = Buffer.from(encodedKey, "base64");
  if (keyBytes.length === 0) throw new Error("APNs private key is empty");
  return { keyId, teamId, privateKey: createPrivateKey(keyBytes) };
}

export function createApnsJwt(input: {
  configuration: ApnsConfiguration;
  issuedAtSeconds: number;
}): string {
  const header = base64url(JSON.stringify({ alg: "ES256", kid: input.configuration.keyId }));
  const payload = base64url(JSON.stringify({
    iss: input.configuration.teamId,
    iat: input.issuedAtSeconds,
  }));
  const signingInput = `${header}.${payload}`;
  const signature = sign("sha256", Buffer.from(signingInput), {
    key: input.configuration.privateKey,
    dsaEncoding: "ieee-p1363",
  });
  return `${signingInput}.${base64url(signature)}`;
}

function retryAfterSeconds(value: string | undefined, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(900, Math.max(1, seconds));
  const instant = Date.parse(value);
  if (!Number.isFinite(instant)) return undefined;
  return Math.min(900, Math.max(1, Math.ceil((instant - now) / 1_000)));
}

export function apnsOrigin(environment: CompanionNotificationDeliveryClaim["environment"]): string {
  return environment === "sandbox"
    ? "https://api.development.push.apple.com"
    : "https://api.push.apple.com";
}

export function apnsCollapseId(eventKey: string): string {
  return createHash("sha256").update(eventKey).digest("hex");
}

export function apnsPayload(claim: CompanionNotificationDeliveryClaim): CompanionApnsPayload {
  const includesAvatar = claim.event === "reply";
  const payload: CompanionApnsPayload = {
    aps: {
      alert: { title: claim.title, body: plainTextNotificationBody(claim.body) },
      sound: "default",
      "thread-id": claim.companionId,
    },
    version: 1,
    org_id: claim.orgId,
    companion_id: claim.companionId,
    event: claim.event,
  };
  if (includesAvatar) {
    payload.aps["mutable-content"] = 1;
    payload.companion_name = claim.companionName;
    payload.companion_icon = claim.icon;
  }
  return payload;
}

export class Http2ApnsSender implements ApnsSender {
  private readonly sessions = new Map<string, ClientHttp2Session>();
  private jwt: { value: string; issuedAtSeconds: number } | null = null;

  constructor(
    private readonly configuration: ApnsConfiguration,
    private readonly now: () => number = Date.now,
    private readonly requestTimeoutMs = APNS_REQUEST_TIMEOUT_MS,
    private readonly connectSession: typeof connect = connect,
    private readonly resolveOrigin: typeof apnsOrigin = apnsOrigin,
  ) {}

  private token(): string {
    const nowSeconds = Math.floor(this.now() / 1_000);
    if (!this.jwt || nowSeconds - this.jwt.issuedAtSeconds >= JWT_REFRESH_SECONDS) {
      this.jwt = {
        value: createApnsJwt({ configuration: this.configuration, issuedAtSeconds: nowSeconds }),
        issuedAtSeconds: nowSeconds,
      };
    }
    return this.jwt.value;
  }

  private session(environment: CompanionNotificationDeliveryClaim["environment"]): ClientHttp2Session {
    const origin = this.resolveOrigin(environment);
    const existing = this.sessions.get(origin);
    if (existing && !existing.closed && !existing.destroyed) return existing;
    const session = this.connectSession(origin);
    session.unref();
    session.once("close", () => {
      if (this.sessions.get(origin) === session) this.sessions.delete(origin);
    });
    session.on("error", () => undefined);
    this.sessions.set(origin, session);
    return session;
  }

  async send(claim: CompanionNotificationDeliveryClaim): Promise<ApnsResponse> {
    const payload = Buffer.from(JSON.stringify(apnsPayload(claim)));
    const request = this.session(claim.environment).request({
      [constants.HTTP2_HEADER_METHOD]: "POST",
      [constants.HTTP2_HEADER_PATH]: `/3/device/${claim.deviceToken}`,
      authorization: `bearer ${this.token()}`,
      "apns-topic": claim.bundleId,
      "apns-push-type": "alert",
      "apns-priority": "10",
      "apns-expiration": String(Math.floor(claim.expiresAt.getTime() / 1_000)),
      "apns-collapse-id": apnsCollapseId(claim.eventKey),
      "apns-id": claim.deliveryId,
      "content-type": "application/json",
      "content-length": String(payload.byteLength),
    });
    return await new Promise<ApnsResponse>((resolve, reject) => {
      let status = 0;
      let retryAfter: string | undefined;
      let response = "";
      request.setEncoding("utf8");
      request.on("response", (headers) => {
        status = Number(headers[constants.HTTP2_HEADER_STATUS] ?? 0);
        const header = headers["retry-after"];
        retryAfter = Array.isArray(header) ? header[0] : header;
      });
      request.on("data", (chunk: string) => {
        if (response.length < 4_096) response += chunk.slice(0, 4_096 - response.length);
      });
      request.once("error", reject);
      request.setTimeout(this.requestTimeoutMs, () => {
        request.destroy(new Error("APNs request timed out"));
      });
      request.once("end", () => {
        // Apple's error body is a single bounded reason string. Extract only that documented token
        // and discard every other provider byte rather than widening the JSON into application data.
        const reason = /"reason"\s*:\s*"([A-Za-z]+)"/.exec(response)?.[1]?.slice(0, 100);
        resolve({ status, reason, retryAfterSeconds: retryAfterSeconds(retryAfter, this.now()) });
      });
      request.end(payload);
    });
  }

  async close(): Promise<void> {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(sessions.map((session) => new Promise<void>((resolve) => {
      if (session.closed || session.destroyed) return resolve();
      session.once("close", resolve);
      session.close();
    })));
  }
}

function backoffSeconds(claim: CompanionNotificationDeliveryClaim, response?: ApnsResponse): number {
  if (response?.retryAfterSeconds) return response.retryAfterSeconds;
  return Math.min(900, 2 ** Math.min(9, Math.max(1, claim.attemptCount)));
}

export function classifyApnsResponse(response: ApnsResponse): "complete" | "retry" | "invalidate" {
  if (response.status === 200) return "complete";
  if (response.status === 410
    || (response.status === 400
      && ["BadDeviceToken", "DeviceTokenNotForTopic", "Unregistered"].includes(response.reason ?? ""))) {
    return "invalidate";
  }
  if (response.status === 429 || response.status === 403 || response.status >= 500 || response.status === 0) {
    return "retry";
  }
  return "complete";
}

async function settleClaim(input: {
  claim: CompanionNotificationDeliveryClaim;
  sender: ApnsSender;
  database: Db;
}): Promise<void> {
  await input.database.transaction(async (rawTransaction) => {
    const database = rawTransaction;
    const { claim } = input;
    const stillAuthorized = await validateCompanionNotificationDelivery({
      deliveryId: claim.deliveryId,
      claimToken: claim.claimToken,
      database,
    });
    if (!stillAuthorized) return;
    let response: ApnsResponse;
    try {
      response = await input.sender.send(claim);
    } catch {
      await deferCompanionNotificationDelivery({
        deliveryId: claim.deliveryId,
        claimToken: claim.claimToken,
        delaySeconds: backoffSeconds(claim),
        database,
      });
      return;
    }

    const action = classifyApnsResponse(response);
    if (action === "complete") {
      await completeCompanionNotificationDelivery({
        deliveryId: claim.deliveryId,
        claimToken: claim.claimToken,
        database,
      });
      return;
    }
    if (action === "invalidate") {
      await invalidateCompanionNotificationDevice({
        deliveryId: claim.deliveryId,
        claimToken: claim.claimToken,
        database,
      });
      return;
    }
    await deferCompanionNotificationDelivery({
      deliveryId: claim.deliveryId,
      claimToken: claim.claimToken,
      delaySeconds: backoffSeconds(claim, response),
      database,
    });
  });
}

async function mapWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  task: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(items.length, concurrency) }, async () => {
    while (cursor < items.length) await task(items[cursor++]!);
  }));
}

export async function startApnsSupervisor(input: {
  intervalMs?: number;
  env?: NodeJS.ProcessEnv;
  database?: Db;
  sender?: ApnsSender;
} = {}): Promise<Supervisor | null> {
  const env = input.env ?? process.env;
  if (!companionsEnabled(env)) return null;
  const configuration = readApnsConfiguration(env);
  if (!configuration) {
    console.info("Companion APNs supervisor disabled");
    return null;
  }
  const sender = input.sender ?? new Http2ApnsSender(configuration);
  const database = input.database ?? db;
  const workerId = `${env.HOSTNAME?.trim() || "worker"}:apns:${process.pid}:${randomUUID()}`;
  let stopped = false;
  let running: Promise<void> | null = null;
  const batch = async () => {
    if (!companionsEnabled(env)) return;
    const claims = await claimCompanionNotificationDeliveries({
      workerId,
      limit: CLAIM_LIMIT,
      leaseSeconds: LEASE_SECONDS,
      database,
    });
    await mapWithConcurrency(claims, SEND_CONCURRENCY, async (claim) => {
      await settleClaim({ claim, sender, database });
    });
  };
  const tick = () => {
    if (stopped || running) return;
    const operation = batch().catch(() => undefined);
    running = operation;
    void operation.finally(() => { if (running === operation) running = null; });
  };
  tick();
  const timer = setInterval(tick, input.intervalMs ?? CLAIM_INTERVAL_MS);
  console.info("Companion APNs supervisor started");
  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      if (running) await running;
      await sender.close();
    },
  };
}
