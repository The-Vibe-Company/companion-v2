import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Product promise:
 * The shared Skills and Secrets sidebars expose Companions only to authenticated users who pass the
 * same master-flag and email-domain gate as the Companions route.
 *
 * Regression caught:
 * Either server page could accidentally pass the global flag directly and reveal navigation to a
 * user whose direct Companions route and API access are denied.
 *
 * Why this test is route-level:
 * The access decision is made by each Next.js server page before it constructs the app shell.
 *
 * Failure proof:
 * Replacing either `companionsAvailableToUser` call with `companionsEnabled` makes the denied and
 * missing-email assertions receive `true`.
 */

const authMocks = vi.hoisted(() => ({ loadServerAuth: vi.fn() }));
const apiMocks = vi.hoisted(() => ({ serverApiFetch: vi.fn() }));
const orgMocks = vi.hoisted(() => ({ loadOrgContext: vi.fn() }));
const navigationMocks = vi.hoisted(() => ({ redirect: vi.fn() }));

vi.mock("@/lib/serverAuth", () => authMocks);
vi.mock("@/lib/apiServer", () => apiMocks);
vi.mock("@/lib/currentOrg", () => orgMocks);
vi.mock("next/navigation", () => navigationMocks);
vi.mock("@/components/skills/SkillsApp", () => ({ SkillsApp: () => null }));
vi.mock("@/components/secrets/SecretsApp", () => ({ SecretsApp: () => null }));
vi.mock("@/components/org/WorkspaceLoadError", () => ({
  AuthUnavailable: () => null,
  WorkspaceLoadError: () => null,
}));
vi.mock("@/components/skills/sidebarTree", () => ({ deriveTreeRows: vi.fn(() => []) }));
vi.mock("@/components/skills/route", () => ({
  parseSkillsRoute: vi.fn(() => ({})),
  skillsRouteSource: vi.fn(() => "default"),
}));
vi.mock("@/lib/types", () => ({ mapSkill: vi.fn() }));

import SecretsPage from "./secrets/page";
import SkillsPage from "./skills/page";

const originalEnabled = process.env.COMPANION_COMPANIONS_ENABLED;
const originalAllowlist = process.env.COMPANION_COMPANIONS_ALLOWED_EMAIL_DOMAINS;

function responseFor(path: string): unknown {
  if (path === "/v1/billing") return { entitlements: { personalSkills: false } };
  if (path === "/v1/orgs/current/settings") return { members: [] };
  if (path === "/v1/skill-filter-preferences") return {};
  if (path === "/v1/getting-started") return null;
  if (path.includes("labels")) return { tree: [], flat: [] };
  return [];
}

describe("Companions sidebar access", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.COMPANION_COMPANIONS_ENABLED = "true";
    process.env.COMPANION_COMPANIONS_ALLOWED_EMAIL_DOMAINS = "thevibecompany.co";
    orgMocks.loadOrgContext.mockResolvedValue({
      orgs: [{ id: "org-1", name: "Acme" }],
      current: { id: "org-1", name: "Acme" },
    });
    apiMocks.serverApiFetch.mockImplementation((path: string) =>
      Promise.resolve(responseFor(path)),
    );
  });

  afterEach(() => {
    if (originalEnabled === undefined) delete process.env.COMPANION_COMPANIONS_ENABLED;
    else process.env.COMPANION_COMPANIONS_ENABLED = originalEnabled;
    if (originalAllowlist === undefined) {
      delete process.env.COMPANION_COMPANIONS_ALLOWED_EMAIL_DOMAINS;
    } else {
      process.env.COMPANION_COMPANIONS_ALLOWED_EMAIL_DOMAINS = originalAllowlist;
    }
  });

  it.each([
    ["an allowlisted email", "User@TheVibeCompany.Co", true],
    ["a non-allowlisted email", "user@example.com", false],
    ["a missing email", undefined, false],
  ])("passes the correct gate for %s", async (_case, email, expected) => {
    authMocks.loadServerAuth.mockResolvedValue({
      status: "authenticated",
      user: {
        userId: "user-1",
        email,
        name: "User",
      },
    });

    const skills = await SkillsPage({ searchParams: Promise.resolve({}) });
    const secrets = await SecretsPage({ searchParams: Promise.resolve({}) });

    expect(skills).toMatchObject({ props: { companionsEnabled: expected } });
    expect(secrets).toMatchObject({ props: { companionsEnabled: expected } });
  });
});
