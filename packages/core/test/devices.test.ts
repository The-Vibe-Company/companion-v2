import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { schema, type Db } from "@companion/db";
import {
  listDevices,
  recordHeartbeat,
  registerDevice,
  resolveDeviceToken,
  revokeDevice,
  type ActorContext,
  type ResolvedDeviceToken,
} from "../src/services";

const ORG = "00000000-0000-0000-0000-0000000000aa";
const OTHER_ORG = "00000000-0000-0000-0000-0000000000bb";
const ALPHA_ID = "11111111-1111-4111-8111-111111111111";
const BETA_ID = "22222222-2222-4222-8222-222222222222";
const actor: ActorContext = { id: "user-1", email: "u@example.com", name: "User" };
const other: ActorContext = { id: "user-2", email: "o@example.com", name: "Other" };

function hash(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

interface DeviceRow {
  id: string;
  orgId: string;
  userId: string;
  name: string;
  platform: string;
  agentVersion: string | null;
  tokenHash: string | null;
  inventory: Record<string, unknown>;
  inventoryReportedAt: Date | null;
  lastSeenAt: Date | null;
  createdAt: Date;
  revokedAt: Date | null;
}

interface SkillState {
  id: string;
  slug: string;
  currentVersion: string | null;
  archivedAt: Date | null;
  creatorId?: string;
  scope?: "personal" | "org";
}

function device(overrides: Partial<DeviceRow> = {}): DeviceRow {
  return {
    id: "device-1",
    orgId: ORG,
    userId: actor.id,
    name: "louisville",
    platform: "darwin",
    agentVersion: "0.0.0",
    tokenHash: null,
    inventory: { skills: [], tools: [] },
    inventoryReportedAt: null,
    lastSeenAt: null,
    createdAt: new Date("2026-07-01T10:00:00.000Z"),
    revokedAt: null,
    ...overrides,
  };
}

function fakeDb(opts: {
  role?: "owner" | "admin" | "developer" | null;
  devices?: DeviceRow[];
  skills?: SkillState[];
}) {
  const role = opts.role === undefined ? "developer" : opts.role;
  const devices = opts.devices ?? [device()];
  const skills = opts.skills ?? [];
  const captured = {
    insertedDevice: null as Record<string, unknown> | null,
    audit: [] as Record<string, unknown>[],
    update: null as { table: unknown; patch: Record<string, unknown> } | null,
  };

  const handle = {
    query: {
      memberships: { findFirst: async () => (role ? { orgRole: role } : null) },
      profiles: { findFirst: async () => ({ id: actor.id, email: actor.email, name: actor.name }) },
      devices: {
        findFirst: async () => devices.find((row) => row.revokedAt == null) ?? null,
      },
    },
    insert: (table: unknown) => ({
      values: (value: Record<string, unknown>) => {
        if (table === schema.devices) captured.insertedDevice = value;
        if (table === schema.auditLog) captured.audit.push(value);
        return {
          returning: async () => [{ id: "device-new" }],
        };
      },
    }),
    update: (table: unknown) => ({
      set: (patch: Record<string, unknown>) => {
        captured.update = { table, patch };
        return {
          where: async () => undefined,
        };
      },
    }),
    select: () => ({
      from(table: unknown) {
        if (table === schema.devices) {
          return {
            where: () => ({
              orderBy: async () =>
                devices.filter((row) => row.orgId === ORG && row.userId === actor.id && row.revokedAt == null),
            }),
          };
        }
      if (table === schema.skills) {
        return {
          leftJoin: () => ({
              where: async () =>
                skills.map((skill) => ({
                  ...skill,
                  creatorId: skill.creatorId ?? actor.id,
                  scope: skill.scope ?? "org",
                })),
            }),
        };
      }
        return { where: async () => [] };
      },
    }),
  };

  return { database: handle as unknown as Db, captured };
}

describe("device services", () => {
  it("registers a device only for members and stores a token hash", async () => {
    const { database, captured } = fakeDb({});
    const result = await registerDevice({
      actor,
      orgId: ORG,
      apiUrl: "http://127.0.0.1:3001/",
      device: { name: "stan-mac", platform: "darwin", agent_version: "0.0.0" },
      database,
    });

    expect(result).toMatchObject({ device_id: "device-new", org_id: ORG, api_url: "http://127.0.0.1:3001" });
    expect(result.device_token).toMatch(/^cmp_dev_[0-9a-f]{48}$/);
    expect(captured.insertedDevice).toMatchObject({
      orgId: ORG,
      userId: actor.id,
      name: "stan-mac",
      platform: "darwin",
      agentVersion: "0.0.0",
    });
    expect(captured.insertedDevice?.tokenHash).toBe(hash(result.device_token));
    expect(captured.audit[0]).toMatchObject({ action: "device.register", targetType: "device" });
  });

  it("rejects registration for non-members", async () => {
    const { database } = fakeDb({ role: null });
    await expect(registerDevice({ actor, orgId: ORG, apiUrl: "http://api", database })).rejects.toThrow(
      "not a member",
    );
  });

  it("resolves only live device tokens whose owner is still a member", async () => {
    const raw = "cmp_dev_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const { database } = fakeDb({ devices: [device({ tokenHash: hash(raw) })] });
    await expect(resolveDeviceToken(raw, database)).resolves.toMatchObject({
      orgId: ORG,
      deviceId: "device-1",
      actor: { id: actor.id },
    });
    await expect(resolveDeviceToken("cmp_pat_not-a-device", database)).resolves.toBeNull();
    const exMember = fakeDb({ role: null, devices: [device({ tokenHash: hash(raw) })] });
    await expect(resolveDeviceToken(raw, exMember.database)).resolves.toBeNull();
    const revoked = fakeDb({ devices: [device({ tokenHash: hash(raw), revokedAt: new Date() })] });
    await expect(resolveDeviceToken(raw, revoked.database)).resolves.toBeNull();
  });

  it("records a heartbeat and returns catalog state keyed by resolved skill id", async () => {
    const { database, captured } = fakeDb({
      skills: [
        { id: ALPHA_ID, slug: "renamed-alpha", currentVersion: "2.0.0", archivedAt: null },
        { id: BETA_ID, slug: "beta", currentVersion: "1.0.0", archivedAt: new Date("2026-07-01T00:00:00.000Z") },
      ],
    });
    const resolved: ResolvedDeviceToken = { actor, orgId: ORG, deviceId: "device-1" };
    const response = await recordHeartbeat({
      device: resolved,
      database,
      heartbeat: {
        agent_version: "0.0.0",
        platform: "darwin",
        hostname: "stan-mac",
        tools: ["codex"],
        companion_skill_version: "1.18.0",
        inventory: {
          lockfileVersion: 2,
          tools: [],
          skills: [
            {
              slug: "old-alpha",
              skillId: ALPHA_ID,
              version: "1.0.0",
              targets: [{ tool: "codex", scope: "user", path: "/tmp/alpha", version: "1.0.0" }],
            },
            { slug: "beta", skillId: "not-a-uuid", version: "1.0.0", targets: [] },
          ],
        },
      },
    });

    expect(captured.update?.table).toBe(schema.devices);
    expect(captured.update?.patch).toMatchObject({
      name: "stan-mac",
      platform: "darwin",
      agentVersion: "0.0.0",
    });
    expect(captured.update?.patch.inventory).toMatchObject({
      tools: ["codex"],
      companionSkillVersion: "1.18.0",
    });
    expect(response.skills[ALPHA_ID]).toEqual({
      slug: "renamed-alpha",
      current_version: "2.0.0",
      archived: false,
    });
    expect(response.skills[BETA_ID]).toEqual({
      slug: "beta",
      current_version: "1.0.0",
      archived: true,
    });
  });

  it("lists only the caller's active devices and maps ambiguous inventory deterministically", async () => {
    const { database } = fakeDb({
      devices: [
        device({
          id: "device-own",
          inventory: {
            tools: ["codex"],
            companionSkillVersion: "1.18.0",
            skills: [
              {
                slug: "old-alpha",
                skillId: ALPHA_ID,
                version: "1.0.0",
                targets: [{ tool: "codex", scope: "user", path: "/tmp/alpha", version: "1.0.0" }],
              },
              { slug: "beta", skillId: "unknown-id", version: "1.0.0", targets: [] },
              { slug: "missing", version: "1.0.0", targets: [] },
            ],
          },
          lastSeenAt: new Date("2026-07-06T10:20:00.000Z"),
        }),
        device({ id: "device-other-user", userId: other.id }),
        device({ id: "device-other-org", orgId: OTHER_ORG }),
        device({ id: "device-revoked", revokedAt: new Date() }),
      ],
      skills: [
        { id: ALPHA_ID, slug: "renamed-alpha", currentVersion: "2.0.0", archivedAt: null },
        { id: BETA_ID, slug: "beta", currentVersion: "1.0.0", archivedAt: new Date("2026-07-01T00:00:00.000Z") },
      ],
    });

    const rows = await listDevices({
      actor,
      orgId: ORG,
      database,
      now: new Date("2026-07-06T10:30:00.000Z"),
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe("device-own");
    expect(rows[0]!.online).toBe(true);
    expect(rows[0]!.companion_skill_version).toBe("1.18.0");
    expect(rows[0]!.inventory_skills.map((row) => row.slug)).toEqual(["old-alpha", "beta", "missing"]);
    expect(rows[0]!.inventory_skills[0]).toMatchObject({
      resolved_skill_id: ALPHA_ID,
      resolved_slug: "renamed-alpha",
      current_version: "2.0.0",
      outdated: true,
      managed: true,
    });
    expect(rows[0]!.inventory_skills[1]).toMatchObject({
      resolved_skill_id: BETA_ID,
      resolved_slug: "beta",
      archived: true,
      outdated: false,
      managed: true,
    });
    expect(rows[0]!.inventory_skills[2]).toMatchObject({
      resolved_skill_id: null,
      resolved_slug: null,
      outdated: false,
      managed: false,
    });
  });

  it("does not resolve another member's personal skill from reported inventory", async () => {
    const privateId = "33333333-3333-4333-8333-333333333333";
    const { database } = fakeDb({
      devices: [
        device({
          id: "device-own",
          inventory: {
            skills: [
              { slug: "private-by-id", skillId: privateId, version: "1.0.0", targets: [] },
              { slug: "private-by-slug", version: "1.0.0", targets: [] },
            ],
          },
          lastSeenAt: new Date("2026-07-06T10:20:00.000Z"),
        }),
      ],
      skills: [
        {
          id: privateId,
          slug: "private-by-id",
          currentVersion: "9.0.0",
          archivedAt: null,
          creatorId: other.id,
          scope: "personal",
        },
        {
          id: "44444444-4444-4444-8444-444444444444",
          slug: "private-by-slug",
          currentVersion: "9.0.0",
          archivedAt: null,
          creatorId: other.id,
          scope: "personal",
        },
      ],
    });

    const rows = await listDevices({
      actor,
      orgId: ORG,
      database,
      now: new Date("2026-07-06T10:30:00.000Z"),
    });

    expect(rows[0]!.inventory_skills).toHaveLength(2);
    expect(rows[0]!.inventory_skills.every((skill) => !skill.managed)).toBe(true);
    expect(rows[0]!.inventory_skills.map((skill) => skill.resolved_skill_id)).toEqual([null, null]);
    expect(rows[0]!.inventory_skills.map((skill) => skill.current_version)).toEqual([null, null]);
  });

  it("revokes only the owner's device and audits the action", async () => {
    const { database, captured } = fakeDb({ devices: [device({ id: "device-own" })] });
    await revokeDevice({ actor, orgId: ORG, deviceId: "device-own", database });
    expect(captured.update).toMatchObject({ table: schema.devices });
    expect(captured.update?.patch.revokedAt).toBeInstanceOf(Date);
    expect(captured.audit[0]).toMatchObject({ action: "device.revoke", targetId: "device-own" });
  });
});
