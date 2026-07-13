import { beforeEach, describe, expect, it, vi } from "vitest";
import { launchRun, setModelProviderConnection, setVanishConnection } from "./runQueries";

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

  it("keeps Vanish on its distinct vault-reference route", async () => {
    await setVanishConnection("11111111-1111-4111-8111-111111111111");

    const [path, init] = request.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/v1/vanish-connection");
    expect(JSON.parse(String(init.body))).toEqual({
      secret_id: "11111111-1111-4111-8111-111111111111",
    });
    expect(String(init.body)).not.toContain("api_key");
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
