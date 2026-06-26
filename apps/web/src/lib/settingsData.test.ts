import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((path: string) => {
    throw new Error(`redirect:${path}`);
  }),
}));

const serverApiFetch = vi.fn();
const loadOrgContext = vi.fn();

vi.mock("@/lib/apiServer", () => ({ serverApiFetch }));
vi.mock("@/lib/currentOrg", () => ({ loadOrgContext }));

const whoami = {
  userId: "user_1",
  email: "admin@tvc.dev",
  name: "Admin",
};

const current = {
  id: "org_1",
  name: "Acme",
  slug: "acme",
  kind: "team",
  plan: "team",
  myRole: "owner",
  color: null,
  logoUrl: null,
} as const;

describe("parseOrgSettingsResponse", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    serverApiFetch.mockReset();
    loadOrgContext.mockReset();
  });

  it("returns null for malformed iterable fields", async () => {
    const { parseOrgSettingsResponse } = await import("./settingsData");

    expect(parseOrgSettingsResponse({ members: {} })).toBeNull();
    expect(console.error).toHaveBeenCalledWith(
      "Invalid org settings response",
      expect.arrayContaining([
        expect.objectContaining({
          path: "members",
          message: expect.any(String),
        }),
      ]),
    );
  });

  it("builds settings app data from a validated settings response", async () => {
    const { buildSettingsAppData } = await import("./settingsViewModel");

    const data = buildSettingsAppData({
      me: { id: "user_1", name: "Admin", email: "admin@tvc.dev", initials: "A", avatarUrl: null },
      current,
      settings: {
        org: {
          id: "org_1",
          name: "Acme",
          slug: "acme",
          kind: "team",
          plan: "team",
          createdAt: "2025-01-12T00:00:00.000Z",
          domain: "tvc.dev",
          domainAutoJoin: true,
          accessDomains: [{ id: "domain_1", domain: "tvc.dev", createdAt: "2025-01-12T00:00:00.000Z" }],
          color: null,
          logoUrl: null,
        },
        domainJoin: {
          actorDomain: "tvc.dev",
          actorDomainIsPersonal: false,
        },
        members: [
          {
            userId: "user_1",
            role: "owner",
            joined: "2026-06-09T05:00:00.000Z",
            pending: false,
            name: "Admin",
            email: "admin@tvc.dev",
            initials: "A",
            avatarUrl: null,
          },
        ],
        invitations: [
          {
            id: "inv_1",
            email: "new@tvc.dev",
            role: "developer",
            token: "tok_abc",
            status: "pending",
            createdAt: "2026-06-08T05:00:00.000Z",
            expiresAt: "2026-06-15T05:00:00.000Z",
          },
        ],
      },
      tokens: [
        {
          id: "tok_1",
          org_id: "org_1",
          user_id: "user_1",
          name: "Local CLI",
          prefix: "cmp_pat_a3f9",
          scopes: ["skills:read", "skills:write"],
          expires_at: "2026-06-10T05:00:00.000Z",
          last_used_at: null,
          revoked_at: null,
          created_at: "2026-06-01T05:00:00.000Z",
        },
      ],
    });

    expect(data.current.created).toBe("2025-01-12");
    expect(data.current.domain).toBe("tvc.dev");
    expect(data.current.domainAutoJoin).toBe(true);
    expect(data.current.accessDomains).toEqual([{ id: "domain_1", domain: "tvc.dev", createdAt: "2025-01-12" }]);
    expect(data.domainJoin).toEqual({ actorDomain: "tvc.dev", actorDomainIsPersonal: false });
    expect(data.current.members).toEqual([
      expect.objectContaining({ userId: "user_1", role: "owner", joined: "2026-06-09" }),
    ]);
    expect(data.invites).toEqual([
      expect.objectContaining({ id: "inv_1", email: "new@tvc.dev", role: "developer", by: "", token: "tok_abc" }),
    ]);
    expect(data.apiKeys).toEqual([
      expect.objectContaining({ id: "tok_1", name: "Local CLI", scope: "write", last4: "a3f9", lastUsed: "never" }),
    ]);
    expect(data.users.user_1).toEqual({
      id: "user_1",
      name: "Admin",
      email: "admin@tvc.dev",
      initials: "A",
      avatarUrl: null,
    });
  });

  it("makes loadSettingsPageData return null for malformed settings data", async () => {
    const { loadSettingsPageData } = await import("./settingsData");
    serverApiFetch.mockResolvedValueOnce(whoami).mockResolvedValueOnce({ members: {} });
    loadOrgContext.mockResolvedValue({ orgs: [current], current });

    await expect(loadSettingsPageData(Promise.resolve({}))).resolves.toBeNull();
    expect(serverApiFetch).toHaveBeenCalledWith("/v1/orgs/current/settings", {
      headers: { "x-companion-org": "org_1" },
    });
  });
});
