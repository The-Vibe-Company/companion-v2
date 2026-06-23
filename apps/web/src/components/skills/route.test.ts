import { describe, expect, it } from "vitest";
import {
  parseSkillsRoute,
  skillsRouteHref,
  skillsRouteKey,
  skillsRouteSource,
  skillsRouteWithSkill,
  skillsRouteWithoutSkill,
} from "./route";

describe("skills route helpers", () => {
  it("parses the canonical workspace skills route", () => {
    expect(parseSkillsRoute("")).toEqual({ kind: "all" });
    expect(parseSkillsRoute(new URLSearchParams())).toEqual({ kind: "all" });
  });

  it("parses Starred", () => {
    expect(parseSkillsRoute("view=starred")).toEqual({ kind: "starred" });
    expect(parseSkillsRoute("view=starred&skill=incident-summary")).toEqual({
      kind: "starred",
      skill: "incident-summary",
    });
  });

  it("parses No-label", () => {
    expect(parseSkillsRoute("view=nolabel")).toEqual({ kind: "nolabel" });
    expect(parseSkillsRoute("view=nolabel&skill=incident-summary")).toEqual({
      kind: "nolabel",
      skill: "incident-summary",
    });
  });

  it("parses Companion skills", () => {
    expect(parseSkillsRoute("?view=local")).toEqual({ kind: "local" });
    expect(parseSkillsRoute("?view=local&skill=ignored")).toEqual({ kind: "local" });
  });

  it("parses label folder routes (including nested slash paths)", () => {
    expect(parseSkillsRoute("view=label&label=marketing")).toEqual({ kind: "label", label: "marketing" });
    expect(parseSkillsRoute("view=label&label=marketing%2Fseo")).toEqual({
      kind: "label",
      label: "marketing/seo",
    });
    expect(parseSkillsRoute("view=label&label=marketing%2Fseo&skill=incident-summary")).toEqual({
      kind: "label",
      label: "marketing/seo",
      skill: "incident-summary",
    });
    expect(parseSkillsRoute({ view: "label", label: "marketing/seo" })).toEqual({
      kind: "label",
      label: "marketing/seo",
    });
    expect(parseSkillsRoute({ view: ["label"], label: ["marketing/seo"] })).toEqual({
      kind: "label",
      label: "marketing/seo",
    });
  });

  it("falls back to workspace skills when a label route has no path", () => {
    expect(parseSkillsRoute("view=label")).toEqual({ kind: "all" });
    expect(parseSkillsRoute("view=label&skill=incident-summary")).toEqual({
      kind: "all",
      skill: "incident-summary",
    });
    expect(parseSkillsRoute({ view: "label", label: undefined })).toEqual({ kind: "all" });
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
    expect(skillsRouteSource({ view: ["label"], label: ["marketing"] })).toBe("explicit");
  });

  it("builds canonical route URLs", () => {
    expect(skillsRouteHref({ kind: "all" })).toBe("/skills");
    expect(skillsRouteHref({ kind: "starred" })).toBe("/skills?view=starred");
    expect(skillsRouteHref({ kind: "nolabel" })).toBe("/skills?view=nolabel");
    expect(skillsRouteHref({ kind: "local" })).toBe("/skills?view=local");
    expect(skillsRouteHref({ kind: "all", skill: "incident-summary" })).toBe(
      "/skills?skill=incident-summary",
    );
    expect(skillsRouteHref({ kind: "starred", skill: "incident-summary" })).toBe(
      "/skills?view=starred&skill=incident-summary",
    );
    expect(skillsRouteHref({ kind: "archived", skill: "old skill" })).toBe(
      "/skills?view=archived&skill=old%20skill",
    );
    expect(skillsRouteHref({ kind: "label", label: "marketing/seo" })).toBe(
      "/skills?view=label&label=marketing%2Fseo",
    );
    expect(skillsRouteHref({ kind: "label", label: "marketing/seo", skill: "incident-summary" })).toBe(
      "/skills?view=label&label=marketing%2Fseo&skill=incident-summary",
    );
  });

  it("round-trips a nested label path (and its open skill) through href + parse", () => {
    expect(parseSkillsRoute(skillsRouteHref({ kind: "label", label: "marketing/seo" }))).toEqual({
      kind: "label",
      label: "marketing/seo",
    });
    expect(
      parseSkillsRoute(skillsRouteHref({ kind: "label", label: "marketing/seo", skill: "incident-summary" })),
    ).toEqual({ kind: "label", label: "marketing/seo", skill: "incident-summary" });
  });

  it("keys routes uniquely per slice + open skill", () => {
    expect(skillsRouteKey({ kind: "all" })).toBe("all");
    expect(skillsRouteKey({ kind: "label", label: "marketing/seo" })).toBe("label:marketing/seo");
    expect(skillsRouteKey({ kind: "label", label: "marketing/seo", skill: "incident-summary" })).toBe(
      "label:marketing/seo:skill:incident-summary",
    );
    expect(skillsRouteKey({ kind: "local" })).toBe("local");
  });

  it("adds and removes skill detail from routes", () => {
    expect(skillsRouteWithSkill({ kind: "all" }, "incident-summary")).toEqual({
      kind: "all",
      skill: "incident-summary",
    });
    expect(skillsRouteWithSkill({ kind: "label", label: "marketing/seo" }, "incident-summary")).toEqual({
      kind: "label",
      label: "marketing/seo",
      skill: "incident-summary",
    });
    expect(skillsRouteWithSkill({ kind: "local" }, "incident-summary")).toEqual({
      kind: "all",
      skill: "incident-summary",
    });
    expect(skillsRouteWithoutSkill({ kind: "archived", skill: "old-skill" })).toEqual({
      kind: "archived",
    });
    expect(skillsRouteWithoutSkill({ kind: "label", label: "marketing/seo", skill: "x" })).toEqual({
      kind: "label",
      label: "marketing/seo",
    });
  });
});
