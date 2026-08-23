import { describe, expect, it } from "vitest";

import { exchangeGoogleSession } from "./google-sign-in";
import { ApiError, type WhoAmI } from "./types";

const existingIdentity: WhoAmI = {
  userId: "user-1",
  email: "member@acme.test",
  name: "Ada",
  onboarded: true,
  needsOnboarding: false,
  org: { org_id: "org-1", name: "Acme", slug: "acme" },
};

function port(input: {
  started?: boolean;
  cookie?: string;
  identity?: WhoAmI;
  failure?: Error;
}) {
  let clearCount = 0;
  return {
    auth: {
      clear: async () => { clearCount += 1; },
      start: async () => ({ ok: input.started ?? true }),
      getCookie: () => input.cookie ?? "workspace.session_token=token",
      identify: async () => {
        if (input.failure) throw input.failure;
        return input.identity ?? existingIdentity;
      },
    },
    cleared: () => clearCount,
  };
}

describe("Google mobile session exchange", () => {
  it("adopts an existing account", async () => {
    const fixture = port({});
    const outcome = await exchangeGoogleSession(fixture.auth);

    expect(outcome.session).toMatchObject({ orgId: "org-1", needsOnboarding: false });
    expect(outcome.error).toBeNull();
    expect(fixture.cleared()).toBe(1);
  });

  it("routes a new account to onboarding", async () => {
    const fixture = port({
      identity: { ...existingIdentity, onboarded: false, needsOnboarding: true, org: null },
    });
    const outcome = await exchangeGoogleSession(fixture.auth);

    expect(outcome.session).toMatchObject({ orgId: null, needsOnboarding: true });
  });

  it("reports an unavailable provider and cleans OAuth state", async () => {
    const fixture = port({ started: false });
    const outcome = await exchangeGoogleSession(fixture.auth);

    expect(outcome.reason).toBe("google");
    expect(fixture.cleared()).toBe(2);
  });

  it("treats a missing callback cookie as cancellation", async () => {
    const fixture = port({ cookie: "" });
    const outcome = await exchangeGoogleSession(fixture.auth);

    expect(outcome.reason).toBe("cancelled");
    expect(fixture.cleared()).toBe(2);
  });

  it("distinguishes network failure from an invalid callback", async () => {
    const network = await exchangeGoogleSession(port({ failure: new ApiError(0, null, "offline") }).auth);
    const invalid = await exchangeGoogleSession(port({ failure: new ApiError(401, null, "invalid") }).auth);

    expect(network.reason).toBe("network");
    expect(invalid.reason).toBe("callback");
  });

  it("cleans OAuth state when the browser aborts", async () => {
    const fixture = port({ failure: new Error("browser closed") });
    const outcome = await exchangeGoogleSession(fixture.auth);

    expect(outcome.reason).toBe("cancelled");
    expect(fixture.cleared()).toBe(2);
  });
});
