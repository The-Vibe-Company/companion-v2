import { beforeEach, describe, expect, it, vi } from "vitest";

const authMocks = vi.hoisted(() => ({ loadServerAuth: vi.fn() }));
const navigationMocks = vi.hoisted(() => ({ redirect: vi.fn() }));
const componentMocks = vi.hoisted(() => ({
  AuthUnavailable: () => null,
  WorkspaceLoadError: () => null,
  SessionKeepAlive: () => null,
  LoginForm: () => null,
  AcceptInvite: () => null,
  OnboardingFlow: () => null,
}));

vi.mock("./serverAuth", () => authMocks);
vi.mock("next/navigation", () => navigationMocks);
vi.mock("@/components/org/WorkspaceLoadError", () => ({
  AuthUnavailable: componentMocks.AuthUnavailable,
  WorkspaceLoadError: componentMocks.WorkspaceLoadError,
}));
vi.mock("@/components/auth/SessionKeepAlive", () => ({ SessionKeepAlive: componentMocks.SessionKeepAlive }));
vi.mock("@/app/(auth)/login/LoginForm", () => ({ LoginForm: componentMocks.LoginForm }));
vi.mock("@/components/org/AcceptInvite", () => ({ AcceptInvite: componentMocks.AcceptInvite }));
vi.mock("@/components/onboarding/OnboardingFlow", () => ({ OnboardingFlow: componentMocks.OnboardingFlow }));
vi.mock("./apiServer", () => ({ serverApiFetch: vi.fn() }));

import AppLayout from "../app/(app)/layout";
import OnboardingPage from "../app/(app)/onboarding/page";
import LoginPage from "../app/(auth)/login/page";
import JoinPage from "../app/join/[token]/page";

function expectUnavailable(element: unknown) {
  expect(element).toMatchObject({ type: componentMocks.AuthUnavailable });
}

describe("auth route states", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    navigationMocks.redirect.mockImplementation((path: string) => {
      throw new Error(`redirect:${path}`);
    });
  });

  it("shows a recoverable state across protected, onboarding, invitation, and login routes", async () => {
    authMocks.loadServerAuth.mockResolvedValue({ status: "unavailable" });

    expectUnavailable(await AppLayout({ children: null, settings: null }));
    expectUnavailable(await OnboardingPage());
    expectUnavailable(await LoginPage({ searchParams: Promise.resolve({}) }));
    expectUnavailable(await JoinPage({ params: Promise.resolve({ token: "invite-token" }) }));
    expect(navigationMocks.redirect).not.toHaveBeenCalled();
  });

  it("redirects to login only for an authoritative unauthenticated state", async () => {
    authMocks.loadServerAuth.mockResolvedValue({ status: "unauthenticated" });

    await expect(AppLayout({ children: null, settings: null })).rejects.toThrow("redirect:/login");
    await expect(OnboardingPage()).rejects.toThrow("redirect:/login");
    await expect(JoinPage({ params: Promise.resolve({ token: "invite-token" }) })).rejects.toThrow(
      "redirect:/login?next=%2Fjoin%2Finvite-token",
    );
    expect(navigationMocks.redirect).toHaveBeenCalledTimes(3);
  });

  it("does not offer Google login while the API cannot verify an existing session", async () => {
    authMocks.loadServerAuth.mockResolvedValue({ status: "unavailable" });

    const result = await LoginPage({ searchParams: Promise.resolve({ next: "/skills" }) });

    expectUnavailable(result);
    expect(result).not.toMatchObject({ type: componentMocks.LoginForm });
  });
});
