import { describe, expect, it } from "vitest";
import {
  parseSkillsRoute,
  skillsRouteHref,
  skillsRouteSource,
  skillsRouteWithSkill,
  skillsRouteWithoutSkill,
} from "./route";

describe("skills route helpers", () => {
  it("parses the canonical workspace skills route", () => {
    expect(parseSkillsRoute("")).toEqual({ kind: "all" });
    expect(parseSkillsRoute(new URLSearchParams())).toEqual({ kind: "all" });
  });

  it("parses My skills", () => {
    expect(parseSkillsRoute("view=mine")).toEqual({ kind: "mine" });
    expect(parseSkillsRoute("view=mine&skill=incident-summary")).toEqual({
      kind: "mine",
      skill: "incident-summary",
    });
  });

  it("parses Companion skills", () => {
    expect(parseSkillsRoute("?view=local")).toEqual({ kind: "local" });
    expect(parseSkillsRoute("?view=local&skill=ignored")).toEqual({ kind: "local" });
  });

  it("parses team skills", () => {
    expect(parseSkillsRoute("view=team&team=platform")).toEqual({ kind: "team", team: "platform" });
    expect(parseSkillsRoute("view=team&team=platform&skill=incident-summary")).toEqual({
      kind: "team",
      team: "platform",
      skill: "incident-summary",
    });
    expect(parseSkillsRoute({ view: "team", team: "platform" })).toEqual({ kind: "team", team: "platform" });
    expect(parseSkillsRoute({ view: ["team"], team: ["platform"] })).toEqual({ kind: "team", team: "platform" });
  });

  it("falls back to workspace skills when a team route has no team", () => {
    expect(parseSkillsRoute("view=team")).toEqual({ kind: "all" });
    expect(parseSkillsRoute("view=team&skill=incident-summary")).toEqual({
      kind: "all",
      skill: "incident-summary",
    });
    expect(parseSkillsRoute({ view: "team", team: undefined })).toEqual({ kind: "all" });
  });

  it("falls back to workspace skills for unknown views", () => {
    expect(parseSkillsRoute("view=unknown")).toEqual({ kind: "all" });
    expect(parseSkillsRoute("view=unknown&skill=incident-summary")).toEqual({
      kind: "all",
      skill: "incident-summary",
    });
  });

  it("parses skill detail routes", () => {
    expect(parseSkillsRoute("skill=incident-summary")).toEqual({ kind: "all", skill: "incident-summary" });
    expect(parseSkillsRoute("skill=")).toEqual({ kind: "all" });
    expect(parseSkillsRoute("view=archived&skill=old-skill")).toEqual({
      kind: "archived",
      skill: "old-skill",
    });
  });

  it("detects whether a route was explicitly encoded", () => {
    expect(skillsRouteSource("")).toBe("default");
    expect(skillsRouteSource({})).toBe("default");
    expect(skillsRouteSource("skill=incident-summary")).toBe("explicit");
    expect(skillsRouteSource("view=unknown")).toBe("explicit");
    expect(skillsRouteSource({ view: ["team"], team: ["platform"] })).toBe("explicit");
  });

  it("builds canonical route URLs", () => {
    expect(skillsRouteHref({ kind: "all" })).toBe("/skills");
    expect(skillsRouteHref({ kind: "mine" })).toBe("/skills?view=mine");
    expect(skillsRouteHref({ kind: "local" })).toBe("/skills?view=local");
    expect(skillsRouteHref({ kind: "all", skill: "incident-summary" })).toBe(
      "/skills?skill=incident-summary",
    );
    expect(skillsRouteHref({ kind: "mine", skill: "incident-summary" })).toBe(
      "/skills?view=mine&skill=incident-summary",
    );
    expect(skillsRouteHref({ kind: "archived", skill: "old skill" })).toBe(
      "/skills?view=archived&skill=old%20skill",
    );
    expect(skillsRouteHref({ kind: "team", team: "platform team" })).toBe(
      "/skills?view=team&team=platform%20team",
    );
    expect(skillsRouteHref({ kind: "team", team: "platform team", skill: "incident-summary" })).toBe(
      "/skills?view=team&team=platform%20team&skill=incident-summary",
    );
    expect(parseSkillsRoute(skillsRouteHref({ kind: "team", team: "platform team" }))).toEqual({
      kind: "team",
      team: "platform team",
    });
  });

  it("adds and removes skill detail from routes", () => {
    expect(skillsRouteWithSkill({ kind: "all" }, "incident-summary")).toEqual({
      kind: "all",
      skill: "incident-summary",
    });
    expect(skillsRouteWithSkill({ kind: "team", team: "platform" }, "incident-summary")).toEqual({
      kind: "team",
      team: "platform",
      skill: "incident-summary",
    });
    expect(skillsRouteWithSkill({ kind: "local" }, "incident-summary")).toEqual({
      kind: "all",
      skill: "incident-summary",
    });
    expect(skillsRouteWithoutSkill({ kind: "archived", skill: "old-skill" })).toEqual({
      kind: "archived",
    });
  });
});
