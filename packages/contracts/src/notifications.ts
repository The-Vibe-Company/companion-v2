import { z } from "zod";

export const notificationInstallationIdSchema = z.string().uuid();

export const notificationDeviceRegistrationSchema = z.object({
  platform: z.literal("ios"),
  device_token: z.string().regex(/^[a-f0-9]{64,512}$/),
  environment: z.enum(["sandbox", "production"]),
  bundle_id: z.enum(["dev.companion.mobile.dev", "dev.companion.mobile"]),
}).strict().superRefine((registration, context) => {
  const valid = registration.environment === "sandbox"
    ? registration.bundle_id === "dev.companion.mobile.dev"
    : registration.bundle_id === "dev.companion.mobile";
  if (!valid) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["bundle_id"],
      message: "bundle_id does not match the APNs environment",
    });
  }
});
export type NotificationDeviceRegistration = z.infer<typeof notificationDeviceRegistrationSchema>;

export const companionNotificationEventSchema = z.enum([
  "reply",
  "input_required",
  "failed",
  "interrupted",
]);
export type CompanionNotificationEvent = z.infer<typeof companionNotificationEventSchema>;

export const companionNotificationPayloadSchema = z.object({
  version: z.literal(1),
  org_id: z.string().uuid(),
  companion_id: z.string().uuid(),
  event: companionNotificationEventSchema,
}).strict();
export type CompanionNotificationPayload = z.infer<typeof companionNotificationPayloadSchema>;
