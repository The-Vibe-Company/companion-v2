import { afterEach, describe, expect, it, vi } from "vitest";

import {
  apiUrl,
  configureApi,
  createOnboardingOrg,
  getOnboardingContext,
  joinOnboardingOrg,
} from "./api";

const session = {
  cookie: "better-auth.session_token=token",
  orgId: null,
  needsOnboarding: true,
  user: { id: "user-1", email: "user@acme.test", name: "User" },
};

describe("mobile onboarding API", () => {
  afterEach(() => {
    configureApi(null);
    vi.unstubAllGlobals();
  });

  it("loads domain-matched organizations with the authenticated cookie", async () => {
    configureApi(session);
    const payload = {
      email: "user@acme.test",
      domain: "acme.test",
      is_personal: false,
      matched_orgs: [{ id: "org-1", name: "Acme", domain: "acme.test", member_count: 4 }],
    };
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => Response.json(payload));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getOnboardingContext()).resolves.toEqual(payload);
    expect(fetchMock).toHaveBeenCalledWith(
      `${apiUrl}/v1/onboarding/context`,
      expect.objectContaining({ headers: expect.any(Headers), credentials: "omit" }),
    );
    const request = fetchMock.mock.calls.at(0)?.[1];
    const headers = new Headers(request?.headers);
    expect(headers.get("cookie")).toBe(session.cookie);
  });

  it("retains the session when a context 401 is not confirmed by whoami", async () => {
    const unauthorized = vi.fn();
    configureApi(session, unauthorized);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ error: "database unavailable" }, { status: 401 }))
      .mockResolvedValueOnce(Response.json({ error: "still unavailable" }, { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getOnboardingContext()).rejects.toMatchObject({ status: 401 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(unauthorized).not.toHaveBeenCalled();
  });

  it("clears the session when whoami confirms a context 401", async () => {
    const unauthorized = vi.fn();
    configureApi(session, unauthorized);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ error: "not authenticated" }, { status: 401 }))
      .mockResolvedValueOnce(Response.json({ error: "not authenticated" }, { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getOnboardingContext()).rejects.toMatchObject({ status: 401 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(unauthorized).toHaveBeenCalledOnce();
  });

  it("joins the selected organization", async () => {
    configureApi(session);
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => Response.json({ orgId: "org-1" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(joinOnboardingOrg("org-1")).resolves.toEqual({ orgId: "org-1" });
    const request = fetchMock.mock.calls.at(0)?.[1];
    expect(request?.method).toBe("POST");
    expect(JSON.parse(String(request?.body))).toEqual({ orgId: "org-1" });
  });

  it("creates only the essential workspace fields", async () => {
    configureApi(session);
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => Response.json({ orgId: "org-2" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(createOnboardingOrg("Ada's workspace")).resolves.toEqual({ orgId: "org-2" });
    const request = fetchMock.mock.calls.at(0)?.[1];
    expect(request?.method).toBe("POST");
    expect(JSON.parse(String(request?.body))).toEqual({
      org: { name: "Ada's workspace", autoJoin: false },
      invites: [],
    });
  });
});
