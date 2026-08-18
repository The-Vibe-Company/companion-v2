import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const FIXTURE_DIRECTORY = fileURLToPath(new URL("../fixtures/box/", import.meta.url));

describe("Box API contract fixture provenance", () => {
  it("accounts for every fixture and distinguishes capture from adapted documentation", async () => {
    const manifest = JSON.parse(await readFile(`${FIXTURE_DIRECTORY}/provenance.json`, "utf8")) as {
      sources: Array<Record<string, unknown>>;
      fixtures: Array<{ path: string; classification: string; sourceIds: string[] }>;
    };
    const files = (await readdir(FIXTURE_DIRECTORY))
      .filter((name) => name.endsWith(".json") && name !== "provenance.json")
      .sort();

    expect(manifest.fixtures.map((fixture) => fixture.path).sort()).toEqual(files);
    expect(manifest.fixtures).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: "captured-unauthorized.json",
        classification: "runtime_capture_anonymized",
        sourceIds: ["box-api-live-unauthorized"],
      }),
      expect.objectContaining({
        path: "official-delete-accepted.json",
        classification: "official_docs_adapted",
        sourceIds: ["box-delete-docs"],
      }),
    ]));
  });

  it("locks the real error envelope and documented asynchronous delete envelopes", async () => {
    const unauthorized = await fixture("captured-unauthorized.json");
    const accepted = await fixture("official-delete-accepted.json");
    const completed = await fixture("official-deletion-completed.json");

    expect(unauthorized).toMatchObject({
      ok: false,
      type: "box.error",
      status: 401,
      code: "unauthorized",
      requestId: "req_anonymized",
    });
    expect(accepted).toMatchObject({
      ok: true,
      type: "box.deleting",
      operation: { status: "pending", completedAt: null },
    });
    expect(completed).toMatchObject({
      ok: true,
      type: "deletion.operation",
      operation: { status: "completed", attemptCount: 1 },
    });
  });
});

async function fixture(name: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(`${FIXTURE_DIRECTORY}/${name}`, "utf8")) as Record<string, unknown>;
}
