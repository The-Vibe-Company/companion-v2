import { describe, expect, it, vi } from "vitest";
import { pack as tarPack } from "tar-stream";
import { gzipSync } from "node:zlib";
import {
  AgentRuntimeError,
  generateSecretsKey,
  parseSecretsKey,
  provisionAgent,
  retryProvision,
  runSkillPush,
  sandboxNameFor,
  sealSecret,
  agentSecretAad,
  wakeAgent,
  type ActorContext,
  type AgentControlContext,
  type AgentRuntime,
} from "../src/services";
import type { ProvisionStep } from "@companion/contracts";
import { emptyStore, fakeAgentsDb, fakeTenantRunner, type FakeStore } from "./agentsFakeDb";

const ORG = "00000000-0000-0000-0000-0000000000bb";
const me: ActorContext = { id: "user-me", email: "me@example.com", name: "Me" };
const KEK = parseSecretsKey(generateSecretsKey());

function buildTarGz(files: Record<string, string | { content: string; mode: number }>): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const p = tarPack();
    const chunks: Buffer[] = [];
    p.on("data", (c: Buffer) => chunks.push(c));
    p.on("end", () => resolve(gzipSync(Buffer.concat(chunks))));
    p.on("error", reject);
    void (async () => {
      for (const [name, spec] of Object.entries(files)) {
        const content = typeof spec === "string" ? spec : spec.content;
        const mode = typeof spec === "string" ? 0o644 : spec.mode;
        await new Promise<void>((res, rej) =>
          p.entry({ name, mode, size: Buffer.byteLength(content), mtime: new Date(0) }, content, (err) =>
            err ? rej(err) : res(),
          ),
        );
      }
      p.finalize();
    })();
  });
}

const SKILL_MD = "---\nname: meeting-digest\ndescription: Summarize meetings into digests.\n---\n\n# meeting-digest\n";

interface RuntimeScript {
  failAt?: "fork" | "push" | "serve" | "health" | "replace" | "restart";
  failWith?: Error;
}

function scriptedRuntime(script: RuntimeScript = {}) {
  const calls: Array<{ op: string; args: unknown }> = [];
  const boom = (op: RuntimeScript["failAt"]) => {
    if (script.failAt === op) throw script.failWith ?? new AgentRuntimeError(`${op} exploded`);
  };
  const runtime: AgentRuntime = {
    provider: "vercel",
    forkFromGolden: async (args) => {
      calls.push({ op: "fork", args });
      boom("fork");
      return { sandboxId: args.ref.sandboxName, domain: `https://${args.ref.sandboxName}.vercel.run` };
    },
    pushSkills: async (args) => {
      calls.push({ op: "push", args });
      boom("push");
    },
    startServer: async (args) => {
      calls.push({ op: "serve", args });
      boom("serve");
    },
    healthCheck: async (args) => {
      calls.push({ op: "health", args });
      boom("health");
      return { ok: true as const, ms: 420 };
    },
    wake: async (args) => {
      calls.push({ op: "wake", args });
      return { domain: "https://woken.vercel.run", resumeMs: 2400 };
    },
    stop: async (ref) => {
      calls.push({ op: "stop", args: ref });
    },
    destroy: async (ref) => {
      calls.push({ op: "destroy", args: ref });
    },
    replaceSkill: async (args) => {
      calls.push({ op: "replace", args });
      boom("replace");
    },
    restartServer: async (args) => {
      calls.push({ op: "restart", args });
      boom("restart");
    },
  };
  return { runtime, calls };
}

function seedProvisionScenario(store: FakeStore, opts: { secretRequired?: boolean; secretSet?: boolean; modelKeySet?: boolean } = {}) {
  const skillId = "skill-meeting-digest";
  const versionId = "version-meeting-digest-1.3.0";
  store.skills.push({
    id: skillId,
    orgId: ORG,
    slug: "meeting-digest",
    scope: "org",
    creatorId: "someone",
    archivedAt: null,
    currentVersionId: versionId,
  });
  store.skillVersions.push({
    id: versionId,
    orgId: ORG,
    skillId,
    version: "1.3.0",
    frontmatter: JSON.stringify({
      name: "meeting-digest",
      description: "Summarize meetings.",
      companion: opts.secretRequired
        ? {
            name: "meeting-digest",
            environment: { env: {}, secrets: { SLACK_BOT_TOKEN: { required: true, description: "" } } },
          }
        : { name: "meeting-digest" },
    }),
    storagePath: `${ORG}/meeting-digest/1.3.0.tar.gz`,
    createdAt: new Date("2026-07-01T00:00:00Z"),
  });

  const agentId = "agent-worker";
  const password = sealSecret({ kek: KEK, plaintext: "pw-123", aad: agentSecretAad(ORG, agentId, "OPENCODE_SERVER_PASSWORD") });
  store.agents.push({
    id: agentId,
    orgId: ORG,
    slug: "worker",
    scope: "personal",
    creatorId: me.id,
    clientLabel: null,
    groupLabel: null,
    instructions: "Digest meetings.",
    model: "anthropic/claude-x",
    region: "iad1",
    lifecycle: "provisioning",
    sandboxName: sandboxNameFor(ORG, "worker", 1),
    sandboxId: null,
    sandboxDomain: null,
    goldenSnapshotId: "snap-1",
    opencodeVersion: "1.17.13",
    provisionAttempt: 1,
    provisionSteps: [
      { key: "fork", label: "Fork snapshot", detail: "", state: "pending", duration_ms: null },
      { key: "push", label: "Push 1 skill", detail: "meeting-digest", state: "pending", duration_ms: null },
      { key: "serve", label: "Start server", detail: "opencode serve --port 4096", state: "pending", duration_ms: null },
      { key: "health", label: "Health check", detail: "GET /doc → 200", state: "pending", duration_ms: null },
    ],
    provisionError: null,
    pendingOp: null,
    serverPasswordEnc: `${password.wrappedDek}|${password.ciphertext}`,
    sessionsCache: [],
    lastResumeMs: null,
    timeoutMs: 300000,
    lastActiveAt: null,
    pausedAt: null,
    createdAt: new Date("2026-07-01T00:00:00Z"),
    updatedAt: new Date("2026-07-01T00:00:00Z"),
  } as FakeStore["agents"][number]);
  store.agentSkills.push({
    orgId: ORG,
    agentId,
    skillId,
    version: "1.3.0",
    position: 0,
    pushedAt: null,
    createdAt: new Date(),
  });
  if (opts.secretSet) {
    const sealed = sealSecret({ kek: KEK, plaintext: "xoxb-1", aad: agentSecretAad(ORG, agentId, "SLACK_BOT_TOKEN") });
    store.agentSecrets.push({
      orgId: ORG,
      agentId,
      key: "SLACK_BOT_TOKEN",
      wrappedDek: sealed.wrappedDek,
      ciphertext: sealed.ciphertext,
      keyVersion: 1,
      createdBy: me.id,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }
  if (opts.modelKeySet !== false) {
    // The model provider key is a PER-AGENT secret (each user runs on their own key).
    const sealedKey = sealSecret({ kek: KEK, plaintext: "sk-user-anthropic", aad: agentSecretAad(ORG, agentId, "ANTHROPIC_API_KEY") });
    store.agentSecrets.push({
      orgId: ORG,
      agentId,
      key: "ANTHROPIC_API_KEY",
      wrappedDek: sealedKey.wrappedDek,
      ciphertext: sealedKey.ciphertext,
      keyVersion: 1,
      createdBy: me.id,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }
  return agentId;
}

async function ctxWith(
  database: ReturnType<typeof fakeAgentsDb>,
  runtime: AgentRuntime,
  overrides: Partial<AgentControlContext> = {},
): Promise<AgentControlContext> {
  const archive = await buildTarGz({
    "meeting-digest/SKILL.md": SKILL_MD,
    "meeting-digest/scripts/digest.py": { content: "#!/usr/bin/env python3\nprint('ok')\n", mode: 0o755 },
  });
  return {
    runtime,
    runTenant: fakeTenantRunner(database),
    fetchArchive: vi.fn(async () => archive),
    secretsKey: KEK,
    goldenSnapshotId: "snap-1",
    opencodeVersion: "1.17.13",
    region: "iad1",
    timeoutMs: 300000,
    resolveModelKeys: async () => ({ envKeys: ["ANTHROPIC_API_KEY"] }),
    ...overrides,
  };
}

function steps(store: FakeStore): ProvisionStep[] {
  return store.agents[0]?.provisionSteps as ProvisionStep[];
}

describe("provisionAgent — the 4-step executor", () => {
  it("happy path: all steps done, lifecycle ready, env injected with password + model key + secrets", async () => {
    const store = emptyStore();
    const agentId = seedProvisionScenario(store, { secretRequired: true, secretSet: true });
    const database = fakeAgentsDb(store);
    const { runtime, calls } = scriptedRuntime();

    await provisionAgent({ orgId: ORG, actorId: me.id, agentId, ctx: await ctxWith(database, runtime) });

    expect(steps(store).map((s) => s.state)).toEqual(["done", "done", "done", "done"]);
    expect(steps(store).every((s) => s.duration_ms !== null)).toBe(true);
    const row = store.agents[0]!;
    expect(row.lifecycle).toBe("ready");
    expect(row.sandboxId).toBe(sandboxNameFor(ORG, "worker", 1));
    expect(row.sandboxDomain).toContain("https://");
    expect(row.lastActiveAt).not.toBeNull();

    // The push carried the extracted skill folder (root stripped, executable bit preserved).
    const push = calls.find((c) => c.op === "push")?.args as {
      files: { skills: Array<{ slug: string; files: Array<{ path: string; executable: boolean }> }> };
    };
    const bundle = push.files.skills[0]!;
    expect(bundle.files.map((f) => f.path).sort()).toEqual(["SKILL.md", "scripts/digest.py"]);
    expect(bundle.files.find((f) => f.path === "scripts/digest.py")?.executable).toBe(true);

    // Serve env: password + the USER's provider key + skill secret — all from agent secrets,
    // nothing from the control-plane env; never persisted anywhere on the row.
    const serve = calls.find((c) => c.op === "serve")?.args as { env: Record<string, string> };
    expect(serve.env.OPENCODE_SERVER_PASSWORD).toBe("pw-123");
    expect(serve.env.ANTHROPIC_API_KEY).toBe("sk-user-anthropic");
    expect(serve.env.SLACK_BOT_TOKEN).toBe("xoxb-1");
    expect(JSON.stringify(store.agents[0])).not.toContain("xoxb-1");
    expect(store.audit.some((a) => a.action === "agent.provision")).toBe(true);
  });

  it("fork failure: step failed, error block persisted, sandbox stopped", async () => {
    const store = emptyStore();
    const agentId = seedProvisionScenario(store);
    const database = fakeAgentsDb(store);
    const { runtime, calls } = scriptedRuntime({
      failAt: "fork",
      failWith: new AgentRuntimeError("out of memory", { exitCode: 137 }),
    });

    await provisionAgent({ orgId: ORG, actorId: me.id, agentId, ctx: await ctxWith(database, runtime) });

    const row = store.agents[0]!;
    expect(row.lifecycle).toBe("error");
    expect(steps(store)[0]).toMatchObject({ key: "fork", state: "failed" });
    expect(row.provisionError).toMatchObject({
      message: expect.stringContaining("fork snapshot"),
      sandbox_name: sandboxNameFor(ORG, "worker", 1),
      region: "iad1",
      step: "fork",
      exit_code: 137,
    });
    expect(calls.some((c) => c.op === "stop")).toBe(true);
  });

  it("missing required secret fails the PUSH step with the designed message", async () => {
    const store = emptyStore();
    const agentId = seedProvisionScenario(store, { secretRequired: true, secretSet: false });
    const database = fakeAgentsDb(store);
    const { runtime, calls } = scriptedRuntime();

    await provisionAgent({ orgId: ORG, actorId: me.id, agentId, ctx: await ctxWith(database, runtime) });

    const row = store.agents[0]!;
    expect(row.lifecycle).toBe("error");
    expect(steps(store)[1]).toMatchObject({ key: "push", state: "failed" });
    expect(row.provisionError).toMatchObject({
      message: expect.stringContaining("meeting-digest@1.3.0 requires SLACK_BOT_TOKEN"),
      step: "push",
    });
    expect((row.provisionError as { detail: string }).detail).toContain("Set the secret, then retry");
    // The runtime never received the push — the guard runs before any bytes move.
    expect(calls.some((c) => c.op === "push")).toBe(false);
  });

  it("a missing model provider key fails the PUSH step with the designed message", async () => {
    const store = emptyStore();
    const agentId = seedProvisionScenario(store, { modelKeySet: false });
    const database = fakeAgentsDb(store);
    const { runtime, calls } = scriptedRuntime();

    await provisionAgent({ orgId: ORG, actorId: me.id, agentId, ctx: await ctxWith(database, runtime) });

    const row = store.agents[0]!;
    expect(row.lifecycle).toBe("error");
    expect(steps(store)[1]).toMatchObject({ key: "push", state: "failed" });
    expect(row.provisionError).toMatchObject({
      message: expect.stringContaining("model anthropic/claude-x requires ANTHROPIC_API_KEY"),
      step: "push",
    });
    expect((row.provisionError as { detail: string }).detail).toContain("ITS OWNER's key");
    expect(calls.some((c) => c.op === "push")).toBe(false);
  });

  it("serve/health failures persist onto their steps", async () => {
    for (const failAt of ["serve", "health"] as const) {
      const store = emptyStore();
      const agentId = seedProvisionScenario(store);
      const database = fakeAgentsDb(store);
      const { runtime } = scriptedRuntime({ failAt });
      await provisionAgent({ orgId: ORG, actorId: me.id, agentId, ctx: await ctxWith(database, runtime) });
      expect(store.agents[0]?.lifecycle).toBe("error");
      expect(steps(store).find((s) => s.key === failAt)?.state).toBe("failed");
    }
  });

  it("fails cleanly when no golden snapshot is configured", async () => {
    const store = emptyStore();
    const agentId = seedProvisionScenario(store);
    const database = fakeAgentsDb(store);
    const { runtime } = scriptedRuntime();
    await provisionAgent({
      orgId: ORG,
      actorId: me.id,
      agentId,
      ctx: await ctxWith(database, runtime, { goldenSnapshotId: null }),
    });
    expect(store.agents[0]?.lifecycle).toBe("error");
    expect((store.agents[0]?.provisionError as { message: string }).message).toContain("COMPANION_GOLDEN_SNAPSHOT_ID");
  });
});

describe("retryProvision", () => {
  it("bumps the attempt, renames the sandbox and resets progress", async () => {
    const store = emptyStore();
    seedProvisionScenario(store);
    store.agents[0]!.lifecycle = "error";
    store.agents[0]!.provisionError = { message: "boom" } as never;
    const database = fakeAgentsDb(store);

    const res = await retryProvision({ actor: me, orgId: ORG, slug: "worker", ctx: await ctxWith(database, scriptedRuntime().runtime), database });
    expect(res.attempt).toBe(2);
    const row = store.agents[0]!;
    expect(row.lifecycle).toBe("provisioning");
    expect(row.sandboxName).toBe(sandboxNameFor(ORG, "worker", 2));
    expect(row.sandboxId).toBeNull();
    expect(row.provisionError).toBeNull();
    expect((row.provisionSteps as ProvisionStep[]).every((s) => s.state === "pending")).toBe(true);
  });

  it("refuses while provisioning is already in progress", async () => {
    const store = emptyStore();
    seedProvisionScenario(store); // lifecycle: provisioning
    const database = fakeAgentsDb(store);
    await expect(
      retryProvision({ actor: me, orgId: ORG, slug: "worker", ctx: await ctxWith(database, scriptedRuntime().runtime), database }),
    ).rejects.toThrow(/already in progress/);
  });
});

describe("runSkillPush", () => {
  function readyStore(sleeping = false): FakeStore {
    const store = emptyStore();
    seedProvisionScenario(store);
    const row = store.agents[0]!;
    row.lifecycle = "ready";
    row.sandboxDomain = "https://worker.vercel.run";
    row.lastActiveAt = sleeping ? new Date(Date.now() - 3_600_000) : new Date();
    row.pendingOp = {
      kind: "skill-push",
      skill_slug: "meeting-digest",
      from_version: "1.2.4",
      to_version: "1.3.0",
      phase: "pushing",
      error: null,
      started_at: new Date().toISOString(),
    } as never;
    store.agentSkills[0]!.version = "1.2.4";
    return store;
  }

  it("replaces the folder, restarts, updates the pin through the phases", async () => {
    const store = readyStore();
    const database = fakeAgentsDb(store);
    const { runtime, calls } = scriptedRuntime();

    await runSkillPush({
      orgId: ORG,
      actorId: me.id,
      agentId: "agent-worker",
      skillSlug: "meeting-digest",
      toVersion: "1.3.0",
      ctx: await ctxWith(database, runtime),
    });

    expect(calls.map((c) => c.op)).toEqual(["replace", "restart"]);
    expect((store.agents[0]?.pendingOp as { phase: string }).phase).toBe("updated");
    expect(store.agentSkills[0]?.version).toBe("1.3.0");
    expect(store.agentSkills[0]?.pushedAt).not.toBeNull();
  });

  it("sleeping agents wake first", async () => {
    const store = readyStore(true);
    const database = fakeAgentsDb(store);
    const { runtime, calls } = scriptedRuntime();
    await runSkillPush({
      orgId: ORG,
      actorId: me.id,
      agentId: "agent-worker",
      skillSlug: "meeting-digest",
      toVersion: "1.3.0",
      ctx: await ctxWith(database, runtime),
    });
    expect(calls.map((c) => c.op)).toEqual(["wake", "replace", "restart"]);
    expect((store.agents[0]?.pendingOp as { phase: string }).phase).toBe("updated");
  });

  it("failures land in the pending_op for the UI", async () => {
    const store = readyStore();
    const database = fakeAgentsDb(store);
    const { runtime } = scriptedRuntime({ failAt: "restart" });
    await runSkillPush({
      orgId: ORG,
      actorId: me.id,
      agentId: "agent-worker",
      skillSlug: "meeting-digest",
      toVersion: "1.3.0",
      ctx: await ctxWith(database, runtime),
    });
    const op = store.agents[0]?.pendingOp as { phase: string; error: string };
    expect(op.phase).toBe("failed");
    expect(op.error).toContain("restart exploded");
    expect(store.agentSkills[0]?.version).toBe("1.2.4"); // pin untouched on failure
  });
});

describe("wakeAgent", () => {
  it("resumes, health-checks and persists the measured latency", async () => {
    const store = emptyStore();
    seedProvisionScenario(store);
    const row = store.agents[0]!;
    row.lifecycle = "ready";
    row.sandboxDomain = "https://old.vercel.run";
    row.pausedAt = new Date();
    const database = fakeAgentsDb(store);
    const { runtime, calls } = scriptedRuntime();

    const res = await wakeAgent({ actor: me, orgId: ORG, slug: "worker", ctx: await ctxWith(database, runtime) });
    expect(res).toEqual({ resumeMs: 2400, status: "running" });
    expect(calls.map((c) => c.op)).toEqual(["wake", "health"]);
    expect(row.sandboxDomain).toBe("https://woken.vercel.run");
    expect(row.lastResumeMs).toBe(2400);
    expect(row.pausedAt).toBeNull();
  });
});
