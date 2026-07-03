import { describe, expect, it } from "vitest";
import { agentChatHref, agentsRouteHref, agentsRouteKey, parseAgentsRoute, type AgentsRoute } from "./route";

describe("parseAgentsRoute", () => {
  it("defaults to the mine fleet list", () => {
    expect(parseAgentsRoute(null)).toEqual({ lib: "mine", kind: "list" });
    expect(parseAgentsRoute({})).toEqual({ lib: "mine", kind: "list" });
    expect(parseAgentsRoute("")).toEqual({ lib: "mine", kind: "list" });
  });

  it("parses library + label list views", () => {
    expect(parseAgentsRoute("?lib=org")).toEqual({ lib: "org", kind: "list" });
    expect(parseAgentsRoute("?lib=org&label=Monka")).toEqual({ lib: "org", kind: "list", label: "Monka" });
    expect(parseAgentsRoute({ label: "Ops" })).toEqual({ lib: "mine", kind: "list", label: "Ops" });
  });

  it("parses create / detail / update views", () => {
    expect(parseAgentsRoute("?view=new")).toEqual({ lib: "mine", kind: "create" });
    expect(parseAgentsRoute("?lib=org&view=new")).toEqual({ lib: "org", kind: "create" });
    expect(parseAgentsRoute("?agent=monka-support")).toEqual({ lib: "mine", kind: "detail", agent: "monka-support" });
    expect(parseAgentsRoute("?view=update&skill=meeting-digest")).toEqual({
      lib: "mine",
      kind: "update",
      skill: "meeting-digest",
    });
  });

  it("an open agent wins over other views (refresh-safe detail)", () => {
    expect(parseAgentsRoute("?view=new&agent=x")).toEqual({ lib: "mine", kind: "detail", agent: "x" });
  });

  it("update without a skill falls back to the list", () => {
    expect(parseAgentsRoute("?view=update")).toEqual({ lib: "mine", kind: "list" });
  });

  it("unknown views fall back to the list", () => {
    expect(parseAgentsRoute("?view=bogus")).toEqual({ lib: "mine", kind: "list" });
  });

  it("accepts Next-style searchParams records with array values", () => {
    expect(parseAgentsRoute({ lib: ["org"], agent: ["a-1", "a-2"] })).toEqual({
      lib: "org",
      kind: "detail",
      agent: "a-1",
    });
  });
});

describe("agentsRouteHref / parse round-trips", () => {
  const routes: AgentsRoute[] = [
    { lib: "mine", kind: "list" },
    { lib: "org", kind: "list" },
    { lib: "org", kind: "list", label: "Coup de Pâtes" },
    { lib: "mine", kind: "create" },
    { lib: "org", kind: "detail", agent: "cdp-catalogue-check" },
    { lib: "mine", kind: "update", skill: "meeting-digest" },
  ];

  it.each(routes.map((route) => [agentsRouteHref(route), route] as const))("%s round-trips", (href, route) => {
    expect(parseAgentsRoute(href)).toEqual(route);
  });

  it("emits the bare path for the default route", () => {
    expect(agentsRouteHref({ lib: "mine", kind: "list" })).toBe("/agents");
  });

  it("URL-encodes labels and slugs", () => {
    expect(agentsRouteHref({ lib: "org", kind: "list", label: "Coup de Pâtes" })).toContain("label=Coup%20de%20P");
  });
});

describe("agentsRouteKey", () => {
  it("distinguishes every screen", () => {
    const keys = new Set(
      [
        { lib: "mine", kind: "list" } as AgentsRoute,
        { lib: "org", kind: "list" } as AgentsRoute,
        { lib: "mine", kind: "list", label: "Ops" } as AgentsRoute,
        { lib: "mine", kind: "create" } as AgentsRoute,
        { lib: "mine", kind: "detail", agent: "a" } as AgentsRoute,
        { lib: "mine", kind: "update", skill: "s" } as AgentsRoute,
      ].map(agentsRouteKey),
    );
    expect(keys.size).toBe(6);
  });
});

describe("agentChatHref", () => {
  it("targets the standalone chat page", () => {
    expect(agentChatHref("monka-support")).toBe("/agents/monka-support/chat");
  });
});
