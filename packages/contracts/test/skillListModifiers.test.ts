import { describe, expect, it } from "vitest";
import { skillListRowSchema } from "../src/skill";

const baseRow = {
  id: "skill-1",
  org_id: "org-1",
  slug: "seo-helper",
  share_token: "share-1",
  description: "SEO helper.",
  display: {},
  notes: null,
  validation: "valid",
  validation_error: null,
  scope: "org",
  source: null,
  labels: [],
  creator_id: "user-1",
  creator_name: "Ada Lovelace",
  creator_initials: "AL",
  creator_avatar_url: null,
  current_version: "1.0.0",
  license: null,
  compatibility: null,
  metadata: {},
  checksum: "sha256:" + "a".repeat(64),
  size_bytes: 123,
  tools: [],
  requirements: [],
  installed: false,
  installed_version: null,
  install_status: "none",
  requires_count: 0,
  used_by_count: 0,
  dep_warn: false,
  archived: false,
  referenced: false,
  created_at: "2026-06-01T00:00:00.000Z",
  updated_at: "2026-06-26T00:00:00.000Z",
};

describe("skillListRowSchema modifiers", () => {
  it("defaults modifiers to an empty list", () => {
    expect(skillListRowSchema.parse(baseRow).modifiers).toEqual([]);
  });

  it("accepts resolved version publisher avatars", () => {
    expect(
      skillListRowSchema.parse({
        ...baseRow,
        modifiers: [
          {
            user_id: "user-2",
            name: "Grace Hopper",
            initials: "GH",
            avatar_url: "/v1/users/user-2/avatar?v=1",
          },
        ],
      }).modifiers,
    ).toEqual([
      {
        user_id: "user-2",
        name: "Grace Hopper",
        initials: "GH",
        avatar_url: "/v1/users/user-2/avatar?v=1",
      },
    ]);
  });
});
