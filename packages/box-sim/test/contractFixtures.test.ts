/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type, anti-slop/require-safety-comment-for-type-assertion -- Contract fixtures are deliberately untyped JSON at this parser boundary; the assertions below validate each field before it is used. */
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { PI_SCENARIOS } from "../src/scenarios";

const FIXTURE_DIRECTORY = fileURLToPath(new URL("../fixtures/pi/", import.meta.url));

interface FixtureProvenance {
  path: string;
  classification: "official_docs_adapted" | "runtime_capture_anonymized" | "synthetic_fault";
  sourceIds: string[];
  transformations: string[];
}

interface ProvenanceManifest {
  schemaVersion: number;
  reviewedAt: string;
  notice: string;
  sources: Array<{ id: string; kind: string; url: string; sections: string[] }>;
  fixtures: FixtureProvenance[];
}

describe("Pi contract fixture provenance", () => {
  it("classifies every fixture as official-doc-derived or synthetic", async () => {
    const manifest = await readManifest();
    const files = (await readdir(FIXTURE_DIRECTORY))
      .filter((name) => name !== "README.md" && name !== "provenance.json")
      .sort();

    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.notice).toContain("No production or customer traffic");
    expect(manifest.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "pi-rpc-docs",
        kind: "official_documentation",
        url: "https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md",
      }),
      expect.objectContaining({
        id: "pi-runtime-0.84.2",
        kind: "local_subprocess_capture",
        package: "@earendil-works/pi-coding-agent@0.84.2",
      }),
    ]));
    expect(manifest.fixtures.map((fixture) => fixture.path).sort()).toEqual(files);

    for (const fixture of manifest.fixtures) {
      expect(["official_docs_adapted", "runtime_capture_anonymized", "synthetic_fault"])
        .toContain(fixture.classification);
      expect(fixture.transformations.length).toBeGreaterThan(0);
      if (fixture.classification === "official_docs_adapted") {
        expect(fixture.path).toMatch(/^official-/);
        expect(fixture.sourceIds).toEqual(["pi-rpc-docs"]);
      } else if (fixture.classification === "runtime_capture_anonymized") {
        expect(fixture.path).toMatch(/^captured-/);
        expect(fixture.sourceIds).toHaveLength(1);
        expect(fixture.sourceIds[0]).toMatch(/^pi-runtime(?:-openai-completions)?-0\.84\.2$/);
      } else {
        expect(fixture.path).toBe("synthetic-faults.json");
        expect(fixture.sourceIds).toEqual([]);
      }
    }
  });

  it("locks the anonymized response emitted by the pinned real Pi subprocess", async () => {
    const [captured] = await readJsonl("captured-get-state-0.84.2.jsonl");
    expect(captured).toMatchObject({
      id: "capture-1",
      type: "response",
      command: "get_state",
      success: true,
      data: {
        model: { input: [] },
        isStreaming: false,
        pendingMessageCount: 0,
      },
    });
  });

  it("locks the tool lifecycle Pi forwards from the openai-completions adapter", async () => {
    const events = await readJsonl("captured-openai-completions-tool-events-0.84.2.jsonl");
    expect(events[0]).toEqual({
      type: "tool_execution_start",
      toolCallId: "call_glm_fixture",
      toolName: "bash",
      args: { command: "printf 'glm fixture\\n'" },
    });
    expect(events.at(-1)).toMatchObject({
      type: "tool_execution_end",
      toolCallId: "call_glm_fixture",
      toolName: "bash",
      result: { content: [{ type: "text", text: "glm fixture\n" }] },
      isError: false,
    });
  });

  it("keeps all JSONL fixtures minified, parseable, and strictly LF-delimited", async () => {
    const files = (await readdir(FIXTURE_DIRECTORY)).filter((name) => name.endsWith(".jsonl"));
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      const bytes = await readFile(`${FIXTURE_DIRECTORY}/${file}`);
      const text = bytes.toString("utf8");
      expect(text.endsWith("\n"), file).toBe(true);
      expect(text.includes("\r"), file).toBe(false);
      for (const line of text.slice(0, -1).split("\n")) {
        const record = JSON.parse(line) as unknown;
        expect(isRecord(record), `${file}: ${line}`).toBe(true);
        expect(line, file).toBe(JSON.stringify(record));
      }
    }
  });

  it("preserves command/response ids but puts no prompt id on general events", async () => {
    const commands = await readJsonl("official-commands.jsonl");
    const responses = await readJsonl("official-responses.jsonl");
    const commandById = new Map(commands
      .filter((record) => typeof record.id === "string" && record.type !== "extension_ui_response")
      .map((record) => [record.id, record]));

    for (const response of responses) {
      expect(response.type).toBe("response");
      expect(typeof response.id).toBe("string");
      const command = commandById.get(response.id as string);
      expect(command).toBeDefined();
      expect(response.command).toBe(command?.type);
    }

    for (const event of await readJsonl("official-events.jsonl")) {
      if (event.type === "bash_execution_update") continue;
      expect(event).not.toHaveProperty("id");
      if (event.type === "message_update") {
        expect(event).not.toHaveProperty("message");
        expect(event.assistantMessageEvent).not.toHaveProperty("partial");
      }
    }

    const [request, response] = await readJsonl("official-extension-ui.jsonl");
    expect(request).toMatchObject({ type: "extension_ui_request", id: "ui-sim-001" });
    expect(response).toMatchObject({ type: "extension_ui_response", id: request?.id });
  });

  it("marks every non-contract fault scenario as synthetic", async () => {
    const recipes = JSON.parse(await readFile(
      `${FIXTURE_DIRECTORY}/synthetic-faults.json`,
      "utf8",
    )) as { classification: string; recipes: Array<{ scenario: string }> };
    const syntheticScenarios = Object.values(PI_SCENARIOS)
      .filter((scenario) => scenario.provenance === "synthetic_fault")
      .map((scenario) => scenario.name)
      .sort();

    expect(recipes.classification).toBe("synthetic_fault");
    expect(recipes.recipes.map((recipe) => recipe.scenario).sort()).toEqual(syntheticScenarios);
  });

  it("contains no common secret material or non-anonymized host paths", async () => {
    const files = await readdir(FIXTURE_DIRECTORY);
    const contents = (await Promise.all(files.map((file) => (
      readFile(`${FIXTURE_DIRECTORY}/${file}`, "utf8")
    )))).join("\n");

    const forbidden = [
      /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
      /\bsk-[A-Za-z0-9_-]{20,}\b/,
      /\bgh[opusr]_[A-Za-z0-9]{20,}\b/,
      /\bAKIA[0-9A-Z]{16}\b/,
      /\bBearer\s+[A-Za-z0-9._~-]{12,}\b/i,
      /\/home\/[A-Za-z0-9._-]+\//,
      /\/Users\/[A-Za-z0-9._-]+\//,
    ];
    for (const pattern of forbidden) expect(contents).not.toMatch(pattern);
  });
});

async function readManifest(): Promise<ProvenanceManifest> {
  return JSON.parse(await readFile(`${FIXTURE_DIRECTORY}/provenance.json`, "utf8")) as ProvenanceManifest;
}

async function readJsonl(file: string): Promise<Array<Record<string, unknown>>> {
  const text = await readFile(`${FIXTURE_DIRECTORY}/${file}`, "utf8");
  return text.trimEnd().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
