import { afterEach, describe, expect, it, vi } from "vitest";
import {
  projectsFeatureEnabled,
  runSkillFeatureEnabled,
} from "./projectsFeature";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("internal product rollout gates", () => {
  it("enables Projects only for an exact internal email and an enabled flag", () => {
    vi.stubEnv("COMPANION_PROJECTS_ENABLED", "true");

    expect(projectsFeatureEnabled("stan@thevibecompany.co")).toBe(true);
    expect(projectsFeatureEnabled("Stan@THEVIBECOMPANY.CO")).toBe(true);
    expect(projectsFeatureEnabled("stan@example.com")).toBe(false);
    expect(projectsFeatureEnabled("stan@team.thevibecompany.co")).toBe(false);
    expect(projectsFeatureEnabled("stan@thevibecompany.co.evil.test")).toBe(false);
    expect(projectsFeatureEnabled(" stan@thevibecompany.co")).toBe(false);
  });

  it("keeps Projects hidden when its deployment flag is absent or disabled", () => {
    expect(projectsFeatureEnabled("stan@thevibecompany.co")).toBe(false);

    vi.stubEnv("COMPANION_PROJECTS_ENABLED", "false");
    expect(projectsFeatureEnabled("stan@thevibecompany.co")).toBe(false);

    vi.stubEnv("COMPANION_PROJECTS_ENABLED", "1");
    expect(projectsFeatureEnabled("stan@thevibecompany.co")).toBe(true);
  });

  it("applies the same exact-domain rollout to Run Skill", () => {
    vi.stubEnv("COMPANION_RUNS_ENABLED", "true");

    expect(runSkillFeatureEnabled("stan@thevibecompany.co")).toBe(true);
    expect(runSkillFeatureEnabled("stan@example.com")).toBe(false);
    expect(runSkillFeatureEnabled("stan@sub.thevibecompany.co")).toBe(false);

    vi.stubEnv("COMPANION_RUNS_ENABLED", "0");
    expect(runSkillFeatureEnabled("stan@thevibecompany.co")).toBe(false);
  });
});
