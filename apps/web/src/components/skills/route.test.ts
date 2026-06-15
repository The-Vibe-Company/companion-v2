import { describe, expect, it } from "vitest";
import { parseSkillsRoute, skillsRouteHref, skillsRouteSource } from "./route";

describe("skills route helpers", () => {
  it("parses the canonical workspace skills route", () => {
    expect(parseSkillsRoute("")).toEqual({ kind: "all" });
    expect(parseSkillsRoute(new URLSearchParams())).toEqual({ kind: "all" });
  });

  it("parses My skills", () => {
    expect(parseSkillsRoute("view=mine")).toEqual({ kind: "mine" });
  });

  it("parses Companion skills", () => {
    expect(parseSkillsRoute("?view=local")).toEqual({ kind: "local" });
  });

  it("parses team skills", () => {
    expect(parseSkillsRoute("view=team&team=platform")).toEqual({ kind: "team", team: "platform" });
    expect(parseSkillsRoute({ view: "team", team: "platform" })).toEqual({ kind: "team", team: "platform" });
    expect(parseSkillsRoute({ view: ["team"], team: ["platform"] })).toEqual({ kind: "team", team: "platform" });
  });

  it("falls back to workspace skills when a team route has no team", () => {
    expect(parseSkillsRoute("view=team")).toEqual({ kind: "all" });
    expect(parseSkillsRoute({ view: "team", team: undefined })).toEqual({ kind: "all" });
  });

  it("falls back to workspace skills for unknown views", () => {
    expect(parseSkillsRoute("view=unknown")).toEqual({ kind: "all" });
  });

  it("detects whether a route was explicitly encoded", () => {
    expect(skillsRouteSource("")).toBe("default");
    expect(skillsRouteSource({})).toBe("default");
    expect(skillsRouteSource("view=unknown")).toBe("explicit");
    expect(skillsRouteSource({ view: ["team"], team: ["platform"] })).toBe("explicit");
  });

  it("builds canonical route URLs", () => {
    expect(skillsRouteHref({ kind: "all" })).toBe("/skills");
    expect(skillsRouteHref({ kind: "mine" })).toBe("/skills?view=mine");
    expect(skillsRouteHref({ kind: "local" })).toBe("/skills?view=local");
    expect(skillsRouteHref({ kind: "team", team: "platform team" })).toBe(
      "/skills?view=team&team=platform%20team",
    );
    expect(parseSkillsRoute(skillsRouteHref({ kind: "team", team: "platform team" }))).toEqual({
      kind: "team",
      team: "platform team",
    });
  });
});
