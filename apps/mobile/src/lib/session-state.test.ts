import { describe, expect, it } from "vitest";

import {
  clearSessionAuthorities,
  isRevokedSessionStatus,
  onboardSession,
  parseStoredSession,
  profileInitials,
  renameSessionUser,
  sameSessionAuthority,
  sessionFromIdentity,
  sessionRedirect,
} from "./session-state";

const existingSession = {
  cookie: "better-auth.session_token=token",
  orgId: "org-1",
  needsOnboarding: false,
  user: { id: "user-1", email: "user@example.com", name: "Ada" },
};

describe("native session state", () => {
  it("restores the pre-Google session shape without logging existing users out", () => {
    const legacy = JSON.stringify({
      cookie: existingSession.cookie,
      orgId: existingSession.orgId,
      user: { id: existingSession.user.id, email: existingSession.user.email },
    });

    expect(parseStoredSession(legacy)).toEqual({
      ...existingSession,
      user: { ...existingSession.user, name: null },
    });
  });

  it("fails closed for malformed persisted bearer state", () => {
    expect(() => parseStoredSession(JSON.stringify({
      cookie: "",
      orgId: "org-1",
      user: { id: "user-1", email: "user@example.com" },
    }))).toThrow("malformed stored session");
  });

  it("marks a new Google account for onboarding until an organization is selected", () => {
    const session = sessionFromIdentity("better-auth.session_token=token", {
      userId: "user-2",
      email: "new@example.com",
      name: "New User",
      org: null,
      onboarded: false,
      needsOnboarding: true,
    });

    expect(session.needsOnboarding).toBe(true);
    expect(onboardSession(session, "org-2")).toMatchObject({ orgId: "org-2", needsOnboarding: false });
  });

  it("recognizes authoritative session revocation", () => {
    expect(isRevokedSessionStatus(401)).toBe(true);
    expect(isRevokedSessionStatus(403)).toBe(false);
    expect(isRevokedSessionStatus(500)).toBe(false);
  });

  it("updates the cached profile name without changing session authority", () => {
    expect(renameSessionUser(existingSession, "Ada Lovelace")).toEqual({
      ...existingSession,
      user: { ...existingSession.user, name: "Ada Lovelace" },
    });
  });

  it("recognizes the same signed-in authority across identity refreshes", () => {
    expect(sameSessionAuthority(
      { ...existingSession, user: { ...existingSession.user, name: "Ada Lovelace" } },
      existingSession,
    )).toBe(true);
    expect(sameSessionAuthority({ ...existingSession, cookie: "different" }, existingSession)).toBe(false);
    expect(sameSessionAuthority(null, existingSession)).toBe(false);
  });

  it("matches the canonical first-two-token profile initials", () => {
    expect(profileInitials("Ada Byron Lovelace")).toBe("AB");
    expect(profileInitials("ada.lovelace@example.com")).toBe("AL");
  });

  it("cleans both persisted authorities on logout even when one store fails", async () => {
    const cleaned: string[] = [];
    await clearSessionAuthorities(
      async () => {
        cleaned.push("session");
        throw new Error("keychain locked");
      },
      async () => { cleaned.push("google"); },
    );

    expect(cleaned).toEqual(["session", "google"]);
  });
});

describe("native session routing", () => {
  it("keeps signed-out users on login and protects app and onboarding routes", () => {
    expect(sessionRedirect(null, "login")).toBeNull();
    expect(sessionRedirect(null, "app")).toBe("/(auth)/login");
    expect(sessionRedirect(null, "onboarding")).toBe("/(auth)/login");
  });

  it("routes new accounts only to onboarding", () => {
    const pending = { ...existingSession, orgId: null, needsOnboarding: true };
    expect(sessionRedirect(pending, "login")).toBe("/(auth)/onboarding");
    expect(sessionRedirect(pending, "onboarding")).toBeNull();
  });

  it("routes onboarded accounts to the app", () => {
    expect(sessionRedirect(existingSession, "login")).toBe("/(app)");
    expect(sessionRedirect(existingSession, "app")).toBeNull();
  });
});
