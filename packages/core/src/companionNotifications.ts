import { sql } from "drizzle-orm";

import type {
  CompanionNotificationEvent,
  NotificationDeviceRegistration,
} from "@companion/contracts/notifications";
import type { Db } from "@companion/db";

type NotificationDatabase = Pick<Db, "execute">;

function rows<T>(result: Awaited<ReturnType<NotificationDatabase["execute"]>>): T[] {
  // SAFETY: Drizzle's PostgreSQL execute result is iterable over the rows selected by the exact
  // SECURITY DEFINER function call at each call site; the paired row type mirrors that projection.
  return Array.from(result as Iterable<T>);
}

export async function registerCompanionNotificationDevice(input: {
  orgId: string;
  installationId: string;
  registration: NotificationDeviceRegistration;
  database: NotificationDatabase;
}): Promise<void> {
  await input.database.execute(sql`
    select public.companion_api_register_notification_device(
      ${input.orgId}::uuid,
      ${input.installationId}::uuid,
      ${input.registration.platform},
      ${input.registration.device_token},
      ${input.registration.environment}::public.companion_notification_environment,
      ${input.registration.bundle_id}
    )
  `);
}

export async function unregisterCompanionNotificationDevice(input: {
  orgId: string;
  installationId: string;
  database: NotificationDatabase;
}): Promise<void> {
  await input.database.execute(sql`
    select public.companion_api_unregister_notification_device(
      ${input.orgId}::uuid,
      ${input.installationId}::uuid
    )
  `);
}

export interface CompanionNotificationDeliveryClaim {
  deliveryId: string;
  claimToken: string;
  deviceId: string;
  deviceToken: string;
  environment: "sandbox" | "production";
  bundleId: "dev.companion.mobile.dev" | "dev.companion.mobile";
  orgId: string;
  companionId: string;
  event: CompanionNotificationEvent;
  eventKey: string;
  title: string;
  body: string;
  expiresAt: Date;
  attemptCount: number;
}

export async function claimCompanionNotificationDeliveries(input: {
  workerId: string;
  limit?: number;
  leaseSeconds?: number;
  database: NotificationDatabase;
}): Promise<CompanionNotificationDeliveryClaim[]> {
  const result = await input.database.execute(sql`
    select * from public.companion_claim_notification_deliveries(
      ${input.workerId},
      ${input.limit ?? 50},
      ${input.leaseSeconds ?? 60}
    )
  `);
  return rows<{
    deliveryId: string;
    claimToken: string;
    deviceId: string;
    deviceToken: string;
    environment: "sandbox" | "production";
    bundleId: "dev.companion.mobile.dev" | "dev.companion.mobile";
    orgId: string;
    companionId: string;
    event: CompanionNotificationEvent;
    eventKey: string;
    title: string;
    body: string;
    expiresAt: Date | string;
    attemptCount: number;
  }>(result).map((row) => ({
    ...row,
    expiresAt: row.expiresAt instanceof Date ? row.expiresAt : new Date(row.expiresAt),
  }));
}

export async function completeCompanionNotificationDelivery(input: {
  claimToken: string;
  deliveryId: string;
  database: NotificationDatabase;
}): Promise<boolean> {
  const result = await input.database.execute(sql`
    select public.companion_complete_notification_delivery(
      ${input.deliveryId}::uuid,
      ${input.claimToken}::uuid
    ) as completed
  `);
  return rows<{ completed: boolean }>(result)[0]?.completed === true;
}

export async function validateCompanionNotificationDelivery(input: {
  claimToken: string;
  deliveryId: string;
  database: NotificationDatabase;
}): Promise<boolean> {
  const result = await input.database.execute(sql`
    select public.companion_validate_notification_delivery(
      ${input.deliveryId}::uuid,
      ${input.claimToken}::uuid
    ) as valid
  `);
  return rows<{ valid: boolean }>(result)[0]?.valid === true;
}

export async function deferCompanionNotificationDelivery(input: {
  claimToken: string;
  deliveryId: string;
  delaySeconds: number;
  database: NotificationDatabase;
}): Promise<boolean> {
  const result = await input.database.execute(sql`
    select public.companion_defer_notification_delivery(
      ${input.deliveryId}::uuid,
      ${input.claimToken}::uuid,
      ${input.delaySeconds}
    ) as deferred
  `);
  return rows<{ deferred: boolean }>(result)[0]?.deferred === true;
}

export async function invalidateCompanionNotificationDevice(input: {
  claimToken: string;
  deliveryId: string;
  database: NotificationDatabase;
}): Promise<boolean> {
  const result = await input.database.execute(sql`
    select public.companion_invalidate_notification_device(
      ${input.deliveryId}::uuid,
      ${input.claimToken}::uuid
    ) as invalidated
  `);
  return rows<{ invalidated: boolean }>(result)[0]?.invalidated === true;
}
