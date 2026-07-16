import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchRun,
  launchRun,
  normalizeRunPromptAccepted,
  setModelProviderConnection,
} from "./runQueries";

const jsonResponse = (value: unknown) => new Response(JSON.stringify(value), {
  status: 200,
  headers: { "content-type": "application/json" },
});

describe("run query credential boundaries", () => {
  const request = vi.fn();

  beforeEach(() => {
    request.mockReset();
    request.mockResolvedValue(jsonResponse({ connection: {} }));
    vi.stubGlobal("fetch", request);
  });

  it("sends model-provider plaintext only to the dedicated write-only connection route", async () => {
    await setModelProviderConnection({
      provider: "openai",
      key_name: "OPENAI_API_KEY",
      api_key: "provider-sentinel",
    });

    expect(request).toHaveBeenCalledOnce();
    const [path, init] = request.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/v1/provider-connections");
    expect(JSON.parse(String(init.body))).toEqual({
      provider: "openai",
      key_name: "OPENAI_API_KEY",
      api_key: "provider-sentinel",
    });
    expect(String(init.body)).not.toContain("secret_id");
  });

  it("launches with the exact provider connection version and no generic provider secret id", async () => {
    request.mockResolvedValue(jsonResponse({ id: "run-id" }));
    await launchRun("demo", {
      prompt: "Summarize",
      model: "openai/gpt-5",
      skillVersionId: "22222222-2222-4222-8222-222222222222",
      dependencyPins: [],
      inputs: { secrets: [], variables: [] },
      modelProviderConnectionId: "33333333-3333-4333-8333-333333333333",
      modelProviderCredentialVersion: 4,
      runConfigId: null,
      files: [],
      idempotencyKey: "request-1",
    });

    const [, init] = request.mock.calls[0] as [string, RequestInit];
    const form = init.body as FormData;
    expect(form.get("model_provider_connection_id")).toBe("33333333-3333-4333-8333-333333333333");
    expect(form.get("model_provider_credential_version")).toBe("4");
    expect(form.get("model_provider_secret_id")).toBeNull();
  });
});

describe("run query rolling-deploy compatibility", () => {
  const request = vi.fn();

  beforeEach(() => {
    request.mockReset();
    vi.stubGlobal("fetch", request);
  });

  it("supplies queue and preview defaults when an older API returns run detail", async () => {
    request.mockResolvedValue(jsonResponse({
      id: "run-id",
      skill_slug: "demo",
      skill_version: "1.0.0",
      model: "openai/gpt-5",
      prompt_excerpt: "Summarize",
      prompt: "Summarize",
      status: "running",
      status_detail: null,
      phase: "prompt",
      error_code: null,
      error_message: null,
      created_at: "2026-07-16T12:00:00.000Z",
      last_active_at: null,
      transcript: [],
      warnings: [],
      transcript_event_sequence: 0,
      activation_revision: 0,
      reactivatable_until: null,
      can_reactivate: false,
      attachments: [{
        id: "attachment-id",
        prompt_id: "11111111-1111-4111-8111-111111111111",
        message_id: "message-1",
        prompt_ordinal: 0,
        file_name: "source.png",
        content_type: "image/png",
        byte_size: 42,
      }],
      artifacts: [],
    }));

    const detail = await fetchRun("run-id");

    expect(detail.pending_prompts).toEqual([]);
    expect(detail.attachments[0]?.preview_content_type).toBeNull();
  });

  it("marks the previous prompt acknowledgement for transcript-refresh reconciliation", () => {
    const accepted = normalizeRunPromptAccepted({
      accepted: true,
      prompt_id: "22222222-2222-4222-8222-222222222222",
      message_id: "message-2",
      attachments: [],
      reactivated: false,
    });

    expect(accepted).toMatchObject({ legacy: true, ordinal: 0, status: "queued" });
  });
});
