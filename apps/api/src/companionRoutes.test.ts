import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ApiVariables } from "./context";
import { registerCompanionRoutes as registerCompanionRoutesImpl } from "./companionRoutes";

const COMPANION_ID = "11111111-1111-4111-8111-111111111111";
const TURN_ID = "22222222-2222-4222-8222-222222222222";
const MESSAGE_ID = "33333333-3333-4333-8333-333333333333";
const RETRY_ID = "44444444-4444-4444-8444-444444444444";
const OPERATION_ID = "55555555-5555-4555-8555-555555555555";
const ORG_ID = "66666666-6666-4666-8666-666666666666";
const NOW = "2026-08-17T00:00:00.000Z";

const contextMocks = vi.hoisted(() => ({
  actorFromContext: vi.fn(),
  jsonError: vi.fn(),
  orgIdFromContext: vi.fn(),
}));

const coreMocks = vi.hoisted(() => ({
  answerCompanionConfigDecisionV2: vi.fn(),
  answerCompanionDecisionV2: vi.fn(),
  readCompanionAttachmentV2: vi.fn(),
  cancelCompanionTurnV2: vi.fn(),
  createCompanionV2: vi.fn(),
  duplicateCompanionV2: vi.fn(),
  enqueueCompanionOperationV2: vi.fn(),
  enqueueCompanionTurnV2: vi.fn(),
  getCompanionDecisionV2: vi.fn(),
  getCompanionV2: vi.fn(),
  listCompanionsV2: vi.fn(),
  listCompanionRoutinesV2: vi.fn(),
  createCompanionRoutineV2: vi.fn(),
  updateCompanionRoutineV2: vi.fn(),
  deleteCompanionRoutineV2: vi.fn(),
  answerCompanionRoutineDecisionV2: vi.fn(),
  readCompanionThreadV2: vi.fn(),
  retryCompanionTurnV2: vi.fn(),
  setCompanionProviderV2: vi.fn(),
  setCompanionWorkspaceShareV2: vi.fn(),
  updateCompanionMemberStateV2: vi.fn(),
  updateCompanionV2: vi.fn(),
}));

const desktopMocks = vi.hoisted(() => ({
  mintCompanionDesktop: vi.fn(),
}));

const storageMocks = vi.hoisted(() => ({
  putSkillArchive: vi.fn(),
  getSkillArchive: vi.fn(),
  deleteStorageObject: vi.fn(),
}));

vi.mock("@companion/storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@companion/storage")>()),
  ...storageMocks,
}));

vi.mock("./context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./context")>()),
  ...contextMocks,
}));

vi.mock("@companion/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@companion/core")>()),
  ...coreMocks,
}));

vi.mock("@companion/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@companion/db")>()),
  withTenantContext: vi.fn(async (
    _context: unknown,
    fn: (database: { tenant: true }) => Promise<unknown>,
  ) => fn({ tenant: true })),
}));

vi.mock("./runtimeDesktopClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./runtimeDesktopClient")>()),
  mintCompanionDesktop: desktopMocks.mintCompanionDesktop,
}));

const owner = {
  id: "user-1",
  email: "owner@example.test",
  name: "Owner",
};

const companion = {
  id: COMPANION_ID,
  name: "Research",
  persona: "Check every source.",
  model_id: "claude-opus-4-8",
  selected_skill_ids: [],
  can_write_skills: false,
  selected_mcp_account_ids: [],
  owner_id: owner.id,
  access: "owner" as const,
  pinned: false,
  hidden: false,
  unread: false,
  last_message: null,
  runtime: {
    generation: 7,
    state: "running" as const,
    daemon_state: "running" as const,
    box_id: "bx_runtime_v2",
    provider_ids: ["anthropic"],
    provider_credential_generation: null,
    disk_layout_version: 14,
    desktop_available: true,
    last_error: null,
    skills_revision: 1,
    skills_applied_revision: 1,
    skills_applied_at: NOW,
    skills_last_error: null,
    last_observed_at: NOW,
    last_started_at: NOW,
    last_stopped_at: null,
    latest_operation: null,
  },
  created_at: NOW,
  updated_at: NOW,
};

const turn = {
  id: TURN_ID,
  companion_id: COMPANION_ID,
  client_message_id: MESSAGE_ID,
  status: "queued" as const,
  queue_sequence: 1,
  latest_attempt: null,
  replying: false,
  error: null,
  state_changed_at: NOW,
  settled_at: null,
  created_at: NOW,
  updated_at: NOW,
};

const cancelledTurn = {
  ...turn,
  status: "cancelled" as const,
  settled_at: NOW,
};

const operation = {
  id: OPERATION_ID,
  companion_id: COMPANION_ID,
  request_id: RETRY_ID,
  source_turn_id: null,
  kind: "start" as const,
  trigger: "user" as const,
  status: "pending" as const,
  queue_sequence: 1,
  checkpoint: "queued",
  attempt_count: 0,
  error: null,
  created_at: NOW,
  started_at: null,
  settled_at: null,
};

const thread = {
  companion_id: COMPANION_ID,
  viewer_id: owner.id,
  access: "owner" as const,
  read_only: false,
  can_send: true,
  entries: [],
  active_turn: null,
  queued_count: 1,
  interrupted_turn: null,
  last_message_at: NOW,
  last_read_ordinal: null,
};

const operatorTurnError = {
  code: "provider_account_revoked",
  message: "Provider account acct_internal_42 rejected credential generation 17.",
  action: "reconnect_provider" as const,
};

const operatorAttemptError = {
  code: "pi_process_crashed",
  message: "Pi exited after reading /root/.config/provider-private.json.",
  action: "restart_pi" as const,
};

const interruptedTurn = {
  ...turn,
  status: "interrupted" as const,
  latest_attempt: {
    id: "77777777-7777-4777-8777-777777777777",
    turn_id: TURN_ID,
    attempt_number: 1,
    retry_id: null,
    status: "interrupted" as const,
    dispatch_state: "ambiguous" as const,
    pi_invocation_id: "pi-invocation-operator-only",
    dispatch_accepted_at: null,
    error: operatorAttemptError,
    started_at: NOW,
    settled_at: NOW,
  },
  error: operatorTurnError,
  settled_at: NOW,
};

function threadWithInterruptedTurn(access: "owner" | "editor" | "viewer") {
  return {
    ...thread,
    access,
    read_only: access === "viewer",
    can_send: access !== "viewer",
    interrupted_turn: interruptedTurn,
  };
}

function registerCompanionRoutes(
  app: Hono<{ Variables: ApiVariables }>,
  env: NodeJS.ProcessEnv = {},
): void {
  registerCompanionRoutesImpl(app, {
    COMPANION_COMPANIONS_ALLOWED_EMAIL_DOMAINS: "example.test",
    ...env,
  });
}

function appWithRoutes() {
  const app = new Hono<{ Variables: ApiVariables }>();
  registerCompanionRoutes(app, { COMPANION_COMPANIONS_ENABLED: "true" });
  return app;
}

function jsonPost(path: string, body: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("Companions Runtime v2 API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    contextMocks.actorFromContext.mockReturnValue(owner);
    contextMocks.orgIdFromContext.mockResolvedValue(ORG_ID);
    contextMocks.jsonError.mockImplementation((_context, error: Error, status: number) =>
      Response.json({ ok: false, error: error.message }, { status }));
    coreMocks.listCompanionsV2.mockResolvedValue([companion]);
    coreMocks.getCompanionV2.mockResolvedValue(companion);
    coreMocks.readCompanionThreadV2.mockResolvedValue(thread);
    coreMocks.createCompanionV2.mockResolvedValue(companion);
    coreMocks.duplicateCompanionV2.mockResolvedValue(companion);
    coreMocks.updateCompanionV2.mockResolvedValue(companion);
    coreMocks.updateCompanionMemberStateV2.mockResolvedValue(companion);
    coreMocks.setCompanionProviderV2.mockResolvedValue(companion);
    coreMocks.setCompanionWorkspaceShareV2.mockResolvedValue({
      companion_id: COMPANION_ID,
      workspace_role: null,
    });
    coreMocks.enqueueCompanionTurnV2.mockResolvedValue({
      turn,
      operation,
      replayed: false,
    });
    coreMocks.enqueueCompanionOperationV2.mockResolvedValue({
      operation,
      replayed: false,
    });
    coreMocks.retryCompanionTurnV2.mockResolvedValue({
      operation: { ...operation, kind: "restart_pi", source_turn_id: TURN_ID },
      replayed: false,
    });
    coreMocks.cancelCompanionTurnV2.mockResolvedValue(cancelledTurn);
    coreMocks.answerCompanionDecisionV2.mockResolvedValue(undefined);
    coreMocks.readCompanionAttachmentV2.mockResolvedValue({
      storageKey: `companion-attachments/${ORG_ID}/${COMPANION_ID}/${MESSAGE_ID}/0-${"a".repeat(64)}`,
      contentType: "image/png",
      byteSize: 4,
      filename: "chart.png",
      kind: "user_upload",
    });
    storageMocks.putSkillArchive.mockResolvedValue(null);
    storageMocks.deleteStorageObject.mockResolvedValue(undefined);
    storageMocks.getSkillArchive.mockResolvedValue(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    coreMocks.answerCompanionConfigDecisionV2.mockResolvedValue(undefined);
    coreMocks.answerCompanionRoutineDecisionV2.mockResolvedValue(undefined);
    coreMocks.listCompanionRoutinesV2.mockResolvedValue([]);
    coreMocks.getCompanionDecisionV2.mockResolvedValue({
      requestKey: "question-1",
      requestKind: "question",
      decisionStatus: "pending",
      proposal: null,
      expiresAt: NOW,
    });
    desktopMocks.mintCompanionDesktop.mockResolvedValue({
      desktop_url: "https://desktop.example.test/session",
      provisioning: false,
      automation: "lux",
      transport: "webrtc",
    });
  });

  it("registers nothing unless both the feature flag and allowlist are configured", async () => {
    const flagOff = new Hono<{ Variables: ApiVariables }>();
    registerCompanionRoutes(flagOff, {});
    expect((await flagOff.request("/v1/companions")).status).toBe(404);

    const noAllowlist = new Hono<{ Variables: ApiVariables }>();
    registerCompanionRoutesImpl(noAllowlist, { COMPANION_COMPANIONS_ENABLED: "true" });
    expect((await noAllowlist.request("/v1/companions")).status).toBe(404);
    expect(contextMocks.actorFromContext).not.toHaveBeenCalled();
  });

  it("rejects a user outside the allowlist before resolving a tenant", async () => {
    contextMocks.actorFromContext.mockReturnValue({ ...owner, email: "owner@blocked.test" });
    const response = await appWithRoutes().request("/v1/companions");
    expect(response.status).toBe(403);
    expect(contextMocks.orgIdFromContext).not.toHaveBeenCalled();
    expect(coreMocks.listCompanionsV2).not.toHaveBeenCalled();
  });

  it("serves list, detail, thread, and runtime projections from PostgreSQL only", async () => {
    const app = appWithRoutes();

    const responses = await Promise.all([
      app.request("/v1/companions"),
      app.request(`/v1/companions/${COMPANION_ID}`),
      app.request(`/v1/companions/${COMPANION_ID}/thread`),
      app.request(`/v1/companions/${COMPANION_ID}/runtime`),
    ]);

    expect(responses.map((response) => response.status)).toEqual([200, 200, 200, 200]);
    expect(await responses[3]!.json()).toEqual({ companion });
    expect(coreMocks.listCompanionsV2).toHaveBeenCalledWith(expect.objectContaining({
      withLastMessage: true,
    }));
    expect(coreMocks.getCompanionV2).toHaveBeenCalledTimes(2);
    expect(coreMocks.readCompanionThreadV2).toHaveBeenCalledOnce();
    for (const response of responses) {
      expect(response.headers.get("cache-control")).toBe("private, no-store");
    }
  });

  it("replaces Viewer turn and attempt diagnostics with one generic non-actionable error", async () => {
    const viewerThread = threadWithInterruptedTurn("viewer");
    coreMocks.readCompanionThreadV2.mockResolvedValue(viewerThread);

    const response = await appWithRoutes().request(
      `/v1/companions/${COMPANION_ID}/thread`,
    );
    const payload = await response.json() as { thread: typeof viewerThread };

    expect(response.status).toBe(200);
    expect(payload.thread.interrupted_turn.error).toEqual({
      code: "runtime_unavailable",
      message: "Companion runtime needs attention.",
      action: "none",
    });
    expect(payload.thread.interrupted_turn.latest_attempt?.error).toEqual({
      code: "runtime_unavailable",
      message: "Companion runtime needs attention.",
      action: "none",
    });
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain(operatorTurnError.code);
    expect(serialized).not.toContain(operatorTurnError.message);
    expect(serialized).not.toContain(operatorAttemptError.code);
    expect(serialized).not.toContain(operatorAttemptError.message);
  });

  it.each(["owner", "editor"] as const)(
    "preserves full actionable thread diagnostics for %s access",
    async (access) => {
      const operatorThread = threadWithInterruptedTurn(access);
      coreMocks.readCompanionThreadV2.mockResolvedValue(operatorThread);

      const response = await appWithRoutes().request(
        `/v1/companions/${COMPANION_ID}/thread`,
      );
      const payload = await response.json() as { thread: typeof operatorThread };

      expect(response.status).toBe(200);
      expect(payload.thread.interrupted_turn.error).toEqual(operatorTurnError);
      expect(payload.thread.interrupted_turn.latest_attempt?.error).toEqual(operatorAttemptError);
    },
  );

  it("does not expose the retired thread sync route", async () => {
    const response = await appWithRoutes().request(
      `/v1/companions/${COMPANION_ID}/thread/sync`,
      { method: "POST" },
    );
    expect(response.status).toBe(404);
    expect(coreMocks.readCompanionThreadV2).not.toHaveBeenCalled();
  });

  it("persists a send through the v2 enqueue boundary and returns only a bounded 202 ACK", async () => {
    const app = appWithRoutes();
    const response = await app.request(jsonPost(`/v1/companions/${COMPANION_ID}/messages`, {
      content: "Summarize the incident",
      client_message_id: MESSAGE_ID,
      client_surface: "mobile_web",
    }));

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ turn });
    expect(coreMocks.enqueueCompanionTurnV2).toHaveBeenCalledWith(expect.objectContaining({
      companionId: COMPANION_ID,
      clientMessageId: MESSAGE_ID,
      content: "Summarize the incident",
      clientSurface: "mobile_web",
    }));
    expect(coreMocks.readCompanionThreadV2).not.toHaveBeenCalled();
  });

  it("stores a multipart send's files under their content address before the turn", async () => {
    const app = appWithRoutes();
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]);
    const form = new FormData();
    form.set("content", "Look at this");
    form.set("client_message_id", MESSAGE_ID);
    form.append("file", new File([png], "Q3 chart.PNG", { type: "image/png" }));
    form.append("file", new File(["a,b\n1,2\n"], "rows.csv", { type: "text/csv" }));

    const response = await app.request(new Request(
      `http://localhost/v1/companions/${COMPANION_ID}/messages`,
      { method: "POST", body: form },
    ));

    expect(response.status).toBe(202);
    expect(storageMocks.putSkillArchive).toHaveBeenCalledTimes(2);
    const attachments = coreMocks.enqueueCompanionTurnV2.mock.calls[0]?.[0].attachments;
    expect(attachments).toEqual([
      expect.objectContaining({
        content_type: "image/png",
        filename: "Q3_chart.PNG",
        byte_size: png.byteLength,
        position: 0,
      }),
      expect.objectContaining({ content_type: "text/csv", filename: "rows.csv", position: 1 }),
    ]);
    // Content-addressed: the key ends in the digest of the exact bytes, so a retried send lands on
    // the same object instead of orphaning one.
    expect(attachments?.[0].storage_key).toBe(
      `companion-attachments/${ORG_ID}/${COMPANION_ID}/${MESSAGE_ID}/0-${attachments[0].sha256}`,
    );
    expect(storageMocks.deleteStorageObject).not.toHaveBeenCalled();
  });

  it("refuses a file whose bytes are not the type it claims, before storing anything", async () => {
    const app = appWithRoutes();
    const form = new FormData();
    form.set("content", "Look at this");
    form.set("client_message_id", MESSAGE_ID);
    form.append("file", new File(["not a png at all"], "fake.png", { type: "image/png" }));

    const response = await app.request(new Request(
      `http://localhost/v1/companions/${COMPANION_ID}/messages`,
      { method: "POST", body: form },
    ));

    expect(response.status).toBe(400);
    expect(storageMocks.putSkillArchive).not.toHaveBeenCalled();
    expect(coreMocks.enqueueCompanionTurnV2).not.toHaveBeenCalled();
  });

  it("removes the objects it just stored when the turn does not persist", async () => {
    const app = appWithRoutes();
    coreMocks.enqueueCompanionTurnV2.mockRejectedValueOnce(new Error("queue is closed"));
    const form = new FormData();
    form.set("content", "Look at this");
    form.set("client_message_id", MESSAGE_ID);
    form.append("file", new File([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])], "a.pdf"));

    const response = await app.request(new Request(
      `http://localhost/v1/companions/${COMPANION_ID}/messages`,
      { method: "POST", body: form },
    ));

    expect(response.status).toBe(400);
    expect(storageMocks.deleteStorageObject).toHaveBeenCalledTimes(1);
  });

  it("refuses a Viewer's multipart send before it reads or stores a single byte", async () => {
    const app = appWithRoutes();
    coreMocks.getCompanionV2.mockResolvedValue({ ...companion, access: "viewer" });
    const form = new FormData();
    form.set("content", "Look at this");
    form.set("client_message_id", MESSAGE_ID);
    form.append("file", new File([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])], "a.pdf"));

    const response = await app.request(new Request(
      `http://localhost/v1/companions/${COMPANION_ID}/messages`,
      { method: "POST", body: form },
    ));

    expect(response.status).toBe(403);
    expect(storageMocks.putSkillArchive).not.toHaveBeenCalled();
    expect(coreMocks.enqueueCompanionTurnV2).not.toHaveBeenCalled();
  });

  it("never deletes an object it did not create when the replay conflicts", async () => {
    const app = appWithRoutes();
    // The key is the digest of the bytes, so a conflicting replay computes the very same key as the
    // accepted turn that already owns it. Deleting it would destroy a live message's attachment.
    storageMocks.putSkillArchive.mockRejectedValueOnce(
      Object.assign(new Error("PreconditionFailed"), { name: "PreconditionFailed" }),
    );
    coreMocks.enqueueCompanionTurnV2.mockRejectedValueOnce(
      Object.assign(new Error("client_message_id was reused with different message intent"), {
        code: "23505",
      }),
    );
    const form = new FormData();
    form.set("content", "Look at this");
    form.set("client_message_id", MESSAGE_ID);
    form.append("file", new File([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])], "a.pdf"));

    const response = await app.request(new Request(
      `http://localhost/v1/companions/${COMPANION_ID}/messages`,
      { method: "POST", body: form },
    ));

    expect(response.status).toBe(409);
    expect(storageMocks.deleteStorageObject).not.toHaveBeenCalled();
  });

  it("leaves an accepted turn's objects alone even if the store ignores create-only", async () => {
    const app = appWithRoutes();
    // A self-hosted object store that ignores `If-None-Match: *` would let the PUT succeed and put
    // the key in the cleanup list. A replay conflict must still never delete it.
    storageMocks.putSkillArchive.mockResolvedValueOnce(null);
    coreMocks.enqueueCompanionTurnV2.mockRejectedValueOnce(
      Object.assign(new Error("client_message_id was reused with different message intent"), {
        code: "23505",
      }),
    );
    const form = new FormData();
    form.set("content", "Look at this");
    form.set("client_message_id", MESSAGE_ID);
    form.append("file", new File([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])], "a.pdf"));

    const response = await app.request(new Request(
      `http://localhost/v1/companions/${COMPANION_ID}/messages`,
      { method: "POST", body: form },
    ));

    expect(response.status).toBe(409);
    expect(storageMocks.putSkillArchive).toHaveBeenCalled();
    expect(storageMocks.deleteStorageObject).not.toHaveBeenCalled();
  });

  it("stores each attachment create-only so a retry cannot overwrite accepted bytes", async () => {
    const app = appWithRoutes();
    const form = new FormData();
    form.set("content", "Look at this");
    form.set("client_message_id", MESSAGE_ID);
    form.append("file", new File([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])], "a.pdf"));

    await app.request(new Request(
      `http://localhost/v1/companions/${COMPANION_ID}/messages`,
      { method: "POST", body: form },
    ));

    expect(storageMocks.putSkillArchive).toHaveBeenCalledWith(
      expect.objectContaining({ preventOverwrite: true }),
    );
  });

  it("decides Companion access before the body-reading limit middleware runs", async () => {
    const app = appWithRoutes();
    coreMocks.getCompanionV2.mockResolvedValue({ ...companion, access: "viewer" });
    const form = new FormData();
    form.set("content", "Look at this");
    form.set("client_message_id", MESSAGE_ID);
    form.append("file", new File([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])], "a.pdf"));

    const response = await app.request(new Request(
      `http://localhost/v1/companions/${COMPANION_ID}/messages`,
      { method: "POST", body: form },
    ));

    // A chunked multipart request carries no Content-Length, so the body limit can only measure it
    // by buffering the whole 64 MB first. Refusing in the middleware ahead of it is what keeps an
    // unauthorized caller from costing this process that heap.
    expect(response.status).toBe(403);
    expect(coreMocks.getCompanionV2).toHaveBeenCalled();
    expect(storageMocks.putSkillArchive).not.toHaveBeenCalled();
    expect(coreMocks.enqueueCompanionTurnV2).not.toHaveBeenCalled();
  });

  it("refuses too many files and an empty file before storing anything", async () => {
    const app = appWithRoutes();
    const pdf = () => new File([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])], "a.pdf");

    for (const files of [
      [pdf(), pdf(), pdf(), pdf(), pdf(), pdf()],
      [new File([], "empty.pdf")],
    ]) {
      const form = new FormData();
      form.set("content", "Look at this");
      form.set("client_message_id", MESSAGE_ID);
      for (const file of files) form.append("file", file);
      const response = await app.request(new Request(
        `http://localhost/v1/companions/${COMPANION_ID}/messages`,
        { method: "POST", body: form },
      ));
      expect(response.status).toBe(400);
    }
    expect(storageMocks.putSkillArchive).not.toHaveBeenCalled();
    expect(coreMocks.enqueueCompanionTurnV2).not.toHaveBeenCalled();
  });

  it("refuses a file over the per-attachment ceiling without reading its bytes", async () => {
    const app = appWithRoutes();
    // A real body: the size the route checks is the one the multipart parser reports, so a stubbed
    // `size` on a File does not survive the round trip and would not exercise this bound at all.
    const form = new FormData();
    form.set("content", "Look at this");
    form.set("client_message_id", MESSAGE_ID);
    form.append("file", new File([new Uint8Array(10 * 1024 * 1024 + 1)], "big.bin"));

    const response = await app.request(new Request(
      `http://localhost/v1/companions/${COMPANION_ID}/messages`,
      { method: "POST", body: form },
    ));

    expect(response.status).toBe(400);
    expect(storageMocks.putSkillArchive).not.toHaveBeenCalled();
    expect(coreMocks.enqueueCompanionTurnV2).not.toHaveBeenCalled();
  });

  it("lets a Viewer read an attachment without contacting the Box", async () => {
    const app = appWithRoutes();
    coreMocks.getCompanionV2.mockResolvedValue({ ...companion, access: "viewer" });

    const response = await app.request(
      `http://localhost/v1/companions/${COMPANION_ID}/attachments/88888888-8888-4888-8888-888888888888`,
    );

    expect(response.status).toBe(200);
    expect(desktopMocks.mintCompanionDesktop).not.toHaveBeenCalled();
  });

  it("keeps the storage key out of the response when the object cannot be read", async () => {
    const app = appWithRoutes();
    storageMocks.getSkillArchive.mockRejectedValue(
      new Error("object not found: companion-attachments/org/companion/message/0-digest"),
    );

    const response = await app.request(
      `http://localhost/v1/companions/${COMPANION_ID}/attachments/88888888-8888-4888-8888-888888888888`,
    );
    const body = await response.text();

    expect(response.status).toBe(404);
    expect(body).not.toContain("companion-attachments/");
  });

  it("serves an attachment after re-authorizing, and never lets it be cached past that", async () => {
    const app = appWithRoutes();
    const attachmentId = "88888888-8888-4888-8888-888888888888";

    const response = await app.request(
      `http://localhost/v1/companions/${COMPANION_ID}/attachments/${attachmentId}`,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toBe("private, no-cache");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-disposition")).toBe('inline; filename="chart.png"');
    expect(coreMocks.readCompanionAttachmentV2).toHaveBeenCalledWith(expect.objectContaining({
      companionId: COMPANION_ID,
      attachmentId,
    }));
  });

  it("offers a document as a download rather than rendering it in the thread", async () => {
    const app = appWithRoutes();
    coreMocks.readCompanionAttachmentV2.mockResolvedValue({
      storageKey: "companion-attachments/org/companion/message/0-digest",
      contentType: "application/pdf",
      byteSize: 5,
      filename: "report.pdf",
      kind: "user_upload",
    });

    const response = await app.request(
      `http://localhost/v1/companions/${COMPANION_ID}/attachments/88888888-8888-4888-8888-888888888888`,
    );

    expect(response.headers.get("content-disposition")).toBe('attachment; filename="report.pdf"');
  });

  it("makes an unreadable thread and an unknown attachment indistinguishable", async () => {
    const app = appWithRoutes();
    coreMocks.readCompanionAttachmentV2.mockRejectedValue(
      Object.assign(new Error("Companion not found"), { code: "P0002" }),
    );

    const response = await app.request(
      `http://localhost/v1/companions/${COMPANION_ID}/attachments/88888888-8888-4888-8888-888888888888`,
    );

    expect(response.status).toBe(404);
    expect(storageMocks.getSkillArchive).not.toHaveBeenCalled();
  });

  it("delegates a repeated client_message_id unchanged and returns the same durable turn", async () => {
    const app = appWithRoutes();
    const body = {
      content: "Summarize the incident",
      client_message_id: MESSAGE_ID,
      client_surface: "web",
    };
    coreMocks.enqueueCompanionTurnV2
      .mockResolvedValueOnce({ turn, operation, replayed: false })
      .mockResolvedValueOnce({ turn, operation: null, replayed: true });

    const first = await app.request(jsonPost(`/v1/companions/${COMPANION_ID}/messages`, body));
    const replay = await app.request(jsonPost(`/v1/companions/${COMPANION_ID}/messages`, body));

    expect(first.status).toBe(202);
    expect(replay.status).toBe(202);
    expect(await replay.json()).toEqual(await first.json());
    expect(coreMocks.enqueueCompanionTurnV2.mock.calls.map(([input]) => input.clientMessageId))
      .toEqual([MESSAGE_ID, MESSAGE_ID]);
  });

  it("maps a conflicting client_message_id replay SQLSTATE to 409", async () => {
    coreMocks.enqueueCompanionTurnV2.mockRejectedValueOnce(Object.assign(
      new Error("query failed"),
      { cause: Object.assign(new Error("message intent differs"), { code: "23505" }) },
    ));

    const response = await appWithRoutes().request(jsonPost(
      `/v1/companions/${COMPANION_ID}/messages`,
      { content: "Different intent", client_message_id: MESSAGE_ID },
    ));

    expect(response.status).toBe(409);
  });

  it("requires a client_message_id before any durable write", async () => {
    const response = await appWithRoutes().request(
      jsonPost(`/v1/companions/${COMPANION_ID}/messages`, { content: "No id" }),
    );
    expect(response.status).toBe(400);
    expect(coreMocks.enqueueCompanionTurnV2).not.toHaveBeenCalled();
  });

  it("routes Companion creation, settings, member state, provider, and sharing through v2", async () => {
    const app = appWithRoutes();
    const responses = await Promise.all([
      app.request(jsonPost("/v1/companions", {
        name: "Research",
        provider_id: "anthropic",
        model_id: "claude-opus-4-8",
      })),
      app.request(`/v1/companions/${COMPANION_ID}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ persona: "Updated" }),
      }),
      app.request(`/v1/companions/${COMPANION_ID}/member-state`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pinned: true }),
      }),
      app.request(`/v1/companions/${COMPANION_ID}/provider`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider_id: "anthropic" }),
      }),
      app.request(`/v1/companions/${COMPANION_ID}/shares/workspace`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ role: "editor" }),
      }),
    ]);

    expect(responses.map((response) => response.status)).toEqual([201, 200, 200, 200, 200]);
    expect(coreMocks.createCompanionV2).toHaveBeenCalledOnce();
    expect(coreMocks.updateCompanionV2).toHaveBeenCalledWith(expect.objectContaining({
      patch: { persona: "Updated" },
    }));
    expect(coreMocks.updateCompanionMemberStateV2).toHaveBeenCalledOnce();
    expect(coreMocks.setCompanionProviderV2).toHaveBeenCalledOnce();
    expect(coreMocks.setCompanionWorkspaceShareV2).toHaveBeenCalledOnce();
  });

  it.each([
    ["delete", `/v1/companions/${COMPANION_ID}`, "DELETE", undefined, "delete"],
    ["start", `/v1/companions/${COMPANION_ID}/runtime/start`, "POST", {}, "start"],
    ["stop", `/v1/companions/${COMPANION_ID}/runtime/stop`, "POST", undefined, "stop"],
    ["restart Pi", `/v1/companions/${COMPANION_ID}/runtime/restart`, "POST", { target: "pi" }, "restart_pi"],
    ["restart Box", `/v1/companions/${COMPANION_ID}/runtime/restart`, "POST", { target: "box" }, "restart_box"],
  ])("accepts %s as a durable operation", async (_label, path, method, body, kind) => {
    const app = appWithRoutes();
    const response = await app.request(path, {
      method,
      headers: {
        "Idempotency-Key": RETRY_ID,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : {
        body: JSON.stringify(body),
      }),
    });

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ operation });
    expect(coreMocks.enqueueCompanionOperationV2).toHaveBeenCalledWith(expect.objectContaining({
      companionId: COMPANION_ID,
      kind,
      requestId: RETRY_ID,
    }));
  });

  it("rejects lifecycle work without a caller-owned idempotency key", async () => {
    const response = await appWithRoutes().request(
      jsonPost(`/v1/companions/${COMPANION_ID}/runtime/restart`, { target: "box" }),
    );

    expect(response.status).toBe(400);
    expect(coreMocks.enqueueCompanionOperationV2).not.toHaveBeenCalled();
  });

  it("accepts an explicit retry id as a Pi recycle operation", async () => {
    const response = await appWithRoutes().request(
      jsonPost(`/v1/companions/${COMPANION_ID}/turns/${TURN_ID}/retry`, {
        retry_id: RETRY_ID,
      }),
    );
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({
      operation: { ...operation, kind: "restart_pi", source_turn_id: TURN_ID },
    });
    expect(coreMocks.retryCompanionTurnV2).toHaveBeenCalledWith(expect.objectContaining({
      companionId: COMPANION_ID,
      turnId: TURN_ID,
      retryId: RETRY_ID,
    }));
  });

  it("cancels an interrupted turn durably and returns the refreshed thread", async () => {
    const response = await appWithRoutes().request(
      jsonPost(`/v1/companions/${COMPANION_ID}/turns/${TURN_ID}/cancel`, {}),
    );
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ turn: cancelledTurn, thread });
    expect(coreMocks.cancelCompanionTurnV2).toHaveBeenCalledWith(expect.objectContaining({
      companionId: COMPANION_ID,
      turnId: TURN_ID,
    }));
  });

  it("persists decision answers and lets Runtime deliver them", async () => {
    const response = await appWithRoutes().request(
      jsonPost(`/v1/companions/${COMPANION_ID}/decisions/question-1`, {
        action: "answer",
        answer: "Use the conservative option",
      }),
    );
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ thread });
    expect(coreMocks.answerCompanionDecisionV2).toHaveBeenCalledWith(expect.objectContaining({
      companionId: COMPANION_ID,
      requestId: "question-1",
      decision: "answer",
      text: "Use the conservative option",
    }));
    expect(coreMocks.answerCompanionConfigDecisionV2).not.toHaveBeenCalled();
    expect(coreMocks.answerCompanionRoutineDecisionV2).not.toHaveBeenCalled();
  });

  it("applies config proposals through the dedicated answer path", async () => {
    coreMocks.getCompanionDecisionV2.mockResolvedValue({
      requestKey: "config-1",
      requestKind: "config_proposal",
      decisionStatus: "pending",
      proposal: {
        kind: "config",
        add_skill_ids: ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"],
      },
      expiresAt: NOW,
    });
    const response = await appWithRoutes().request(
      jsonPost(`/v1/companions/${COMPANION_ID}/decisions/config-1`, {
        action: "allow",
      }),
    );
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ thread });
    expect(coreMocks.answerCompanionConfigDecisionV2).toHaveBeenCalledWith(expect.objectContaining({
      companionId: COMPANION_ID,
      requestId: "config-1",
      decision: "allow",
    }));
    expect(coreMocks.answerCompanionDecisionV2).not.toHaveBeenCalled();
    expect(coreMocks.answerCompanionRoutineDecisionV2).not.toHaveBeenCalled();
  });

  it("applies routine proposals through the dedicated answer path", async () => {
    coreMocks.getCompanionDecisionV2.mockResolvedValue({
      requestKey: "routine-1",
      requestKind: "routine_proposal",
      decisionStatus: "pending",
      proposal: {
        kind: "routine",
        name: "Standup",
        prompt: "Write the standup.",
        cron: "0 9 * * 1-5",
        timezone: "UTC",
      },
      expiresAt: NOW,
    });
    const response = await appWithRoutes().request(
      jsonPost(`/v1/companions/${COMPANION_ID}/decisions/routine-1`, {
        action: "allow",
      }),
    );
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ thread });
    expect(coreMocks.answerCompanionRoutineDecisionV2).toHaveBeenCalledWith(expect.objectContaining({
      companionId: COMPANION_ID,
      requestId: "routine-1",
      decision: "allow",
    }));
    expect(coreMocks.answerCompanionConfigDecisionV2).not.toHaveBeenCalled();
    expect(coreMocks.answerCompanionDecisionV2).not.toHaveBeenCalled();
  });

  it("lists and creates Companion routines", async () => {
    const routine = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companion_id: COMPANION_ID,
      name: "Standup",
      prompt: "Write the standup.",
      cron: "0 9 * * 1-5",
      timezone: "UTC",
      enabled: true,
      next_fire_at: "2026-08-20T09:00:00.000Z",
      last_fired_at: null,
      last_error_code: null,
      last_error_message: null,
      last_error_at: null,
      consecutive_failures: 0,
      created_at: NOW,
      updated_at: NOW,
    };
    coreMocks.listCompanionRoutinesV2.mockResolvedValue([routine]);
    coreMocks.createCompanionRoutineV2.mockResolvedValue(routine);
    const app = appWithRoutes();
    const listed = await app.request(`/v1/companions/${COMPANION_ID}/routines`);
    expect(listed.status).toBe(200);
    await expect(listed.json()).resolves.toEqual({ routines: [routine] });
    const created = await app.request(
      jsonPost(`/v1/companions/${COMPANION_ID}/routines`, {
        id: routine.id,
        name: routine.name,
        prompt: routine.prompt,
        cron: routine.cron,
        timezone: routine.timezone,
        enabled: true,
      }),
    );
    expect(created.status).toBe(201);
    await expect(created.json()).resolves.toEqual({ routine });
  });

  it("denies Viewer desktop access before calling the private Runtime service", async () => {
    coreMocks.getCompanionV2.mockResolvedValue({ ...companion, access: "viewer" });
    const response = await appWithRoutes().request(
      `/v1/companions/${COMPANION_ID}/runtime/desktop`,
      { method: "POST" },
    );
    expect(response.status).toBe(403);
    expect(desktopMocks.mintCompanionDesktop).not.toHaveBeenCalled();
  });

  it("mints an Owner desktop through the private Runtime client only", async () => {
    const response = await appWithRoutes().request(
      `/v1/companions/${COMPANION_ID}/runtime/desktop`,
      { method: "POST" },
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      desktop_url: "https://desktop.example.test/session",
      provisioning: false,
      automation: "lux",
      transport: "webrtc",
    });
    expect(desktopMocks.mintCompanionDesktop).toHaveBeenCalledWith(expect.objectContaining({
      actorId: owner.id,
      orgId: ORG_ID,
      companionId: COMPANION_ID,
    }));
  });
});
