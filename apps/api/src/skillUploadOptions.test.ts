import { describe, expect, it } from "vitest";
import { buildSkillUploadOptions } from "./skillUploadOptions";

describe("buildSkillUploadOptions", () => {
  it("keeps personal/private defaults and marks editable teams as owner choices", () => {
    expect(
      buildSkillUploadOptions([
        { id: "team-1", slug: "platform", name: "Platform", color: null, icon: null, teamRole: "admin" },
        { id: "team-2", slug: "research", name: "Research", color: "#123456", icon: "lab", teamRole: "editor" },
        { id: "team-3", slug: "sales", name: "Sales", color: null, icon: null, teamRole: "reader" },
      ]),
    ).toEqual({
      defaults: {
        owner_team: null,
      },
      teams: [
        {
          id: "team-1",
          slug: "platform",
          name: "Platform",
          color: null,
          icon: null,
          teamRole: "admin",
          canOwn: true,
        },
        {
          id: "team-2",
          slug: "research",
          name: "Research",
          color: "#123456",
          icon: "lab",
          teamRole: "editor",
          canOwn: true,
        },
        {
          id: "team-3",
          slug: "sales",
          name: "Sales",
          color: null,
          icon: null,
          teamRole: "reader",
          canOwn: false,
        },
      ],
    });
  });
});
