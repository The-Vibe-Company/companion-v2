import { describe, expect, it } from "vitest";
import { parseSkillListQuery } from "./skillListQuery";

function parse(raw: Record<string, string | undefined>) {
  return parseSkillListQuery((name) => raw[name]);
}

describe("parseSkillListQuery", () => {
  it("defaults to the org library and no installed-only filter", () => {
    expect(parse({})).toMatchObject({
      library: "org",
      labelValid: true,
      label: undefined,
      nolabel: false,
      installedOnly: false,
      archived: false,
      query: undefined,
      limit: undefined,
    });
  });

  it("parses My Skills, installed-only, and search options", () => {
    expect(parse({ lib: "mine", installed: "true", q: " deploy ", archived: "true" })).toMatchObject({
      library: "mine",
      installedOnly: true,
      archived: true,
      query: "deploy",
      limit: 20,
    });
  });

  it("validates label paths before they can reach the list query", () => {
    expect(parse({ label: "marketing/seo" })).toMatchObject({
      labelValid: true,
      label: "marketing/seo",
    });
    expect(parse({ label: "%" })).toMatchObject({
      labelValid: false,
      label: "%",
    });
  });
});
