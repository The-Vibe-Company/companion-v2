import { StripeBillingGateway } from "@companion/billing";
import { billingRuntimeConfig, listSeatSyncCandidates, reconcileSeatQuantity } from "@companion/core";
import { db, type Db } from "@companion/db";

const PENDING_INTERVAL_MS = 15_000;
const RECONCILE_INTERVAL_MS = 15 * 60_000;

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

async function runBatch(gateway: StripeBillingGateway, full: boolean): Promise<void> {
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

/** Billing is an independent supervisor: disabled billing never idles the run worker. */
export async function startBillingSupervisor(): Promise<Supervisor | null> {
  const config = billingRuntimeConfig();
  if (config.billingMode !== "stripe") {
    console.info("billing supervisor disabled");
    return null;
  }
  const gateway = gatewayFromEnvironment();
  await gateway.validateConfiguration();
  let stopped = false;
  let pendingRunning = false;
  let fullRunning = false;
  const pending = async () => {
    if (stopped || pendingRunning) return;
    pendingRunning = true;
    try { await runBatch(gateway, false); } finally { pendingRunning = false; }
  };
  const full = async () => {
    if (stopped || fullRunning) return;
    fullRunning = true;
    try { await runBatch(gateway, true); } finally { fullRunning = false; }
  };
  await pending();
  const pendingTimer = setInterval(() => void pending(), PENDING_INTERVAL_MS);
  const fullTimer = setInterval(() => void full(), RECONCILE_INTERVAL_MS);
  return {
    async stop() {
      stopped = true;
      clearInterval(pendingTimer);
      clearInterval(fullTimer);
    },
  };
}
