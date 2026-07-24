import { describe, expect, it } from "vitest";
import {
  PROJECT_NAME_MAX,
  createProjectInputSchema,
  createProjectSessionFieldsSchema,
  projectDetailSchema,
  projectFileVersionRowSchema,
  projectFileVersionsResponseSchema,
  projectSessionDetailSchema,
  projectSessionEventSchema,
  setProjectSkillsInputSchema,
  updateProjectInputSchema,
} from "../src/projects";
import { RUN_CHAT_TOOL_OUTPUT_MAX } from "../src/skillRuns";

describe("Cowork project contracts", () => {
  it("requires the project name and default model selected in the creation dialog", () => {
    expect(
      createProjectInputSchema.parse({
        name: "Quarterly review",
        default_model: "openai/gpt-5",
      }),
    ).toEqual({
      name: "Quarterly review",
      default_model: "openai/gpt-5",
      skill_slugs: [],
    });
    expect(() =>
      createProjectInputSchema.parse({
        name: "x".repeat(PROJECT_NAME_MAX + 1),
        default_model: "openai/gpt-5",
      }),
    ).toThrow();
  });

  it("requires optimistic revisions and unique selected skills", () => {
    expect(updateProjectInputSchema.parse({ revision: 1, name: "Renamed" })).toEqual({
      revision: 1,
      name: "Renamed",
    });
    expect(() => updateProjectInputSchema.parse({ revision: 1 })).toThrow();
    expect(() =>
      setProjectSkillsInputSchema.parse({
        revision: 1,
        skill_slugs: ["research", "research"],
      }),
    ).toThrow();
  });

  it("allows a session to inherit its project model", () => {
    expect(
      createProjectSessionFieldsSchema.parse({ prompt: "Prepare the report" }),
    ).toEqual({ prompt: "Prepare the report" });
  });

  it("exposes durable file history without storage identity", () => {
    const version = projectFileVersionRowSchema.parse({
      project_id: "00000000-0000-4000-8000-000000000001",
      file_id: "00000000-0000-4000-8000-000000000003",
      path: "files/reports/q3.md",
      version: 2,
      content_type: "text/markdown",
      byte_size: 124,
      checksum: "a".repeat(64),
      modified_by_session_id: "00000000-0000-4000-8000-000000000002",
      base_version: 1,
      conflict_detected: true,
      created_at: "2026-07-23T18:00:00.000Z",
    });
    expect(
      projectFileVersionsResponseSchema.parse({ versions: [version] }),
    ).toEqual({ versions: [version] });
    expect(JSON.stringify(version)).not.toContain("storage");
    expect(() =>
      projectFileVersionRowSchema.parse({
        ...version,
        path: ".opencode/config.json",
      }),
    ).toThrow();
  });

  it("never exposes provider sandbox identity in the reader contract", () => {
    const parsed = projectDetailSchema.parse({
      id: "00000000-0000-4000-8000-000000000001",
      name: "Quarterly review",
      default_model: "openai/gpt-5",
      revision: 1,
      status: "stopped",
      skill_count: 0,
      session_count: 0,
      file_count: 0,
      recent_sessions: [],
      last_activity_at: "2026-07-23T18:00:00.000Z",
      error_code: null,
      message: null,
      created_at: "2026-07-23T18:00:00.000Z",
      updated_at: "2026-07-23T18:00:00.000Z",
      skills: [],
      sessions: [],
      secret_count: 0,
      model_connection_count: 0,
    });
    expect(JSON.stringify(parsed)).not.toContain("sandbox");
    expect(JSON.stringify(parsed)).not.toContain("checkpoint");
  });

  it("uses the bounded Run event vocabulary for durable Project events", () => {
    expect(
      projectSessionEventSchema.parse({
        type: "tool.done",
        call_id: "call-1",
        title: "Inspect",
        output: "safe",
        duration_ms: 1,
        attacker_controlled: "discard me",
      }),
    ).toEqual({
      type: "tool.done",
      call_id: "call-1",
      title: "Inspect",
      output: "safe",
      duration_ms: 1,
    });
    expect(() =>
      projectSessionEventSchema.parse({
        type: "tool.done",
        call_id: "call-1",
        title: null,
        output: "x".repeat(RUN_CHAT_TOOL_OUTPUT_MAX + 1),
        duration_ms: null,
      })
    ).toThrow();
    expect(() =>
      projectSessionEventSchema.parse({ type: "project.arbitrary", payload: "unbounded" })
    ).toThrow();
  });

  it("rejects an unbounded Project recovery transcript", () => {
    expect(() =>
      projectSessionDetailSchema.parse({
        id: "00000000-0000-4000-8000-000000000002",
        project_id: "00000000-0000-4000-8000-000000000001",
        title: "Quarterly review",
        model: "openai/gpt-5",
        status: "idle",
        stop_requested_at: null,
        last_active_at: "2026-07-23T18:00:00.000Z",
        error_code: null,
        message: null,
        created_at: "2026-07-23T18:00:00.000Z",
        updated_at: "2026-07-23T18:00:00.000Z",
        prompts: [],
        transcript: [{
          kind: "tool",
          call_id: "call-1",
          tool: "bash",
          skill: null,
          title: null,
          input: "",
          output: "x".repeat(RUN_CHAT_TOOL_OUTPUT_MAX + 1),
          duration_ms: 1,
        }],
        latest_event_sequence: 1,
      })
    ).toThrow();
  });
});
