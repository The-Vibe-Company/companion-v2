import { describe, expect, it } from "vitest";
import type { SkillListRow } from "@companion/contracts";
import { mapSkill } from "./types";

/** Minimal valid SkillListRow; override per case. Creator and updater are distinct by default. */
function row(over: Partial<SkillListRow> = {}): SkillListRow {
  return {
    id: "skill-1",
    org_id: "org-1",
    slug: "demo",
    share_token: "share-demo",
    description: "Demo skill",
    display: {},
    notes: null,
    validation: "valid",
    validation_error: null,
    scope: "org",
    source: null,
    labels: [],
    creator_id: "user-creator",
    creator_name: "Casey Creator",
    creator_initials: "CC",
    creator_avatar_url: "https://example.com/casey.png",
    updater_id: "user-updater",
    updater_name: "Uma Updater",
    updater_initials: "UU",
    updater_avatar_url: "https://example.com/uma.png",
    modifiers: [],
    current_version: "1.0.0",
    license: null,
    compatibility: null,
    metadata: {},
    checksum: null,
    size_bytes: 10,
    tools: [],
    requirements: [],
    star_count: 0,
    starred: false,
    installed: false,
    installed_version: null,
    install_status: "none",
    requires_count: 0,
    used_by_count: 0,
    dep_warn: false,
    archived: false,
    referenced: false,
    created_at: "2026-06-09T12:00:00.000Z",
    updated_at: "2026-06-09T12:00:00.000Z",
    ...over,
  };
}

describe("mapSkill author vs updater", () => {
  it("maps creator_* to author and updater_* to updater when both are present", () => {
    const vm = mapSkill(row());
    expect(vm.authorId).toBe("user-creator");
    expect(vm.authorName).toBe("Casey Creator");
    expect(vm.authorInitials).toBe("CC");
    expect(vm.authorAvatarUrl).toBe("https://example.com/casey.png");
    expect(vm.updaterId).toBe("user-updater");
    expect(vm.updaterName).toBe("Uma Updater");
    expect(vm.updaterInitials).toBe("UU");
    expect(vm.updaterAvatarUrl).toBe("https://example.com/uma.png");
  });

  it("falls back to the creator for every updater field when updater_* is null", () => {
    const vm = mapSkill(
      row({ updater_id: null, updater_name: null, updater_initials: null, updater_avatar_url: null }),
    );
    expect(vm.updaterId).toBe("user-creator");
    expect(vm.updaterName).toBe("Casey Creator");
    expect(vm.updaterInitials).toBe("CC");
    expect(vm.updaterAvatarUrl).toBe("https://example.com/casey.png");
  });

  it("keeps a null updater avatar (initials) rather than borrowing the creator's face", () => {
    // updater identity is present but their avatar is null → must NOT show the creator's avatar under
    // the updater's name; null lets UserAvatar render the updater's initials instead.
    const vm = mapSkill(row({ updater_avatar_url: null }));
    expect(vm.updaterName).toBe("Uma Updater");
    expect(vm.updaterInitials).toBe("UU");
    expect(vm.updaterAvatarUrl).toBeNull();
  });
});
