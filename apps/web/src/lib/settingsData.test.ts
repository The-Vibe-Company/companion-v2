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
};

describe("parseOrgSettingsResponse", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    serverApiFetch.mockReset();
    loadOrgContext.mockReset();
  });

  it("returns null for malformed iterable fields", async () => {
    const { parseOrgSettingsResponse } = await import("./settingsData");

    expect(parseOrgSettingsResponse({ members: [], teams: {} })).toBeNull();
    expect(console.error).toHaveBeenCalledWith(
      "Invalid org settings response",
      expect.arrayContaining([
        expect.objectContaining({
          path: "teams",
          message: expect.any(String),
        }),
      ]),
    );
  });

  it("makes loadSettingsPageData return null for malformed settings data", async () => {
    const { loadSettingsPageData } = await import("./settingsData");
    serverApiFetch
      .mockResolvedValueOnce(whoami)
      .mockResolvedValueOnce({ members: [], teams: {} });
    loadOrgContext.mockResolvedValue({ orgs: [current], current });

    await expect(loadSettingsPageData(Promise.resolve({}))).resolves.toBeNull();
    expect(serverApiFetch).toHaveBeenCalledWith("/v1/orgs/current/settings", {
      headers: { "x-companion-org": "org_1" },
    });
  });
});
