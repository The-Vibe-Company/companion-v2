import { describe, expect, it } from "vitest";
import {
  parseSkillShareTokenPath,
  parseSkillsRoute,
  skillShareHref,
  skillsRouteHref,
  skillsRouteKey,
  skillsRouteLib,
  skillsRouteSource,
  skillsRouteWithSkill,
  skillsRouteWithoutSkill,
} from "./route";

describe("skills route helpers", () => {
  it("parses the canonical default route (My Skills)", () => {
    expect(parseSkillsRoute("")).toEqual({ lib: "mine", kind: "all" });
    expect(parseSkillsRoute(new URLSearchParams())).toEqual({ lib: "mine", kind: "all" });
  });

  it("parses the My-Skills shortcuts", () => {
    expect(parseSkillsRoute("view=starred")).toEqual({ lib: "mine", kind: "starred" });
    expect(parseSkillsRoute("view=installed")).toEqual({ lib: "mine", kind: "installed" });
    expect(parseSkillsRoute("view=starred&skill=incident-summary")).toEqual({
      lib: "mine",
      kind: "starred",
      skill: "incident-summary",
    });
  });

  it("parses the Organization library", () => {
    expect(parseSkillsRoute("lib=org")).toEqual({ lib: "org", kind: "all" });
    expect(parseSkillsRoute("lib=org&skill=brand-linter")).toEqual({ lib: "org", kind: "all", skill: "brand-linter" });
    // starred/installed are mine-only — under org they fall back to org/all.
    expect(parseSkillsRoute("lib=org&view=starred")).toEqual({ lib: "org", kind: "all" });
  });

  it("maps the legacy nolabel view onto My Skills", () => {
    expect(parseSkillsRoute("view=nolabel")).toEqual({ lib: "mine", kind: "all" });
  });

  it("parses Companion (local) skills, library-independent", () => {
    expect(parseSkillsRoute("?view=local")).toEqual({ kind: "local" });
    expect(parseSkillsRoute("?view=companion")).toEqual({ kind: "local" });
    expect(parseSkillsRoute("?view=local&skill=ignored")).toEqual({ kind: "local" });
  });

  it("parses personal and org label folder routes (including nested slash paths)", () => {
    expect(parseSkillsRoute("view=label&label=drafts")).toEqual({ lib: "mine", kind: "label", label: "drafts" });
    expect(parseSkillsRoute("lib=org&view=label&label=marketing%2Fseo")).toEqual({
      lib: "org",
      kind: "label",
      label: "marketing/seo",
    });
    expect(parseSkillsRoute("view=label&label=drafts%2Fresearch&skill=incident-summary")).toEqual({
      lib: "mine",
      kind: "label",
      label: "drafts/research",
      skill: "incident-summary",
    });
    expect(parseSkillsRoute({ view: ["label"], label: ["marketing/seo"], lib: ["org"] })).toEqual({
      lib: "org",
      kind: "label",
      label: "marketing/seo",
    });
  });

  it("falls back to the library's `all` when a label route has no path", () => {
    expect(parseSkillsRoute("view=label")).toEqual({ lib: "mine", kind: "all" });
    expect(parseSkillsRoute("lib=org&view=label")).toEqual({ lib: "org", kind: "all" });
  });

  it("falls back to My Skills for unknown views", () => {
    expect(parseSkillsRoute("view=unknown")).toEqual({ lib: "mine", kind: "all" });
  });

  it("parses skill detail routes", () => {
    expect(parseSkillsRoute("skill=incident-summary")).toEqual({ lib: "mine", kind: "all", skill: "incident-summary" });
    expect(parseSkillsRoute("skill=")).toEqual({ lib: "mine", kind: "all" });
    expect(parseSkillsRoute("view=archived&skill=old-skill")).toEqual({ kind: "archived", skill: "old-skill" });
  });

  it("detects whether a route was explicitly encoded", () => {
    expect(skillsRouteSource("")).toBe("default");
    expect(skillsRouteSource({})).toBe("default");
    expect(skillsRouteSource("lib=org")).toBe("explicit");
    expect(skillsRouteSource("skill=incident-summary")).toBe("explicit");
    expect(skillsRouteSource("view=unknown")).toBe("explicit");
  });

  it("builds canonical route URLs", () => {
    expect(skillsRouteHref({ lib: "mine", kind: "all" })).toBe("/skills");
    expect(skillsRouteHref({ lib: "mine", kind: "starred" })).toBe("/skills?view=starred");
    expect(skillsRouteHref({ lib: "mine", kind: "installed" })).toBe("/skills?view=installed");
    expect(skillsRouteHref({ lib: "org", kind: "all" })).toBe("/skills?lib=org");
    expect(skillsRouteHref({ kind: "local" })).toBe("/skills?view=local");
    expect(skillsRouteHref({ lib: "mine", kind: "all", skill: "incident-summary" })).toBe(
      "/skills?skill=incident-summary",
    );
    expect(skillsRouteHref({ kind: "archived", skill: "old skill" })).toBe("/skills?view=archived&skill=old%20skill");
    expect(skillsRouteHref({ lib: "mine", kind: "label", label: "drafts/research" })).toBe(
      "/skills?view=label&label=drafts%2Fresearch",
    );
    expect(skillsRouteHref({ lib: "org", kind: "label", label: "marketing/seo", skill: "incident-summary" })).toBe(
      "/skills?lib=org&view=label&label=marketing%2Fseo&skill=incident-summary",
    );
  });

  it("builds and parses public skill share URLs", () => {
    expect(skillShareHref("abc123")).toBe("/s/abc123");
    expect(skillShareHref("token with spaces")).toBe("/s/token%20with%20spaces");
    expect(parseSkillShareTokenPath("/s/abc123")).toBe("abc123");
    expect(parseSkillShareTokenPath("/s/token%20with%20spaces")).toBe("token with spaces");
    expect(parseSkillShareTokenPath("/s/abc123/go")).toBeNull();
    expect(parseSkillShareTokenPath("/skills")).toBeNull();
  });

  it("round-trips library + nested label path (and its open skill) through href + parse", () => {
    for (const route of [
      { lib: "mine", kind: "label", label: "drafts/research" } as const,
      { lib: "org", kind: "label", label: "marketing/seo", skill: "incident-summary" } as const,
      { lib: "org", kind: "all" } as const,
      { lib: "mine", kind: "installed" } as const,
    ]) {
      expect(parseSkillsRoute(skillsRouteHref(route))).toEqual(route);
    }
  });

  it("keys routes uniquely per library + slice + open skill", () => {
    expect(skillsRouteKey({ lib: "mine", kind: "all" })).toBe("mine:all");
    expect(skillsRouteKey({ lib: "org", kind: "all" })).toBe("org:all");
    expect(skillsRouteKey({ lib: "mine", kind: "label", label: "drafts" })).toBe("mine:label:drafts");
    expect(skillsRouteKey({ lib: "org", kind: "label", label: "marketing/seo" })).toBe("org:label:marketing/seo");
    expect(skillsRouteKey({ lib: "mine", kind: "label", label: "drafts", skill: "x" })).toBe("mine:label:drafts:skill:x");
    expect(skillsRouteKey({ kind: "local" })).toBe("local");
  });

  it("reports the library of a route", () => {
    expect(skillsRouteLib({ lib: "mine", kind: "all" })).toBe("mine");
    expect(skillsRouteLib({ lib: "org", kind: "label", label: "x" })).toBe("org");
    expect(skillsRouteLib({ kind: "local" })).toBeNull();
    expect(skillsRouteLib({ kind: "archived" })).toBeNull();
  });

  it("adds and removes skill detail from routes, preserving the library", () => {
    expect(skillsRouteWithSkill({ lib: "org", kind: "all" }, "brand-linter")).toEqual({
      lib: "org",
      kind: "all",
      skill: "brand-linter",
    });
    expect(skillsRouteWithSkill({ lib: "mine", kind: "label", label: "drafts" }, "x")).toEqual({
      lib: "mine",
      kind: "label",
      label: "drafts",
      skill: "x",
    });
    expect(skillsRouteWithSkill({ kind: "local" }, "x")).toEqual({ kind: "local" });
    expect(skillsRouteWithoutSkill({ kind: "archived", skill: "old-skill" })).toEqual({ kind: "archived" });
    expect(skillsRouteWithoutSkill({ lib: "org", kind: "label", label: "marketing/seo", skill: "x" })).toEqual({
      lib: "org",
      kind: "label",
      label: "marketing/seo",
    });
  });
});
