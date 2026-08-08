import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Product promise:
 * The homepage sends authenticated members to Skills and keeps the public landing page for signed-out visitors.
 *
 * Regression caught:
 * A one-off session request could route internal members to Projects or render the landing page while auth was unresolved.
 *
 * Why this test is route-level:
 * The risk is the server route's choice between redirecting and rendering, not the landing page's component behavior.
 *
 * Failure proof:
 * Restoring the direct whoami fallback or rendering before loadServerAuth settles fails the redirect or pending assertion.
 */

const authMocks = vi.hoisted(() => ({ loadServerAuth: vi.fn() }));
const navigationMocks = vi.hoisted(() => ({ redirect: vi.fn() }));
const componentMocks = vi.hoisted(() => ({
  AuthUnavailable: () => null,
  LandingPage: () => null,
}));

vi.mock("@/lib/serverAuth", () => authMocks);
vi.mock("next/navigation", () => navigationMocks);
vi.mock("@/components/org/WorkspaceLoadError", () => ({ AuthUnavailable: componentMocks.AuthUnavailable }));
vi.mock("@/components/landing/LandingPage", () => ({ LandingPage: componentMocks.LandingPage }));

import Home from "./page";

describe("homepage auth routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    navigationMocks.redirect.mockImplementation((path: string) => {
      throw new Error(`redirect:${path}`);
    });
  });

  it("redirects every authenticated member to Skills", async () => {
    authMocks.loadServerAuth.mockResolvedValue({
      status: "authenticated",
      user: { email: "admin@thevibecompany.co" },
    });

    await expect(Home()).rejects.toThrow("redirect:/skills");
    expect(navigationMocks.redirect).toHaveBeenCalledWith("/skills");
  });

  it("keeps the existing landing page for unauthenticated visitors", async () => {
    authMocks.loadServerAuth.mockResolvedValue({ status: "unauthenticated" });

    const result = await Home();

    expect(result).toMatchObject({ type: componentMocks.LandingPage });
    expect(navigationMocks.redirect).not.toHaveBeenCalled();
  });

  it("does not render or redirect while authentication is still loading", async () => {
    let resolveAuth!: (value: { status: "unauthenticated" }) => void;
    authMocks.loadServerAuth.mockReturnValue(
      new Promise((resolve) => {
        resolveAuth = resolve;
      }),
    );
    let settled = false;
    const result = Home().then((value) => {
      settled = true;
      return value;
    });

    await Promise.resolve();

    expect(settled).toBe(false);
    expect(navigationMocks.redirect).not.toHaveBeenCalled();

    resolveAuth({ status: "unauthenticated" });
    await expect(result).resolves.toMatchObject({ type: componentMocks.LandingPage });
  });

  it("shows the existing recoverable state when the session cannot be verified", async () => {
    authMocks.loadServerAuth.mockResolvedValue({ status: "unavailable" });

    await expect(Home()).resolves.toMatchObject({ type: componentMocks.AuthUnavailable });
    expect(navigationMocks.redirect).not.toHaveBeenCalled();
  });
});
