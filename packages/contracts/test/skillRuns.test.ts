import { describe, expect, it } from "vitest";
import {
  RUN_VARIABLE_VALUE_MAX_BYTES,
  createRunConfigurationInputSchema,
  launchRunFieldsSchema,
  runChatEventSchema,
  runConfigurationSchema,
  runInputSelectionSchema,
  runInputSnapshotSchema,
  runOptionsSchema,
  skillRunStatusSchema,
  updateRunConfigurationInputSchema,
} from "../src/skillRuns";

const skillId = "4c322a19-e5e1-4c30-8be1-83251eb43b1f";
const versionId = "9a624988-833f-481a-b6b5-4a2407ec8881";
const slotId = "df80d275-30c9-5f0d-9a46-d77e6fca8448";
const secretId = "a57b0803-6afb-47d0-a307-e8fb80c56511";

describe("skill run contracts", () => {
  it("exposes the complete public lifecycle", () => {
    expect(skillRunStatusSchema.options).toEqual(["queued", "starting", "running", "frozen", "error", "canceled"]);
  });

  it("parses an authoritative selection and rejects duplicates", () => {
    const selection = {
      secrets: [{ skill_id: skillId, slot_id: slotId, secret_id: secretId }],
      variables: [{ skill_id: skillId, env_key: "REPORT_FORMAT", value: "short" }],
    };
    expect(runInputSelectionSchema.parse(selection)).toEqual(selection);
    expect(() => runInputSelectionSchema.parse({ ...selection, secrets: [...selection.secrets, ...selection.secrets] })).toThrow(
      /duplicate secret slot/,
    );
    expect(() =>
      runInputSelectionSchema.parse({ secrets: [], variables: [{ skill_id: skillId, env_key: "OPENCODE_SERVER_PASSWORD", value: "x" }] }),
    ).toThrow(/reserved/);
  });

  it("bounds non-sensitive values by UTF-8 bytes and rejects NUL", () => {
    expect(() =>
      runInputSelectionSchema.parse({ variables: [{ skill_id: skillId, env_key: "FORMAT", value: "a\0b" }] }),
    ).toThrow(/NUL/);
    expect(() =>
      runInputSelectionSchema.parse({
        variables: [{ skill_id: skillId, env_key: "FORMAT", value: "é".repeat(RUN_VARIABLE_VALUE_MAX_BYTES / 2 + 1) }],
      }),
    ).toThrow(/bytes/);
  });

  it("requires an exact version and parses JSON multipart inputs", () => {
    const parsed = launchRunFieldsSchema.parse({
      prompt: "Summarize this",
      model: "anthropic/claude-sonnet-4",
      skill_version_id: versionId,
      inputs: JSON.stringify({ secrets: [{ skill_id: skillId, slot_id: slotId, secret_id: secretId }], variables: [] }),
    });
    expect(parsed.skill_version_id).toBe(versionId);
    expect(parsed.inputs.secrets[0]?.secret_id).toBe(secretId);
    expect(() => launchRunFieldsSchema.parse({ prompt: "x", model: "provider/model", inputs: "{}" })).toThrow();
    expect(() =>
      launchRunFieldsSchema.parse({ prompt: "x", model: "provider/model", skill_version_id: versionId, inputs: "not-json" }),
    ).toThrow();
  });

  it("validates create/update configuration payloads and optimistic revisions", () => {
    const created = createRunConfigurationInputSchema.parse({
      name: "Weekly summary",
      model: "anthropic/claude-sonnet-4",
      inputs: { variables: [{ skill_id: skillId, env_key: "REPORT_FORMAT", value: "brief" }] },
    });
    expect(created.is_default).toBe(false);
    expect(created.inputs.secrets).toEqual([]);
    expect(() => updateRunConfigurationInputSchema.parse({ revision: 2 })).toThrow(/at least one/);
    expect(updateRunConfigurationInputSchema.parse({ revision: 2, name: "Renamed" }).revision).toBe(2);
  });

  it("represents configurations which need attention without secret plaintext", () => {
    const configuration = runConfigurationSchema.parse({
      id: secretId,
      skill_id: skillId,
      skill_slug: "weekly-summary",
      name: "Production",
      model: "anthropic/claude-sonnet-4",
      revision: 3,
      is_default: true,
      status: "needs_attention",
      issues: [{ code: "secret_unavailable", message: "Secret unavailable", slot_id: slotId, skill_id: skillId }],
      inputs: { secrets: [], variables: [] },
      created_at: "2026-07-13T10:00:00.000Z",
      updated_at: "2026-07-13T10:10:00.000Z",
      last_used_at: null,
    });
    expect(configuration.status).toBe("needs_attention");
    expect(JSON.stringify(configuration)).not.toContain("plaintext");
  });

  it("returns a root and a dependency closure in run options", () => {
    const dependency = {
      skill_id: "0f232fd8-c852-4bab-9c12-1e1d4ed66634",
      skill_version_id: "2bc55a52-3320-47cd-aa66-9859cda981ed",
      slug: "shared-parser",
      version: "1.2.3",
      root: false,
      depth: 1,
      via: "weekly-summary",
    };
    const parsed = runOptionsSchema.parse({
      root: {
        skill_id: skillId,
        skill_version_id: versionId,
        slug: "weekly-summary",
        version: "2.0.0",
        root: true,
        depth: 0,
        via: null,
      },
      dependencies: [dependency],
      declared_secrets: [],
      declared_variables: [],
      configurations: [],
      models: [],
      runtime: { available: true },
    });
    expect(parsed.dependencies[0]?.skill_version_id).toBe(dependency.skill_version_id);
    expect(() => runOptionsSchema.parse({ ...parsed, root: dependency, dependencies: [] })).toThrow(/root/);
  });

  it("distinguishes non-terminal warnings from terminal run errors", () => {
    expect(
      runChatEventSchema.parse({ type: "run.warning", code: "vanish_publish_failed", message: "Artifact sharing failed" }).type,
    ).toBe("run.warning");
    expect(runChatEventSchema.parse({ type: "run.error", code: "runtime_failed", message: "Run failed" }).type).toBe("run.error");
    expect(runChatEventSchema.parse({ type: "error", message: "legacy" }).type).toBe("error");
  });

  it("pins redacted secret versions without accepting a value field", () => {
    const input = {
      skills: [
        {
          skill_id: skillId,
          skill_version_id: versionId,
          slug: "weekly-summary",
          version: "2.0.0",
          root: true,
          depth: 0,
          via: null,
        },
      ],
      secrets: [
        {
          provenance: "skill",
          skill_id: skillId,
          skill_slug: "weekly-summary",
          slot_id: slotId,
          env_key: "ANTHROPIC_API_KEY",
          required: true,
          secret_id: secretId,
          secret_version: 4,
          secret_name: "Anthropic production",
        },
      ],
      variables: [],
    };
    const snapshot = runInputSnapshotSchema.parse(input);
    expect(snapshot.secrets[0]?.secret_version).toBe(4);
    expect(snapshot.secrets[0]).not.toHaveProperty("value");
    expect(() =>
      runInputSnapshotSchema.parse({
        ...input,
        secrets: [{ ...input.secrets[0], value: "must never enter a regular run contract" }],
      }),
    ).toThrow(/Unrecognized key/);

    const runtimeCredential = runInputSnapshotSchema.parse({
      skills: input.skills,
      secrets: [
        {
          provenance: "runtime",
          skill_id: null,
          skill_slug: null,
          slot_id: null,
          env_key: "OPENCODE_SERVER_PASSWORD",
          required: true,
          secret_id: null,
          secret_version: null,
          secret_name: null,
        },
      ],
      variables: [],
    });
    expect(runtimeCredential.secrets[0]?.provenance).toBe("runtime");
  });
});
