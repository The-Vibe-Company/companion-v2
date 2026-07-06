import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, inArray, isNull, or } from "drizzle-orm";
import type {
  AgentHeartbeatInput,
  AgentHeartbeatOutput,
  DeviceInventory,
  DeviceInventorySkill,
  DeviceInventorySkillRow,
  DeviceRow,
  RegisterDeviceInput,
  RegisteredDevice,
} from "@companion/contracts";
import {
  AGENT_HEARTBEAT_INTERVAL_SECONDS,
  COMPANION_AGENT_VERSION,
  DEVICE_TOKEN_PREFIX,
  deviceInventorySchema,
} from "@companion/contracts";
import { db, schema, type Db } from "@companion/db";
import { compareSemver } from "@companion/skills";
import { getOrgRole, type ActorContext } from "./services";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface ResolvedDeviceToken {
  actor: ActorContext;
  orgId: string;
  deviceId: string;
}

function hashDeviceToken(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("hex");
}

function mintDeviceToken(): string {
  return `${DEVICE_TOKEN_PREFIX}${randomBytes(24).toString("hex")}`;
}

function assertKnownDevicePlatform(platform: string | undefined): "darwin" | "linux" | "win32" {
  if (platform === "linux" || platform === "win32") return platform;
  return "darwin";
}

function safeInventory(value: unknown): DeviceInventory {
  const parsed = deviceInventorySchema.safeParse(value);
  return parsed.success ? parsed.data : { skills: [], tools: [] };
}

function isNewerVersion(latest: string, current: string | null | undefined): boolean {
  if (!current) return false;
  try {
    return compareSemver(latest, current) > 0;
  } catch {
    return false;
  }
}

function skillIdentity(skill: DeviceInventorySkill): { skillId: string | null; slug: string } {
  const candidate = skill.skillId ?? skill.companionSkillId ?? null;
  return { skillId: candidate && UUID_RE.test(candidate) ? candidate : null, slug: skill.slug || skill.name || "" };
}

interface SkillState {
  id: string;
  slug: string;
  currentVersion: string | null;
  archivedAt: Date | null;
  creatorId: string;
  scope: "personal" | "org";
}

async function loadSkillStates(input: {
  database: Db;
  orgId: string;
  userId: string;
  inventory: DeviceInventory;
}): Promise<{ byId: Map<string, SkillState>; bySlug: Map<string, SkillState> }> {
  const ids = [
    ...new Set(
      input.inventory.skills
        .map((skill) => skillIdentity(skill).skillId)
        .filter((id): id is string => !!id),
    ),
  ];
  const slugs = [
    ...new Set(
      input.inventory.skills
        .map((skill) => skillIdentity(skill).slug)
        .filter(Boolean),
    ),
  ];

  const selectSkillState = () =>
    input.database
      .select({
        id: schema.skills.id,
        slug: schema.skills.slug,
        currentVersion: schema.skillVersions.version,
        archivedAt: schema.skills.archivedAt,
        creatorId: schema.skills.creatorId,
        scope: schema.skills.scope,
      })
      .from(schema.skills)
      .leftJoin(schema.skillVersions, eq(schema.skillVersions.id, schema.skills.currentVersionId));

  const accessFilter = and(
    eq(schema.skills.orgId, input.orgId),
    or(eq(schema.skills.scope, "org"), and(eq(schema.skills.scope, "personal"), eq(schema.skills.creatorId, input.userId))),
  );

  const rowsById = ids.length
    ? await selectSkillState().where(and(accessFilter, inArray(schema.skills.id, ids)))
    : [];
  const rowsBySlug = slugs.length
    ? await selectSkillState().where(and(accessFilter, inArray(schema.skills.slug, slugs)))
    : [];

  const byId = new Map<string, SkillState>();
  const bySlug = new Map<string, SkillState>();
  for (const row of [...rowsById, ...rowsBySlug]) {
    if (row.scope === "personal" && row.creatorId !== input.userId) continue;
    const state = {
      id: row.id,
      slug: row.slug,
      currentVersion: row.currentVersion ?? null,
      archivedAt: row.archivedAt ?? null,
      creatorId: row.creatorId,
      scope: row.scope,
    };
    byId.set(row.id, state);
    bySlug.set(row.slug, state);
  }
  return { byId, bySlug };
}

async function inventoryRows(input: {
  database: Db;
  orgId: string;
  userId: string;
  inventory: DeviceInventory;
}): Promise<DeviceInventorySkillRow[]> {
  const states = await loadSkillStates(input);
  return input.inventory.skills.map((skill) => {
    const identity = skillIdentity(skill);
    const state = identity.skillId ? states.byId.get(identity.skillId) : undefined;
    const resolved = state ?? states.bySlug.get(identity.slug) ?? null;
    const currentVersion = resolved?.currentVersion ?? null;
    const installedVersion = skill.version ?? null;
    return {
      ...skill,
      targets: skill.targets ?? [],
      resolved_skill_id: resolved?.id ?? null,
      resolved_slug: resolved?.slug ?? null,
      current_version: currentVersion,
      archived: !!resolved?.archivedAt,
      outdated: !!resolved && !resolved.archivedAt && isNewerVersion(currentVersion ?? "", installedVersion),
      managed: !!resolved,
    };
  });
}

function heartbeatSkillMap(rows: DeviceInventorySkillRow[]): AgentHeartbeatOutput["skills"] {
  const result: AgentHeartbeatOutput["skills"] = {};
  for (const row of rows) {
    if (!row.resolved_skill_id || !row.resolved_slug) continue;
    result[row.resolved_skill_id] = {
      slug: row.resolved_slug,
      current_version: row.current_version,
      archived: row.archived,
    };
  }
  return result;
}

function toIso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

async function toDeviceRow(input: {
  database: Db;
  row: typeof schema.devices.$inferSelect;
  now?: Date;
}): Promise<DeviceRow> {
  const inventory = safeInventory(input.row.inventory);
  const inventorySkills = await inventoryRows({
    database: input.database,
    orgId: input.row.orgId,
    userId: input.row.userId,
    inventory,
  });
  const now = input.now ?? new Date();
  const online =
    !!input.row.lastSeenAt &&
    now.getTime() - input.row.lastSeenAt.getTime() < AGENT_HEARTBEAT_INTERVAL_SECONDS * 2 * 1000;
  return {
    id: input.row.id,
    org_id: input.row.orgId,
    user_id: input.row.userId,
    name: input.row.name,
    platform: input.row.platform,
    agent_version: input.row.agentVersion ?? null,
    companion_skill_version: inventory.companionSkillVersion ?? null,
    inventory,
    inventory_skills: inventorySkills,
    inventory_reported_at: toIso(input.row.inventoryReportedAt),
    last_seen_at: toIso(input.row.lastSeenAt),
    created_at: input.row.createdAt.toISOString(),
    revoked_at: toIso(input.row.revokedAt),
    online,
    agent_update_available: isNewerVersion(COMPANION_AGENT_VERSION, input.row.agentVersion),
  };
}

export async function registerDevice(input: {
  actor: ActorContext;
  orgId: string;
  apiUrl: string;
  device?: RegisterDeviceInput;
  database?: Db;
}): Promise<RegisteredDevice> {
  const database = input.database ?? db;
  const role = await getOrgRole(input.orgId, input.actor.id, database);
  if (!role) throw new Error("not a member of this organization");
  const token = mintDeviceToken();
  const device = input.device ?? {};
  const [row] = await database
    .insert(schema.devices)
    .values({
      orgId: input.orgId,
      userId: input.actor.id,
      name: device.name?.trim() || "Unknown Mac",
      platform: assertKnownDevicePlatform(device.platform),
      agentVersion: device.agent_version ?? COMPANION_AGENT_VERSION,
      tokenHash: hashDeviceToken(token),
    })
    .returning({ id: schema.devices.id });
  if (!row) throw new Error("could not register device");
  await database.insert(schema.auditLog).values({
    orgId: input.orgId,
    actorId: input.actor.id,
    action: "device.register",
    targetType: "device",
    targetId: row.id,
    metadata: {
      name: device.name ?? null,
      platform: device.platform ?? null,
      agent_version: device.agent_version ?? null,
    },
  });
  return {
    device_id: row.id,
    device_token: token,
    org_id: input.orgId,
    api_url: input.apiUrl.replace(/\/$/, ""),
  };
}

export async function resolveDeviceToken(rawToken: string, database: Db = db): Promise<ResolvedDeviceToken | null> {
  if (!rawToken.startsWith(DEVICE_TOKEN_PREFIX)) return null;
  const row = await database.query.devices.findFirst({
    where: eq(schema.devices.tokenHash, hashDeviceToken(rawToken)),
  });
  if (!row || row.revokedAt) return null;
  const role = await getOrgRole(row.orgId, row.userId, database);
  if (!role) return null;
  const profile = await database.query.profiles
    .findFirst({ where: eq(schema.profiles.id, row.userId) })
    .catch(() => null);
  return {
    actor: {
      id: row.userId,
      email: profile?.email ?? "",
      name: profile?.name || profile?.email || row.userId,
    },
    orgId: row.orgId,
    deviceId: row.id,
  };
}

export async function recordHeartbeat(input: {
  device: ResolvedDeviceToken;
  heartbeat: AgentHeartbeatInput;
  database?: Db;
}): Promise<AgentHeartbeatOutput> {
  const database = input.database ?? db;
  const now = new Date();
  const inventory = deviceInventorySchema.parse({
    ...input.heartbeat.inventory,
    tools: input.heartbeat.tools,
    companionSkillVersion: input.heartbeat.companion_skill_version ?? null,
  });
  await database
    .update(schema.devices)
    .set({
      name: input.heartbeat.hostname,
      platform: input.heartbeat.platform,
      agentVersion: input.heartbeat.agent_version,
      inventory,
      inventoryReportedAt: now,
      lastSeenAt: now,
    })
    .where(
      and(
        eq(schema.devices.id, input.device.deviceId),
        eq(schema.devices.orgId, input.device.orgId),
        eq(schema.devices.userId, input.device.actor.id),
        isNull(schema.devices.revokedAt),
      ),
    );
  const rows = await inventoryRows({ database, orgId: input.device.orgId, userId: input.device.actor.id, inventory });
  return {
    ok: true,
    interval_seconds: AGENT_HEARTBEAT_INTERVAL_SECONDS,
    latest_agent_version: COMPANION_AGENT_VERSION,
    agent_update_available: isNewerVersion(COMPANION_AGENT_VERSION, input.heartbeat.agent_version),
    skills: heartbeatSkillMap(rows),
    rotate_token: null,
    commands: [],
  };
}

export async function listDevices(input: {
  actor: ActorContext;
  orgId: string;
  database?: Db;
  now?: Date;
}): Promise<DeviceRow[]> {
  const database = input.database ?? db;
  const role = await getOrgRole(input.orgId, input.actor.id, database);
  if (!role) throw new Error("not a member of this organization");
  const rows = await database
    .select()
    .from(schema.devices)
    .where(
      and(
        eq(schema.devices.orgId, input.orgId),
        eq(schema.devices.userId, input.actor.id),
        isNull(schema.devices.revokedAt),
      ),
    )
    .orderBy(desc(schema.devices.createdAt));
  return Promise.all(rows.map((row) => toDeviceRow({ database, row, now: input.now })));
}

export async function revokeDevice(input: {
  actor: ActorContext;
  orgId: string;
  deviceId: string;
  database?: Db;
}): Promise<void> {
  const database = input.database ?? db;
  const role = await getOrgRole(input.orgId, input.actor.id, database);
  if (!role) throw new Error("not a member of this organization");
  const row = await database.query.devices.findFirst({
    where: and(
      eq(schema.devices.id, input.deviceId),
      eq(schema.devices.orgId, input.orgId),
      eq(schema.devices.userId, input.actor.id),
    ),
  });
  if (!row || row.revokedAt) throw new Error("device not found");
  await database
    .update(schema.devices)
    .set({ revokedAt: new Date() })
    .where(and(eq(schema.devices.id, input.deviceId), eq(schema.devices.userId, input.actor.id)));
  await database.insert(schema.auditLog).values({
    orgId: input.orgId,
    actorId: input.actor.id,
    action: "device.revoke",
    targetType: "device",
    targetId: input.deviceId,
    metadata: { name: row.name },
  });
}
