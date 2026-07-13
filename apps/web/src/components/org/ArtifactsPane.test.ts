import { describe, expect, it } from "vitest";
import type { SecretRow } from "@companion/contracts";
import { selectArtifactSecretReferences } from "./ArtifactsPane";

function secret(
  id: string,
  audience: SecretRow["audience"],
  overrides: Partial<SecretRow> = {},
): SecretRow {
  return {
    id,
    name: id,
    key: "VANISH_API_KEY",
    audience,
    can_use: true,
    disabled_at: null,
    deleted_at: null,
    owner: { id: "owner", name: "Owner" },
    ...overrides,
  } as SecretRow;
}

describe("selectArtifactSecretReferences", () => {
  it("keeps all active accessible audiences for a personal binding", () => {
    const rows = [
      secret("personal", "personal"),
      secret("restricted", "restricted"),
      secret("organization", "organization"),
    ];

    expect(selectArtifactSecretReferences(rows, "personal").map((row) => row.id)).toEqual([
      "personal",
      "restricted",
      "organization",
    ]);
  });

  it("keeps only active organization secrets for a workspace binding", () => {
    const rows = [
      secret("personal", "personal"),
      secret("restricted", "restricted"),
      secret("organization", "organization"),
      secret("disabled", "organization", { disabled_at: "2026-07-13T00:00:00.000Z" }),
      secret("deleted", "organization", { deleted_at: "2026-07-13T00:00:00.000Z" }),
      secret("inaccessible", "organization", { can_use: false }),
    ];

    expect(selectArtifactSecretReferences(rows, "organization").map((row) => row.id)).toEqual([
      "organization",
    ]);
  });
});
