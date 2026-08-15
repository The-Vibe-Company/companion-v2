import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Product promise:
 * The Companions route stays absent when the master flag is off and remains invisible to signed-in
 * users outside the required email-domain allowlist.
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
const apiMocks = vi.hoisted(() => ({ serverApiFetch: vi.fn() }));

vi.mock("@/lib/serverAuth", () => authMocks);
vi.mock("@/lib/currentOrg", () => orgMocks);
vi.mock("next/navigation", () => navigationMocks);
vi.mock("@/components/companions/CompanionsApp", () => ({ CompanionsApp: () => null }));
vi.mock("@/components/org/WorkspaceLoadError", () => ({
  AuthUnavailable: () => null,
  WorkspaceLoadError: () => null,
}));
vi.mock("@/lib/apiServer", () => apiMocks);

import CompanionsPage from "./page";
import CompanionsLoading from "./loading";

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

  it("returns not found before authentication when the allowlist is empty", async () => {
    process.env.COMPANION_COMPANIONS_ENABLED = "true";
    delete process.env.COMPANION_COMPANIONS_ALLOWED_EMAIL_DOMAINS;

    await expect(CompanionsPage({ searchParams: Promise.resolve({}) })).rejects.toThrow(
      "not-found",
    );
    expect(authMocks.loadServerAuth).not.toHaveBeenCalled();
  });

  it.each([
    ["a non-allowlisted user", "user@example.com"],
    ["a user with no email", undefined],
  ])("returns not found before workspace loading for %s", async (_case, email) => {
    process.env.COMPANION_COMPANIONS_ENABLED = "true";
    process.env.COMPANION_COMPANIONS_ALLOWED_EMAIL_DOMAINS = "thevibecompany.co";
    authMocks.loadServerAuth.mockResolvedValue({
      status: "authenticated",
      user: { email },
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

  it("keeps the streamed loading fallback generic until access is resolved", () => {
    const markup = renderToStaticMarkup(CompanionsLoading());

    expect(markup).toContain("Loading workspace");
    expect(markup).not.toContain("Companions");
    expect(markup).not.toContain("Companion");
  });

  it("does not block the list route on the external provider catalog", async () => {
    process.env.COMPANION_COMPANIONS_ENABLED = "true";
    process.env.COMPANION_COMPANIONS_ALLOWED_EMAIL_DOMAINS = "thevibecompany.co";
    authMocks.loadServerAuth.mockResolvedValue({
      status: "authenticated",
      user: {
        userId: "user-1",
        email: "user@thevibecompany.co",
        name: "Ada",
        needsOnboarding: false,
      },
    });
    orgMocks.loadOrgContext.mockResolvedValue({
      orgs: [{
        id: "org-1",
        name: "Acme",
        slug: "acme",
        kind: "team",
        myRole: "owner",
        color: null,
        logoUrl: null,
      }],
      current: {
        id: "org-1",
        name: "Acme",
        slug: "acme",
        kind: "team",
        myRole: "owner",
        color: null,
        logoUrl: null,
      },
    });
    apiMocks.serverApiFetch.mockImplementation(async (path: string) => {
      if (path === "/v1/companions") return { companions: [] };
      if (path === "/v1/companion-plugins") return { accounts: [] };
      if (path === "/v1/skills?lib=mine") {
        return [{ id: "personal-1", slug: "my-private-skill" }];
      }
      if (path === "/v1/skills?lib=org") {
        return [{ id: "org-skill-1", slug: "shared-skill" }];
      }
      return [];
    });

    const element = await CompanionsPage({ searchParams: Promise.resolve({}) }) as {
      props: { initialProviders: unknown; skills: Array<{ id: string; slug: string }> };
    };
    const requestedPaths = apiMocks.serverApiFetch.mock.calls.map(([path]) => path);

    expect(requestedPaths).not.toContain("/v1/companion-providers");
    expect(requestedPaths).not.toContain("/v1/personal-labels");
    expect(requestedPaths).not.toContain("/v1/labels");
    expect(requestedPaths).not.toContain("/v1/local-skills");
    expect(requestedPaths).not.toContain("/v1/skills?lib=mine&archived=true");
    expect(requestedPaths).not.toContain("/v1/skills?lib=org&archived=true");
    expect(requestedPaths).not.toContain("/v1/skills?lib=accessible");
    expect(requestedPaths).toContain("/v1/skills?lib=mine");
    expect(requestedPaths).toContain("/v1/skills?lib=org");
    expect(element.props.initialProviders).toBeNull();
    expect(element.props.skills).toEqual([
      { id: "personal-1", slug: "my-private-skill" },
      { id: "org-skill-1", slug: "shared-skill" },
    ]);
  });

  it("allows a Viewer to open Companion settings in read-only mode", async () => {
    process.env.COMPANION_COMPANIONS_ENABLED = "true";
    process.env.COMPANION_COMPANIONS_ALLOWED_EMAIL_DOMAINS = "thevibecompany.co";
    authMocks.loadServerAuth.mockResolvedValue({
      status: "authenticated",
      user: {
        userId: "user-1",
        email: "user@thevibecompany.co",
        name: "Ada",
        needsOnboarding: false,
      },
    });
    orgMocks.loadOrgContext.mockResolvedValue({
      orgs: [{
        id: "org-1",
        name: "Acme",
        slug: "acme",
        kind: "team",
        myRole: "developer",
        color: null,
        logoUrl: null,
      }],
      current: {
        id: "org-1",
        name: "Acme",
        slug: "acme",
        kind: "team",
        myRole: "developer",
        color: null,
        logoUrl: null,
      },
    });
    apiMocks.serverApiFetch.mockImplementation(async (path: string) => {
      if (path === "/v1/companions") {
        return { companions: [{ id: "viewer-companion", access: "viewer" }] };
      }
      if (path === "/v1/companion-plugins") return { accounts: [] };
      return [];
    });

    const element = await CompanionsPage({
      searchParams: Promise.resolve({ settings: "viewer-companion" }),
    }) as { props: { initialSettingsCompanionId: string | null } };

    expect(navigationMocks.notFound).not.toHaveBeenCalled();
    expect(element.props.initialSettingsCompanionId).toBe("viewer-companion");
  });
});
