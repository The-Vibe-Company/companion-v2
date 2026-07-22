import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { fetchPublicSkillPreview } from "./preview";

describe("fetchPublicSkillPreview", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("treats an omitted public_release from an older API as metadata-only", async () => {
    vi.stubEnv("COMPANION_API_URL", "http://127.0.0.1:55001");
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      display_name: "Release helper",
      slug: "release-helper",
      description: "Install a pinned release.",
      current_version: "2.0.0",
      creator_name: "Alice Nardon",
      creator_initials: "AN",
      updated_at: "2026-07-21T10:00:00.000Z",
    })));

    await expect(fetchPublicSkillPreview("share-token")).resolves.toMatchObject({
      slug: "release-helper",
      current_version: "2.0.0",
      public_release: null,
    });
    expect(fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:55001/v1/public/skills/share-token",
      { cache: "no-store" },
    );
  });
});
