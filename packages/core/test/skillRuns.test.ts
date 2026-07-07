import { describe, expect, it } from "vitest";
import { pack as tarPack } from "tar-stream";
import { gzipSync } from "node:zlib";
import {
  createRun,
  generateSecretsKey,
  getRun,
  launchAndRecordRun,
  listRuns,
  parseSecretsKey,
  promptRun,
  RunBusyError,
  RunValidationError,
  sandboxNameForRun,
  composeRunPrompt,
  capTranscript,
  setProviderConnection,
  type ActorContext,
  type RunControlContext,
  type RunChatTarget,
} from "../src/services";
import type { RunSandboxRuntime } from "../src/runRuntime";
import type { RunChatEvent, RunChatHistoryItem } from "@companion/contracts";
import { emptyStore, fakeRunsDb, fakeTenantRunner, type FakeStore } from "./runsFakeDb";

const ORG = "00000000-0000-0000-0000-0000000000dd";
const me: ActorContext = { id: "user-me", email: "me@example.com", name: "Me" };
const other: ActorContext = { id: "user-other", email: "o@example.com", name: "Other" };
const KEK = parseSecretsKey(generateSecretsKey());
const MODEL = "anthropic/claude-sonnet-4-5";

const SKILL_MD = "---\nname: meeting-digest\ndescription: Summarize meetings into digests.\n---\n\n# meeting-digest\n";

function buildTarGz(files: Record<string, string>): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const p = tarPack();
    const chunks: Buffer[] = [];
    p.on("data", (c: Buffer) => chunks.push(c));
    p.on("end", () => resolve(gzipSync(Buffer.concat(chunks))));
    p.on("error", reject);
    void (async () => {
      for (const [name, content] of Object.entries(files)) {
        await new Promise<void>((res, rej) =>
          p.entry({ name, mode: 0o644, size: Buffer.byteLength(content), mtime: new Date(0) }, content, (err) =>
            err ? rej(err) : res(),
          ),
        );
      }
      p.finalize();
    })();
  });
}

function seedSkill(store: FakeStore, overrides: Partial<FakeStore["skills"][number]> = {}): void {
  store.skillVersions.push({
    id: "ver-1",
    orgId: ORG,
    skillId: "skill-1",
    version: "1.3.0",
    frontmatter: "{}",
    storagePath: `${ORG}/meeting-digest/1.3.0.tar.gz`,
    createdAt: new Date("2026-06-01T00:00:00Z"),
  });
  store.skills.push({
    id: "skill-1",
    orgId: ORG,
    slug: "meeting-digest",
    scope: "org",
    creatorId: me.id,
    archivedAt: null,
    currentVersionId: "ver-1",
    ...overrides,
  });
}

interface HarnessScript {
  /** Events the sandbox stream yields; the stream ends after the last one. */
  events?: RunChatEvent[];
  /** Keep the stream open until the recorder aborts it (inactivity-freeze tests). */
  hangAfterEvents?: boolean;
  /** Transcript returned by every loadItems snapshot. */
  items?: RunChatHistoryItem[];
  /** Files the sandbox artifacts/ dir contains at collection time. */
  artifactFiles?: Array<{ path: string; data: Buffer; byteSize: number }>;
  failPublishFor?: string[];
  failAt?: "fork" | "push" | "serve" | "health";
}

async function makeHarness(store: FakeStore, script: HarnessScript = {}) {
  const database = fakeRunsDb(store);
  const archive = await buildTarGz({ "SKILL.md": SKILL_MD, "scripts/run.py": "print('ok')\n" });
  const calls: Array<{ op: string; args?: unknown }> = [];
  const statusAt: Record<string, string | null> = {};
  const noteStatus = (op: string) => {
    statusAt[op] = store.runs[0]?.statusDetail ?? null;
  };
  const boom = (op: NonNullable<HarnessScript["failAt"]>) => {
    if (script.failAt === op) throw new Error(`${op} exploded`);
  };

  const runtime: RunSandboxRuntime = {
    provider: "vercel",
    forkFromGolden: async (args) => {
      calls.push({ op: "fork", args });
      noteStatus("fork");
      boom("fork");
      return { sandboxId: args.ref.sandboxName, domain: `https://${args.ref.sandboxName}.vercel.run` };
    },
    pushWorkspace: async (args) => {
      calls.push({ op: "push", args });
      noteStatus("push");
      boom("push");
    },
    startServer: async (args) => {
      calls.push({ op: "serve", args });
      noteStatus("serve");
      boom("serve");
    },
    healthCheck: async () => {
      calls.push({ op: "health" });
      boom("health");
      return { ok: true as const, ms: 42 };
    },
    stop: async () => {
      calls.push({ op: "stop" });
    },
    destroy: async () => {
      calls.push({ op: "destroy" });
    },
    collectFiles: async () => {
      calls.push({ op: "collect" });
      return script.artifactFiles ?? [];
    },
  };

  const published: Array<{ filename: string; idempotencyKey?: string }> = [];
  const ctx: RunControlContext = {
    runtime,
    runTenant: fakeTenantRunner(database),
    fetchArchive: async () => archive,
    fetchObject: async () => Buffer.from("attachment bytes"),
    secretsKey: KEK,
    goldenSnapshotId: "golden-snap-08",
    opencodeVersion: "1.17.13",
    region: "iad1",
    timeoutMs: 60_000,
    activityPollMs: 5,
    resolveModelKeys: async (model) =>
      model.startsWith("anthropic/") ? { envKeys: ["ANTHROPIC_API_KEY"] } : null,
    publishArtifact: (async (input: { filename: string; idempotencyKey?: string }) => {
      if (script.failPublishFor?.includes(input.filename)) {
        throw new Error(`publish ${input.filename} failed`);
      }
      published.push({ filename: input.filename, idempotencyKey: input.idempotencyKey });
      return { url: `https://vanish.sh/f/${input.filename}`, id: input.filename, expiresAt: null };
    }) as RunControlContext["publishArtifact"],
    chat: {
      createSession: async (_target: RunChatTarget, title?: string) => {
        calls.push({ op: "session", args: title });
        noteStatus("session");
        return { id: "ses-1", title: title ?? "run" };
      },
      sendPrompt: async (_target, _sessionId, text) => {
        calls.push({ op: "prompt", args: text });
      },
      loadItems: async () => script.items ?? [],
      streamEvents: async function* (_target, _sessionId, signal) {
        noteStatus("stream");
        for (const event of script.events ?? []) yield event;
        if (script.hangAfterEvents) {
          while (!signal.aborted) await new Promise((resolve) => setTimeout(resolve, 2));
        }
      },
    },
  };

  return { database, ctx, calls, published, statusAt };
}

async function connectAnthropicKey(store: FakeStore, actor: ActorContext = me): Promise<void> {
  await setProviderConnection({
    actor,
    orgId: ORG,
    provider: "anthropic",
    keyName: "ANTHROPIC_API_KEY",
    key: "sk-live-key",
    secretsKey: KEK,
    database: fakeRunsDb(store),
  });
}

async function connectVanishKey(store: FakeStore, actor: ActorContext = me): Promise<void> {
  await setProviderConnection({
    actor,
    orgId: ORG,
    provider: "vanish",
    keyName: "VANISH_API_KEY",
    key: "vk-live",
    secretsKey: KEK,
    database: fakeRunsDb(store),
  });
}

describe("createRun", () => {
  it("persists a starting run with a pinned version, sealed password, attachments and an audit entry", async () => {
    const store = emptyStore();
    seedSkill(store);
    await connectAnthropicKey(store);
    const { database, ctx } = await makeHarness(store);

    const detail = await createRun({
      actor: me,
      orgId: ORG,
      slug: "meeting-digest",
      prompt: "Digest the attached notes",
      model: MODEL,
      attachments: [
        { id: "att-1", fileName: "notes.txt", contentType: "text/plain", byteSize: 12, storageKey: `${ORG}/run-attachments/att-1` },
      ],
      ctx,
      database,
    });

    expect(detail.status).toBe("starting");
    expect(detail.skill_version).toBe("1.3.0");
    expect(detail.attachments).toEqual([
      { id: "att-1", file_name: "notes.txt", content_type: "text/plain", byte_size: 12 },
    ]);
    const row = store.runs[0]!;
    expect(row.serverPasswordEnc).toMatch(/\|/);
    expect(row.sandboxName).toBe(sandboxNameForRun(ORG, row.id));
    expect(store.audit.some((a) => a.action === "skill.run")).toBe(true);
  });

  it("rejects a model whose provider has no decryptable key (fails at submit, not 30s later)", async () => {
    const store = emptyStore();
    seedSkill(store);
    const { database, ctx } = await makeHarness(store);
    await expect(
      createRun({ actor: me, orgId: ORG, slug: "meeting-digest", prompt: "go", model: MODEL, attachments: [], ctx, database }),
    ).rejects.toThrow(/no API key is available/);
    expect(store.runs).toHaveLength(0);
  });

  it("never reveals another member's personal skill (404-shaped, no admin override)", async () => {
    const store = emptyStore({ role: "admin" });
    seedSkill(store, { scope: "personal", creatorId: other.id });
    await connectAnthropicKey(store);
    const { database, ctx } = await makeHarness(store);
    await expect(
      createRun({ actor: me, orgId: ORG, slug: "meeting-digest", prompt: "go", model: MODEL, attachments: [], ctx, database }),
    ).rejects.toThrow("skill not found");
  });

  it("rejects a skill with no published version", async () => {
    const store = emptyStore();
    seedSkill(store, { currentVersionId: null });
    await connectAnthropicKey(store);
    const { database, ctx } = await makeHarness(store);
    await expect(
      createRun({ actor: me, orgId: ORG, slug: "meeting-digest", prompt: "go", model: MODEL, attachments: [], ctx, database }),
    ).rejects.toThrow(/no published version/);
  });

  it("denies non-members outright", async () => {
    const store = emptyStore({ role: null });
    seedSkill(store);
    const { database, ctx } = await makeHarness(store);
    await expect(
      createRun({ actor: me, orgId: ORG, slug: "meeting-digest", prompt: "go", model: MODEL, attachments: [], ctx, database }),
    ).rejects.toThrow();
  });
});

async function launchSeededRun(store: FakeStore, script: HarnessScript = {}) {
  const harness = await makeHarness(store, script);
  const detail = await createRun({
    actor: me,
    orgId: ORG,
    slug: "meeting-digest",
    prompt: "Digest my notes",
    model: MODEL,
    attachments: [],
    ctx: harness.ctx,
    database: harness.database,
  });
  await launchAndRecordRun({ orgId: ORG, actorId: me.id, runId: detail.id, ctx: harness.ctx });
  return { ...harness, runId: detail.id };
}

describe("launchAndRecordRun", () => {
  it("walks the launch steps (status_detail per step), goes running, then freezes when the stream ends", async () => {
    const store = emptyStore();
    seedSkill(store);
    await connectAnthropicKey(store);
    const items: RunChatHistoryItem[] = [
      { kind: "user", text: "Digest my notes" },
      { kind: "assistant", text: "Here is the digest." },
    ];
    const { statusAt, calls, runId } = await launchSeededRun(store, {
      events: [{ type: "session.idle", session_id: "ses-1" }],
      items,
    });

    expect(statusAt.fork).toBe("Preparing sandbox");
    expect(statusAt.push).toBe("Installing skill");
    expect(statusAt.serve).toBe("Starting agent");
    // By the time the recorder subscribed, the row was live.
    const row = store.runs[0]!;
    expect(row.id).toBe(runId);
    expect(row.opencodeSessionId).toBe("ses-1");
    // The stream ended → the run froze with a final snapshot and a stopped sandbox.
    expect(row.status).toBe("frozen");
    expect(row.frozenAt).not.toBeNull();
    expect(row.transcript).toEqual(items);
    expect(calls.some((c) => c.op === "stop")).toBe(true);
  });

  it("composes the first prompt with the skill nudge (attachments/artifacts lines only when relevant)", async () => {
    const store = emptyStore();
    seedSkill(store);
    await connectAnthropicKey(store);
    const { calls } = await launchSeededRun(store, { events: [] });
    const prompt = calls.find((c) => c.op === "prompt")?.args as string;
    expect(prompt).toContain('Use your installed "meeting-digest" skill');
    expect(prompt).not.toContain("./attachments/");
    expect(prompt).not.toContain("./artifacts/");
  });

  it("includes the artifacts instruction when the launcher has a Vanish key", async () => {
    const store = emptyStore();
    seedSkill(store);
    await connectAnthropicKey(store);
    await connectVanishKey(store);
    const { calls } = await launchSeededRun(store, { events: [] });
    const prompt = calls.find((c) => c.op === "prompt")?.args as string;
    expect(prompt).toContain("Save any deliverable files into ./artifacts/");
  });

  it("a prelude failure (undecryptable password) lands in error, never a stuck starting", async () => {
    const store = emptyStore();
    seedSkill(store);
    await connectAnthropicKey(store);
    const { database, ctx } = await makeHarness(store);
    const detail = await createRun({
      actor: me,
      orgId: ORG,
      slug: "meeting-digest",
      prompt: "go",
      model: MODEL,
      attachments: [],
      ctx,
      database,
    });
    store.runs[0]!.serverPasswordEnc = "corrupted";
    await launchAndRecordRun({ orgId: ORG, actorId: me.id, runId: detail.id, ctx });
    expect(store.runs[0]!.status).toBe("error");
    expect(store.runs[0]!.statusDetail).toMatch(/malformed/);
  });

  it("a step failure lands in error with the step message and stops the sandbox", async () => {
    const store = emptyStore();
    seedSkill(store);
    await connectAnthropicKey(store);
    const { calls } = await launchSeededRun(store, { failAt: "serve" });
    expect(store.runs[0]!.status).toBe("error");
    expect(store.runs[0]!.statusDetail).toMatch(/serve exploded/);
    expect(calls.some((c) => c.op === "stop")).toBe(true);
  });

  it("freezes after the inactivity window even when the stream stays open", async () => {
    const store = emptyStore();
    seedSkill(store);
    await connectAnthropicKey(store);
    const harness = await makeHarness(store, { hangAfterEvents: true, events: [] });
    harness.ctx.timeoutMs = 30;
    const detail = await createRun({
      actor: me,
      orgId: ORG,
      slug: "meeting-digest",
      prompt: "go",
      model: MODEL,
      attachments: [],
      ctx: harness.ctx,
      database: harness.database,
    });
    await launchAndRecordRun({ orgId: ORG, actorId: me.id, runId: detail.id, ctx: harness.ctx });
    expect(store.runs[0]!.status).toBe("frozen");
  });

  it("publishes new artifacts on idle, skipping blocked extensions and already-published paths", async () => {
    const store = emptyStore();
    seedSkill(store);
    await connectAnthropicKey(store);
    await connectVanishKey(store);
    const files = [
      { path: "report.html", data: Buffer.from("<h1>r</h1>"), byteSize: 10 },
      { path: "run.sh", data: Buffer.from("#!/bin/sh"), byteSize: 9 },
    ];
    const { published, runId } = await launchSeededRun(store, {
      // Two idles → two collections; the second must dedup report.html by path.
      events: [
        { type: "session.idle", session_id: "ses-1" },
        { type: "session.idle", session_id: "ses-1" },
      ],
      items: [{ kind: "assistant", text: "done" }],
      artifactFiles: files,
    });
    expect(published).toEqual([
      { filename: "report.html", idempotencyKey: `${runId}:report.html:10` },
    ]);
    expect(store.runArtifacts).toHaveLength(1);
    expect(store.runArtifacts[0]!.contentType).toBe("text/html");
    expect(store.runArtifacts[0]!.url).toBe("https://vanish.sh/f/report.html");
  });

  it("skips artifact collection entirely without a Vanish key", async () => {
    const store = emptyStore();
    seedSkill(store);
    await connectAnthropicKey(store);
    const { calls } = await launchSeededRun(store, {
      events: [{ type: "session.idle", session_id: "ses-1" }],
      artifactFiles: [{ path: "report.html", data: Buffer.from("x"), byteSize: 1 }],
    });
    expect(calls.some((c) => c.op === "collect")).toBe(false);
    expect(store.runArtifacts).toHaveLength(0);
  });

  it("a publish failure inserts nothing and does not break the run", async () => {
    const store = emptyStore();
    seedSkill(store);
    await connectAnthropicKey(store);
    await connectVanishKey(store);
    const { runId } = await launchSeededRun(store, {
      events: [{ type: "session.idle", session_id: "ses-1" }],
      artifactFiles: [{ path: "report.html", data: Buffer.from("x"), byteSize: 1 }],
      failPublishFor: ["report.html"],
    });
    expect(store.runArtifacts).toHaveLength(0);
    expect(store.runs.find((r) => r.id === runId)!.status).toBe("frozen");
  });
});

describe("reads + privacy + recovery", () => {
  it("listRuns returns only the caller's runs, newest first", async () => {
    const store = emptyStore();
    seedSkill(store);
    await connectAnthropicKey(store);
    const { database, ctx } = await makeHarness(store);
    await createRun({ actor: me, orgId: ORG, slug: "meeting-digest", prompt: "one", model: MODEL, attachments: [], ctx, database });
    // Another member's run of the same skill, injected directly.
    store.runs.push({
      ...store.runs[0]!,
      id: "run-other",
      creatorId: other.id,
      prompt: "theirs",
    });

    const mine = await listRuns({ actor: me, orgId: ORG, slug: "meeting-digest", jobAlive: () => true, database });
    expect(mine).toHaveLength(1);
    expect(mine[0]!.prompt_excerpt).toBe("one");
  });

  it("getRun 404s for anyone but the creator (admins included)", async () => {
    const store = emptyStore({ role: "admin" });
    seedSkill(store);
    await connectAnthropicKey(store);
    const { database, ctx } = await makeHarness(store);
    const detail = await createRun({ actor: me, orgId: ORG, slug: "meeting-digest", prompt: "go", model: MODEL, attachments: [], ctx, database });
    await expect(
      getRun({ actor: other, orgId: ORG, runId: detail.id, jobAlive: () => true, database }),
    ).rejects.toThrow("run not found");
  });

  it("recovers an orphaned starting run as error, and an orphaned running run as frozen", async () => {
    const store = emptyStore();
    seedSkill(store);
    await connectAnthropicKey(store);
    const { database, ctx } = await makeHarness(store);
    const a = await createRun({ actor: me, orgId: ORG, slug: "meeting-digest", prompt: "a", model: MODEL, attachments: [], ctx, database });
    const starting = await getRun({ actor: me, orgId: ORG, runId: a.id, jobAlive: () => false, database });
    expect(starting.status).toBe("error");
    expect(starting.status_detail).toMatch(/Interrupted/);

    store.runs[0]!.status = "running";
    store.runs[0]!.statusDetail = null;
    const running = await getRun({ actor: me, orgId: ORG, runId: a.id, jobAlive: () => false, database });
    expect(running.status).toBe("frozen");
    expect(running.status_detail).toMatch(/Interrupted/);
  });

  it("promptRun on a frozen run raises the designed 409", async () => {
    const store = emptyStore();
    seedSkill(store);
    await connectAnthropicKey(store);
    const { database, ctx } = await makeHarness(store);
    const detail = await createRun({ actor: me, orgId: ORG, slug: "meeting-digest", prompt: "go", model: MODEL, attachments: [], ctx, database });
    store.runs[0]!.status = "frozen";
    const error = await promptRun({ actor: me, orgId: ORG, runId: detail.id, text: "more", ctx, database }).catch((e) => e);
    expect(error).toBeInstanceOf(RunBusyError);
    expect(error.message).toMatch(/This session has ended/);
  });

  it("promptRun on a live run sends the text and bumps activity", async () => {
    const store = emptyStore();
    seedSkill(store);
    await connectAnthropicKey(store);
    const { database, ctx, calls } = await makeHarness(store);
    const detail = await createRun({ actor: me, orgId: ORG, slug: "meeting-digest", prompt: "go", model: MODEL, attachments: [], ctx, database });
    Object.assign(store.runs[0]!, {
      status: "running",
      sandboxDomain: "https://run.vercel.run",
      opencodeSessionId: "ses-9",
    });
    await promptRun({ actor: me, orgId: ORG, runId: detail.id, text: "follow up", ctx, database });
    expect(calls.some((c) => c.op === "prompt" && c.args === "follow up")).toBe(true);
    expect(store.runs[0]!.lastActiveAt).not.toBeNull();
  });
});

describe("helpers", () => {
  it("composeRunPrompt lists attachments by name", () => {
    const prompt = composeRunPrompt({
      prompt: "Summarize",
      skillSlug: "digest",
      attachmentNames: ["a.txt", "b.pdf"],
      artifactsEnabled: false,
    });
    expect(prompt).toContain("./attachments/: a.txt, b.pdf");
  });

  it("capTranscript trims oldest tool outputs before dropping items", () => {
    const big = "x".repeat(300 * 1024);
    const items: RunChatHistoryItem[] = [
      { kind: "tool", call_id: "c1", tool: "bash", skill: null, title: null, input: "", output: big, duration_ms: 1 },
      { kind: "tool", call_id: "c2", tool: "bash", skill: null, title: null, input: "", output: big, duration_ms: 1 },
      { kind: "assistant", text: "final answer" },
    ];
    const capped = capTranscript(items);
    expect(capped[capped.length - 1]).toEqual({ kind: "assistant", text: "final answer" });
    expect(Buffer.byteLength(JSON.stringify(capped), "utf8")).toBeLessThanOrEqual(512 * 1024);
    expect(capped.some((i) => i.kind === "tool" && i.output === "…(trimmed)")).toBe(true);
  });

  it("errors surface as the designed classes", () => {
    expect(new RunValidationError("x")).toBeInstanceOf(Error);
    expect(new RunBusyError("x")).toBeInstanceOf(Error);
  });
});
