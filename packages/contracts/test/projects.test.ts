import { describe, expect, it } from "vitest";
import {
  PROJECT_NAME_MAX,
  createProjectInputSchema,
  createProjectSessionFieldsSchema,
  projectDetailSchema,
  projectFilesResponseSchema,
  projectFileRowSchema,
  projectFileVersionRowSchema,
  projectFileVersionsResponseSchema,
  projectQuestionReplyInputSchema,
  projectSessionDetailSchema,
  projectSessionEventSchema,
  listProjectSessionsQuerySchema,
  setProjectSkillsInputSchema,
  updateProjectInputSchema,
  updateProjectSessionInputSchema,
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
      modified_by_prompt_id: "00000000-0000-4000-8000-000000000004",
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

  it("returns direct Project uploads as ordinary creator-visible file rows", () => {
    const file = projectFileRowSchema.parse({
      id: "00000000-0000-4000-8000-000000000003",
      project_id: "00000000-0000-4000-8000-000000000001",
      path: "files/brief.txt",
      version: 1,
      content_type: "text/plain",
      byte_size: 12,
      checksum: `sha256:${"a".repeat(64)}`,
      modified_by_session_id: null,
      modified_by_prompt_id: null,
      conflict_detected: false,
      created_at: "2026-07-23T18:00:00.000Z",
      updated_at: "2026-07-23T18:00:00.000Z",
    });
    expect(projectFilesResponseSchema.parse({ files: [file] })).toEqual({ files: [file] });
    expect(JSON.stringify(file)).not.toContain("storage");
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
      active_session_count: 0,
      archived_session_count: 0,
      unread_session_count: 0,
      file_count: 0,
      recent_sessions: [],
      last_activity_at: "2026-07-23T18:00:00.000Z",
      error_code: null,
      message: null,
      archived_at: null,
      created_at: "2026-07-23T18:00:00.000Z",
      updated_at: "2026-07-23T18:00:00.000Z",
      skills: [],
      sessions: [],
      secret_count: 0,
      model_connection_count: 0,
      access: { secrets: [], model_connections: [] },
    });
    expect(JSON.stringify(parsed)).not.toContain("sandbox");
    expect(JSON.stringify(parsed)).not.toContain("checkpoint");
  });

  it("validates durable conversation library mutations and pagination", () => {
    expect(
      updateProjectSessionInputSchema.parse({
        title: "Launch review",
        archived: true,
        stop_active: true,
      }),
    ).toEqual({
      title: "Launch review",
      archived: true,
      stop_active: true,
    });
    expect(() =>
      updateProjectSessionInputSchema.parse({ archived: true, stop_active: false }),
    ).not.toThrow();
    expect(() =>
      updateProjectSessionInputSchema.parse({ viewed: false }),
    ).toThrow();
    expect(() =>
      updateProjectSessionInputSchema.parse({ stop_active: true }),
    ).toThrow();
    expect(
      listProjectSessionsQuerySchema.parse({
        q: "review",
        view: "archived",
        limit: "25",
      }),
    ).toEqual({
      q: "review",
      view: "archived",
      limit: 25,
    });
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

  it("bounds normalized Project questions, activity, retry, and tool lifecycle metadata", () => {
    expect(
      projectSessionEventSchema.parse({
        type: "question.asked",
        request_id: "question-1",
        protocol: "question.v2",
        questions: [{
          header: "Format",
          question: "Which format should I use?",
          options: [{
            label: "PDF",
            description: "A fixed-layout document",
          }],
          multiple: false,
          custom: true,
        }],
        tool: { message_id: "assistant-1", call_id: "call-1" },
      }),
    ).toEqual({
      type: "question.asked",
      request_id: "question-1",
      protocol: "question.v2",
      questions: [{
        header: "Format",
        question: "Which format should I use?",
        options: [{
          label: "PDF",
          description: "A fixed-layout document",
        }],
        multiple: false,
        custom: true,
      }],
      tool: { message_id: "assistant-1", call_id: "call-1" },
    });
    expect(
      projectSessionEventSchema.parse({
        type: "status",
        state: "retry",
        attempt: 2,
        message: "Provider busy",
        activity: "retrying",
        retry_at: 1_784_901_234_000,
        retry_action: {
          reason: "rate_limit",
          provider: "openai",
          title: "Provider busy",
          message: "OpenCode will try again.",
          label: "Provider settings",
          link: "https://example.com/settings",
        },
      }),
    ).toMatchObject({
      type: "status",
      state: "retry",
      activity: "retrying",
      retry_at: 1_784_901_234_000,
    });
    expect(
      projectSessionEventSchema.parse({
        type: "tool.done",
        call_id: "call-1",
        title: "Write report",
        output: "Created report.md",
        duration_ms: 12,
        message_id: "assistant-1",
        outcome: "success",
      }),
    ).toMatchObject({
      type: "tool.done",
      message_id: "assistant-1",
      outcome: "success",
    });
    expect(() =>
      projectSessionEventSchema.parse({
        type: "question.asked",
        request_id: "question-empty",
        protocol: "question",
        questions: [],
        tool: null,
      })
    ).toThrow();
    expect(() =>
      projectSessionEventSchema.parse({
        type: "status",
        state: "retry",
        attempt: 1,
        message: "Retrying",
        activity: "retrying",
        retry_at: 1,
        retry_action: {
          reason: "provider",
          provider: "openai",
          title: "Provider",
          message: "Review provider",
          label: "Open",
          link: "javascript:alert(1)",
        },
      })
    ).toThrow();
  });

  it("rejects a response matrix that fits field bounds but exceeds durable aggregate storage", () => {
    expect(() =>
      projectQuestionReplyInputSchema.parse({
        answers: Array.from({ length: 8 }, () =>
          Array.from({ length: 12 }, () => "x".repeat(4_000)),
        ),
      }),
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
        archived_at: null,
        last_viewed_at: "2026-07-23T18:00:00.000Z",
        is_unread: false,
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
        current_event_sequence: 1,
        latest_event_sequence: 1,
      })
    ).toThrow();
  });
});
