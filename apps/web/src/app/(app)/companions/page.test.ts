import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Product promise:
 * The Companions route stays absent when the master flag is off and remains invisible to signed-in
 * users outside an optional email-domain allowlist.
 *
 * Regression caught:
 * A server page could expose the Companions shell even though the API rejects the same user.
 *
 * Why this test is route-level:
 * The boundary is the authenticated Next.js route decision before any workspace data is loaded.
 *
 * Failure proof:
 * Removing either feature check makes the denied cases continue to onboarding or workspace loading.
 */

const authMocks = vi.hoisted(() => ({ loadServerAuth: vi.fn() }));
const orgMocks = vi.hoisted(() => ({ loadOrgContext: vi.fn() }));
const navigationMocks = vi.hoisted(() => ({ notFound: vi.fn(), redirect: vi.fn() }));

vi.mock("@/lib/serverAuth", () => authMocks);
vi.mock("@/lib/currentOrg", () => orgMocks);
vi.mock("next/navigation", () => navigationMocks);
vi.mock("@/components/companions/CompanionsApp", () => ({ CompanionsApp: () => null }));
vi.mock("@/components/org/WorkspaceLoadError", () => ({
  AuthUnavailable: () => null,
  WorkspaceLoadError: () => null,
}));
vi.mock("@/components/skills/sidebarTree", () => ({ deriveTreeRows: vi.fn(() => []) }));
vi.mock("@/lib/apiServer", () => ({ serverApiFetch: vi.fn() }));
vi.mock("@/lib/types", () => ({ mapSkill: vi.fn() }));

import CompanionsPage from "./page";

const originalEnabled = process.env.COMPANION_COMPANIONS_ENABLED;
const originalAllowlist = process.env.COMPANION_COMPANIONS_ALLOWED_EMAIL_DOMAINS;

describe("Companions page access gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    navigationMocks.notFound.mockImplementation(() => {
      throw new Error("not-found");
    });
    navigationMocks.redirect.mockImplementation((path: string) => {
      throw new Error(`redirect:${path}`);
    });
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

  it("returns not found before authentication when the master flag is off", async () => {
    delete process.env.COMPANION_COMPANIONS_ENABLED;
    process.env.COMPANION_COMPANIONS_ALLOWED_EMAIL_DOMAINS = "thevibecompany.co";

    await expect(CompanionsPage({ searchParams: Promise.resolve({}) })).rejects.toThrow(
      "not-found",
    );
    expect(authMocks.loadServerAuth).not.toHaveBeenCalled();
  });

  it("returns not found before workspace loading for a non-allowlisted user", async () => {
    process.env.COMPANION_COMPANIONS_ENABLED = "true";
    process.env.COMPANION_COMPANIONS_ALLOWED_EMAIL_DOMAINS = "thevibecompany.co";
    authMocks.loadServerAuth.mockResolvedValue({
      status: "authenticated",
      user: { email: "user@example.com" },
    });

    await expect(CompanionsPage({ searchParams: Promise.resolve({}) })).rejects.toThrow(
      "not-found",
    );
    expect(orgMocks.loadOrgContext).not.toHaveBeenCalled();
  });

  it("allows a case-insensitive domain match through to normal route handling", async () => {
    process.env.COMPANION_COMPANIONS_ENABLED = "true";
    process.env.COMPANION_COMPANIONS_ALLOWED_EMAIL_DOMAINS = "thevibecompany.co";
    authMocks.loadServerAuth.mockResolvedValue({
      status: "authenticated",
      user: { email: "User@TheVibeCompany.Co", needsOnboarding: true },
    });

    await expect(CompanionsPage({ searchParams: Promise.resolve({}) })).rejects.toThrow(
      "redirect:/onboarding",
    );
    expect(navigationMocks.notFound).not.toHaveBeenCalled();
  });
});
