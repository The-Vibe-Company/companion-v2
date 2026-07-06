import { z } from "zod";

export const DEVICE_TOKEN_PREFIX = "cmp_dev_";
export const COMPANION_AGENT_VERSION = "0.0.0";
export const AGENT_HEARTBEAT_INTERVAL_SECONDS = 900;

export const devicePlatformSchema = z.enum(["darwin", "linux", "win32"]);
export type DevicePlatform = z.infer<typeof devicePlatformSchema>;

export const deviceInventoryTargetSchema = z
  .object({
    tool: z.string().min(1).max(80),
    scope: z.enum(["user", "project"]),
    path: z.string().min(1).max(4096),
    checksum: z.string().max(120).nullable().optional(),
    version: z.string().max(80).nullable().optional(),
  })
  .strict();
export type DeviceInventoryTarget = z.infer<typeof deviceInventoryTargetSchema>;

export const deviceInventorySkillSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    slug: z.string().min(1).max(200),
    skillId: z.string().min(1).max(120).nullable().optional(),
    companionSkillId: z.string().min(1).max(120).nullable().optional(),
    version: z.string().max(80).nullable().optional(),
    checksum: z.string().max(120).nullable().optional(),
    path: z.string().max(4096).nullable().optional(),
    targets: z.array(deviceInventoryTargetSchema).max(200).default([]),
  })
  .strict();
export type DeviceInventorySkill = z.infer<typeof deviceInventorySkillSchema>;

export const deviceInventorySchema = z
  .object({
    lockfileVersion: z.number().int().min(1).max(10).optional(),
    lockfile: z.string().max(4096).nullable().optional(),
    workspaceId: z.string().max(120).nullable().optional(),
    apiUrl: z.string().max(2048).nullable().optional(),
    tools: z.array(z.string().min(1).max(80)).max(40).default([]),
    companionSkillVersion: z.string().min(1).max(80).nullable().optional(),
    skills: z.array(deviceInventorySkillSchema).max(500).default([]),
  })
  .strict();
export type DeviceInventory = z.infer<typeof deviceInventorySchema>;

export const registerDeviceInputSchema = z
  .object({
    name: z.string().min(1).max(255).optional(),
    platform: devicePlatformSchema.optional(),
    agent_version: z.string().min(1).max(80).optional(),
  })
  .strict();
export type RegisterDeviceInput = z.infer<typeof registerDeviceInputSchema>;

export const registeredDeviceSchema = z.object({
  device_id: z.string(),
  device_token: z.string().startsWith(DEVICE_TOKEN_PREFIX),
  org_id: z.string(),
  api_url: z.string(),
});
export type RegisteredDevice = z.infer<typeof registeredDeviceSchema>;

export const agentHeartbeatInputSchema = z
  .object({
    agent_version: z.string().min(1).max(80),
    platform: devicePlatformSchema,
    hostname: z.string().min(1).max(255),
    tools: z.array(z.string().min(1).max(80)).max(40).default([]),
    companion_skill_version: z.string().min(1).max(80).nullable().optional(),
    inventory: deviceInventorySchema,
  })
  .strict();
export type AgentHeartbeatInput = z.infer<typeof agentHeartbeatInputSchema>;

export const heartbeatSkillStateSchema = z.object({
  slug: z.string(),
  current_version: z.string().nullable(),
  archived: z.boolean(),
});

export const agentHeartbeatOutputSchema = z.object({
  ok: z.literal(true),
  interval_seconds: z.number().int().positive(),
  latest_agent_version: z.string(),
  agent_update_available: z.boolean(),
  skills: z.record(heartbeatSkillStateSchema),
  rotate_token: z.null(),
  commands: z.array(z.unknown()),
});
export type AgentHeartbeatOutput = z.infer<typeof agentHeartbeatOutputSchema>;

export const deviceInventorySkillRowSchema = deviceInventorySkillSchema.extend({
  resolved_skill_id: z.string().nullable(),
  resolved_slug: z.string().nullable(),
  current_version: z.string().nullable(),
  archived: z.boolean(),
  outdated: z.boolean(),
  managed: z.boolean(),
});
export type DeviceInventorySkillRow = z.infer<typeof deviceInventorySkillRowSchema>;

export const deviceRowSchema = z.object({
  id: z.string(),
  org_id: z.string(),
  user_id: z.string(),
  name: z.string(),
  platform: z.string(),
  agent_version: z.string().nullable(),
  companion_skill_version: z.string().nullable(),
  inventory: deviceInventorySchema,
  inventory_skills: z.array(deviceInventorySkillRowSchema),
  inventory_reported_at: z.string().nullable(),
  last_seen_at: z.string().nullable(),
  created_at: z.string(),
  revoked_at: z.string().nullable(),
  online: z.boolean(),
  agent_update_available: z.boolean(),
});
export type DeviceRow = z.infer<typeof deviceRowSchema>;
