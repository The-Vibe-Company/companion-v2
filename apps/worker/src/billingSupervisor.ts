import { StripeBillingGateway, type BillingGateway } from "@companion/billing";
import { billingRuntimeConfig, listSeatSyncCandidates, reconcileSeatQuantity } from "@companion/core";
import { db, type Db } from "@companion/db";

const PENDING_INTERVAL_MS = 15_000;
const RECONCILE_INTERVAL_MS = 15 * 60_000;
const STARTUP_RETRY_MS = 15_000;

export interface Supervisor {
  stop(): Promise<void>;
}
function gatewayFromEnvironment(): StripeBillingGateway {
  const secret = process.env.STRIPE_SECRET_KEY?.trim();
  const price = process.env.STRIPE_PRO_PRICE_ID?.trim();
  const portal = process.env.STRIPE_PORTAL_CONFIGURATION_ID?.trim();
  const webhook = process.env.STRIPE_WEBHOOK_SECRET?.trim();
  if (!secret || !price || !portal || !webhook) throw new Error("Stripe billing environment is incomplete");
  return new StripeBillingGateway(secret, price, portal, webhook);
}

async function runBatch(gateway: BillingGateway, full: boolean): Promise<void> {
  await db.transaction(async (rawTx) => {
    const database = rawTx as unknown as Db;
    const orgIds = await listSeatSyncCandidates({ database, full, limit: 50 });
    for (const orgId of orgIds) {
      try {
        await reconcileSeatQuantity({ orgId, gateway, database });
      } catch {
        console.warn("billing seat synchronization will retry", { orgId });
      }
    }
  });
}

function safeErrorLabel(error: unknown): string {
  if (!error || typeof error !== "object") return "unknown";
  const value = error as { name?: unknown; code?: unknown; statusCode?: unknown };
  const parts = [typeof value.name === "string" && value.name ? value.name : "Error"];
  if (typeof value.code === "string" && value.code) parts.push(`code=${value.code}`);
  if (typeof value.statusCode === "number") parts.push(`status=${value.statusCode}`);
  return parts.join(" ");
}

interface BillingSupervisorOptions {
  config?: ReturnType<typeof billingRuntimeConfig>;
  gateway?: BillingGateway;
  runBatch?: (gateway: BillingGateway, full: boolean) => Promise<void>;
  startupRetryMs?: number;
  pendingIntervalMs?: number;
  reconcileIntervalMs?: number;
}

/** Billing is an independent supervisor: disabled billing never idles the run worker. */
export async function startBillingSupervisor(input: BillingSupervisorOptions = {}): Promise<Supervisor | null> {
  const config = input.config ?? billingRuntimeConfig();
  if (config.billingMode !== "stripe") {
    console.info("billing supervisor disabled");
    return null;
  }
  const executeBatch = input.runBatch ?? runBatch;
  const startupRetryMs = input.startupRetryMs ?? STARTUP_RETRY_MS;
  const pendingIntervalMs = input.pendingIntervalMs ?? PENDING_INTERVAL_MS;
  const reconcileIntervalMs = input.reconcileIntervalMs ?? RECONCILE_INTERVAL_MS;
  let gateway = input.gateway;
  let stopped = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingTimer: ReturnType<typeof setInterval> | null = null;
  let fullTimer: ReturnType<typeof setInterval> | null = null;
  let activationPromise: Promise<void> | null = null;
  let pendingPromise: Promise<void> | null = null;
  let fullPromise: Promise<void> | null = null;
  const pending = (activeGateway: BillingGateway): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (pendingPromise) return pendingPromise;
    const operation = (async () => {
      try {
        await executeBatch(activeGateway, false);
      } catch (error) {
        if (!stopped) console.warn(`billing pending synchronization will retry (${safeErrorLabel(error)})`);
      }
    })();
    pendingPromise = operation;
    void operation.finally(() => {
      if (pendingPromise === operation) pendingPromise = null;
    });
    return operation;
  };
  const full = (activeGateway: BillingGateway): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (fullPromise) return fullPromise;
    const operation = (async () => {
      try {
        await executeBatch(activeGateway, true);
      } catch (error) {
        if (!stopped) console.warn(`billing full synchronization will retry (${safeErrorLabel(error)})`);
      }
    })();
    fullPromise = operation;
    void operation.finally(() => {
      if (fullPromise === operation) fullPromise = null;
    });
    return operation;
  };
  const activate = async () => {
    try {
      gateway ??= gatewayFromEnvironment();
      await gateway.validateConfiguration();
      if (stopped) return;
      await pending(gateway);
      if (stopped) return;
      pendingTimer = setInterval(() => void pending(gateway!), pendingIntervalMs);
      fullTimer = setInterval(() => void full(gateway!), reconcileIntervalMs);
      console.info("billing supervisor started");
    } catch (error) {
      if (stopped) return;
      console.warn(`billing supervisor startup will retry (${safeErrorLabel(error)})`);
      retryTimer = setTimeout(() => {
        retryTimer = null;
        void startActivation();
      }, startupRetryMs);
    }
  };
  const startActivation = (): Promise<void> => {
    if (activationPromise) return activationPromise;
    const operation = activate();
    activationPromise = operation;
    void operation.finally(() => {
      if (activationPromise === operation) activationPromise = null;
    });
    return operation;
  };
  await startActivation();
  return {
    async stop() {
      stopped = true;
      if (retryTimer) clearTimeout(retryTimer);
      if (pendingTimer) clearInterval(pendingTimer);
      if (fullTimer) clearInterval(fullTimer);
      await Promise.allSettled(
        [activationPromise, pendingPromise, fullPromise].filter((operation): operation is Promise<void> => Boolean(operation)),
      );
    },
  };
}
