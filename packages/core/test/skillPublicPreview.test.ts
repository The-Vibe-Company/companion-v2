import { describe, expect, it, vi } from "vitest";
import type { Db } from "@companion/db";
import { getSkillPublicPreviewByShareToken, getSkillShareTargetByShareToken } from "../src/services";

function fakeDb(rows: unknown[]) {
  const database = {
    execute: vi.fn(async () => rows),
  };
  return { database: database as unknown as Db, execute: database.execute };
}

describe("getSkillPublicPreviewByShareToken", () => {
  it("returns a metadata-only preview when the raw SQL timestamp is a string", async () => {
    const { database, execute } = fakeDb([
      {
        slug: "mega-code-review",
        description: "Review changes with repository context.",
        creator_name: "Ada Lovelace",
        creator_initials: "AL",
        current_version: "1.2.3",
        frontmatter: JSON.stringify({
          companion: {
            display: {
              name: "Mega Code Review",
              summary: "Review pull requests with repository context.",
            },
          },
        }),
        updated_at: "2026-06-25 10:00:00+00",
      },
    ]);

    const preview = await getSkillPublicPreviewByShareToken({ token: " share-token-1 ", database });

    expect(execute).toHaveBeenCalledOnce();
    expect(preview).toEqual({
      display_name: "Mega Code Review",
      slug: "mega-code-review",
      description: "Review pull requests with repository context.",
      current_version: "1.2.3",
      creator_name: "Ada Lovelace",
      creator_initials: "AL",
      updated_at: "2026-06-25T10:00:00.000Z",
    });
    expect(preview).not.toHaveProperty("id");
    expect(preview).not.toHaveProperty("org_id");
    expect(preview).not.toHaveProperty("creator_id");
  });

  it("returns null for unknown, personal, or archived tokens filtered out by the query", async () => {
    const { database } = fakeDb([]);

    await expect(getSkillPublicPreviewByShareToken({ token: "not-public", database })).resolves.toBeNull();
  });

  it("ignores blank tokens before touching the database", async () => {
    const { database } = fakeDb([]);

    await expect(getSkillPublicPreviewByShareToken({ token: "  ", database })).resolves.toBeNull();
    expect(database.execute).not.toHaveBeenCalled();
  });
});

describe("getSkillShareTargetByShareToken", () => {
  const actor = { id: "user-1", email: "ada@example.test", name: "Ada" };

  it("returns the org target only for a token the actor can access", async () => {
    const { database, execute } = fakeDb([{ org_id: "org-1", slug: "mega-code-review" }]);

    const target = await getSkillShareTargetByShareToken({ actor, token: " share-token-1 ", database });

    expect(execute).toHaveBeenCalledOnce();
    expect(target).toEqual({ org_id: "org-1", slug: "mega-code-review" });
  });

  it("returns null for unknown, inaccessible, personal, or archived tokens filtered out by the query", async () => {
    const { database } = fakeDb([]);

    await expect(getSkillShareTargetByShareToken({ actor, token: "not-public", database })).resolves.toBeNull();
  });

  it("ignores blank tokens before touching the database", async () => {
    const { database } = fakeDb([]);

    await expect(getSkillShareTargetByShareToken({ actor, token: "  ", database })).resolves.toBeNull();
    expect(database.execute).not.toHaveBeenCalled();
  });
});
