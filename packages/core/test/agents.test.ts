import { describe, expect, it } from "vitest";
import {
  AgentBusyError,
  AgentValidationError,
  buildAgentMarkdown,
  buildOpencodeJson,
  computeAgentStatus,
  createAgent,
  destroyAgent,
  generateSecretsKey,
  getAgentBySlug,
  getProvisionProgress,
  listAffectedAgents,
  listAgents,
  parseSecretsKey,
  pauseAgent,
  pushSkillUpdate,
  sandboxNameFor,
  setAgentSecrets,
  sealSecret,
  providerConnectionAad,
  type ActorContext,
  type AgentControlContext,
} from "../src/services";
import { emptyStore, fakeAgentsDb, fakeTenantRunner, type FakeStore } from "./agentsFakeDb";

const ORG = "00000000-0000-0000-0000-0000000000aa";
const me: ActorContext = { id: "user-me", email: "me@example.com", name: "Me" };
const other: ActorContext = { id: "user-other", email: "o@example.com", name: "Other" };
const KEK = parseSecretsKey(generateSecretsKey());

function sealForTest(orgId: string, userId: string, provider: string, value: string) {
  return sealSecret({ kek: KEK, plaintext: value, aad: providerConnectionAad(orgId, userId, provider) });
}

function manifestFrontmatter(requirements: Array<{ key: string; type?: "secret" | "env"; required?: boolean }>): string {
  return JSON.stringify({
    name: "x",
    description: "d",
    companion: {
      name: "x",
      environment: {
        env: {},
        secrets: Object.fromEntries(
          requirements.map((r) => [r.key, { required: r.required ?? true, description: "" }]),
        ),
      },
    },
  });
}

function seedSkill(store: FakeStore, slug: string, version: string, requirements: Array<{ key: string }> = []) {
  const skillId = `skill-${slug}`;
  const versionId = `version-${slug}-${version}`;
  store.skills.push({
    id: skillId,
    orgId: ORG,
    slug,
    scope: "org",
    creatorId: other.id,
    archivedAt: null,
    currentVersionId: versionId,
  });
  store.skillVersions.push({
    id: versionId,
    orgId: ORG,
    skillId,
    version,
    frontmatter: manifestFrontmatter(requirements),
    storagePath: `${ORG}/${slug}/${version}.tar.gz`,
    createdAt: new Date("2026-07-01T00:00:00Z"),
  });
  return { skillId, versionId };
}

function seedAgent(
  store: FakeStore,
  slug: string,
  overrides: Partial<FakeStore["agents"][number]> = {},
  pins: Array<{ slug: string; version: string }> = [],
) {
  const id = `agent-${slug}`;
  store.agents.push({
    id,
    orgId: ORG,
    slug,
    scope: "personal",
    creatorId: me.id,
    clientLabel: null,
    groupLabel: null,
    instructions: `Handles ${slug} things.`,
    model: "anthropic/claude-x",
    region: "iad1",
    lifecycle: "ready",
    sandboxName: sandboxNameFor(ORG, slug, 1),
    sandboxId: sandboxNameFor(ORG, slug, 1),
    sandboxDomain: `https://${slug}.vercel.run`,
    goldenSnapshotId: "snap-1",
    opencodeVersion: "1.17.13",
    provisionAttempt: 1,
    provisionSteps: [],
    provisionError: null,
    pendingOp: null,
    serverPasswordEnc: null,
    sessionsCache: [],
    lastResumeMs: null,
    timeoutMs: 300000,
    lastActiveAt: new Date(),
    pausedAt: null,
    createdAt: new Date("2026-06-01T00:00:00Z"),
    updatedAt: new Date("2026-06-01T00:00:00Z"),
    ...overrides,
  } as FakeStore["agents"][number]);
  for (const [index, pin] of pins.entries()) {
    store.agentSkills.push({
      orgId: ORG,
      agentId: id,
      skillId: `skill-${pin.slug}`,
      version: pin.version,
      position: index,
      pushedAt: null,
      createdAt: new Date(),
    });
  }
  return id;
}

function ctxFor(database: ReturnType<typeof fakeAgentsDb>, overrides: Partial<AgentControlContext> = {}): AgentControlContext {
  return {
    runtime: {
      provider: "vercel",
      forkFromGolden: async () => ({ sandboxId: "sb", domain: "https://x" }),
      pushSkills: async () => {},
      startServer: async () => {},
      healthCheck: async () => ({ ok: true as const, ms: 1 }),
      wake: async () => ({ domain: "https://x", resumeMs: 100 }),
      stop: async () => {},
      destroy: async () => {},
      replaceSkill: async () => {},
      restartServer: async () => {},
    },
    runTenant: fakeTenantRunner(database),
    fetchArchive: async () => Buffer.alloc(0),
    secretsKey: KEK,
    goldenSnapshotId: "snap-1",
    opencodeVersion: "1.17.13",
    region: "iad1",
    timeoutMs: 300000,
    resolveModelKeys: async (model: string) => (model.startsWith("anthropic/") ? { envKeys: ["ANTHROPIC_API_KEY"] } : null),
    ...overrides,
  };
}

describe("computeAgentStatus", () => {
  const base = { lifecycle: "ready" as const, lastActiveAt: new Date(1_000_000), pausedAt: null, timeoutMs: 300000 };
  it("derives every status without touching a sandbox", () => {
    expect(computeAgentStatus({ ...base, lifecycle: "provisioning" }, 1_000_100)).toBe("provisioning");
    expect(computeAgentStatus({ ...base, lifecycle: "error" }, 1_000_100)).toBe("error");
    expect(computeAgentStatus(base, 1_000_000 + 299_999)).toBe("running");
    expect(computeAgentStatus(base, 1_000_000 + 300_001)).toBe("sleeping");
    expect(computeAgentStatus({ ...base, pausedAt: new Date() }, 1_000_100)).toBe("sleeping");
    expect(computeAgentStatus({ ...base, lastActiveAt: null }, 1_000_100)).toBe("sleeping");
  });
});

describe("pure builders", () => {
  it("sandbox names are attempt-keyed", () => {
    expect(sandboxNameFor(ORG, "monka-support", 1)).toBe("cmp-00000000-monka-support-a1");
    expect(sandboxNameFor(ORG, "monka-support", 2)).not.toBe(sandboxNameFor(ORG, "monka-support", 1));
  });

  it("agent markdown carries mode/model/instructions", () => {
    const md = buildAgentMarkdown({ slug: "a", description: "Does things", instructions: "Be helpful.", model: "anthropic/claude-x" });
    expect(md).toContain("mode: primary");
    expect(md).toContain('"anthropic/claude-x"');
    expect(md).toContain("Be helpful.");
  });

  it("opencode.json denies edits and pins the model", () => {
    const json = JSON.parse(buildOpencodeJson({ model: "anthropic/claude-x" })) as Record<string, unknown>;
    expect(json.model).toBe("anthropic/claude-x");
    expect((json.permission as Record<string, string>).edit).toBe("deny");
    expect((json.permission as Record<string, string>).bash).toBe("allow");
  });
});

describe("listAgents", () => {
  it("separates libraries, hides other users' personal agents, computes summary + update notices", async () => {
    const store = emptyStore();
    seedSkill(store, "meeting-digest", "1.3.0");
    seedAgent(store, "mine-a", {}, [{ slug: "meeting-digest", version: "1.2.4" }]);
    seedAgent(store, "org-a", { scope: "org", creatorId: other.id, pausedAt: new Date() }, [
      { slug: "meeting-digest", version: "1.3.0" },
    ]);
    seedAgent(store, "their-personal", { creatorId: other.id });
    const database = fakeAgentsDb(store);

    const mine = await listAgents({ actor: me, orgId: ORG, library: "mine", database });
    expect(mine.agents.map((a) => a.slug)).toEqual(["mine-a"]);
    expect(mine.agents[0]?.status).toBe("running");
    expect(mine.agents[0]?.outdated_count).toBe(1);
    expect(mine.summary).toMatchObject({ total: 1, running: 1, outdated: 1 });
    expect(mine.updates).toEqual([
      expect.objectContaining({ slug: "meeting-digest", latest_version: "1.3.0", affected_count: 1 }),
    ]);

    const org = await listAgents({ actor: me, orgId: ORG, library: "org", database });
    expect(org.agents.map((a) => a.slug)).toEqual(["org-a"]);
    expect(org.agents[0]?.status).toBe("sleeping");
    expect(org.updates).toEqual([]);
  });

  it("rejects non-members", async () => {
    const database = fakeAgentsDb(emptyStore({ role: null }));
    await expect(listAgents({ actor: me, orgId: ORG, database })).rejects.toThrow("not a member");
  });
});

describe("getAgentBySlug", () => {
  it("returns detail with secret states derived from the PINNED version manifests", async () => {
    const store = emptyStore();
    seedSkill(store, "monka-triage", "2.1.0", [{ key: "ZENDESK_API_TOKEN" }, { key: "MONKA_API_KEY" }]);
    const agentId = seedAgent(store, "monka-support", {}, [{ slug: "monka-triage", version: "2.1.0" }]);
    store.agentSecrets.push({
      orgId: ORG,
      agentId,
      key: "ZENDESK_API_TOKEN",
      wrappedDek: "x",
      ciphertext: "y",
      keyVersion: 1,
      createdBy: me.id,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const database = fakeAgentsDb(store);

    const detail = await getAgentBySlug({ actor: me, orgId: ORG, slug: "monka-support", database });
    expect(detail?.slug).toBe("monka-support");
    expect(detail?.secrets).toEqual([
      expect.objectContaining({ key: "MONKA_API_KEY", set: false, required_by: ["monka-triage"] }),
      expect.objectContaining({ key: "ZENDESK_API_TOKEN", set: true }),
    ]);
    // Secret VALUES never appear anywhere in the detail payload.
    expect(JSON.stringify(detail)).not.toContain("ciphertext");
  });

  it("personal agents are invisible to non-creators — even admins", async () => {
    const store = emptyStore({ role: "admin" });
    seedAgent(store, "private-agent", { creatorId: other.id });
    const database = fakeAgentsDb(store);
    expect(await getAgentBySlug({ actor: me, orgId: ORG, slug: "private-agent", database })).toBeNull();
  });
});

describe("createAgent", () => {
  const input = {
    slug: "new-agent",
    scope: "personal" as const,
    instructions: "Do the thing.",
    model: "anthropic/claude-x",
    skills: [{ slug: "meeting-digest" }],
    secrets: { SLACK_BOT_TOKEN: "xoxb-1" },
  };

  it("inserts the row, pins, sealed secrets and audit entry", async () => {
    const store = emptyStore();
    seedSkill(store, "meeting-digest", "1.3.0", [{ key: "SLACK_BOT_TOKEN" }]);
    const database = fakeAgentsDb(store);

    const detail = await createAgent({ actor: me, orgId: ORG, input, ctx: ctxFor(database), database });
    expect(detail.slug).toBe("new-agent");
    expect(detail.status).toBe("provisioning");
    expect(detail.skills).toEqual([expect.objectContaining({ slug: "meeting-digest", version: "1.3.0" })]);
    expect(detail.provision.steps.map((s) => s.key)).toEqual(["fork", "push", "serve", "health"]);
    expect(detail.secrets).toEqual([expect.objectContaining({ key: "SLACK_BOT_TOKEN", set: true })]);

    const row = store.agents[0]!;
    expect(row.sandboxName).toBe(sandboxNameFor(ORG, "new-agent", 1));
    expect(row.serverPasswordEnc).toMatch(/^v1:.+\|v1:/);
    const secret = store.agentSecrets[0]!;
    expect(secret.key).toBe("SLACK_BOT_TOKEN");
    expect(secret.ciphertext).not.toContain("xoxb-1");
    expect(store.audit.some((a) => a.action === "agent.create")).toBe(true);
  });

  it("creation succeeds WITHOUT required secrets (the push step fails later, by design)", async () => {
    const store = emptyStore();
    seedSkill(store, "meeting-digest", "1.3.0", [{ key: "SLACK_BOT_TOKEN" }]);
    const database = fakeAgentsDb(store);
    const detail = await createAgent({
      actor: me,
      orgId: ORG,
      input: { ...input, secrets: {} },
      ctx: ctxFor(database),
      database,
    });
    expect(detail.secrets).toEqual([expect.objectContaining({ key: "SLACK_BOT_TOKEN", set: false })]);
  });

  it("seeds the model provider key from the owner's saved connection when not typed in", async () => {
    const store = emptyStore();
    seedSkill(store, "meeting-digest", "1.3.0");
    // The owner connected Anthropic once; creating an agent without re-typing the key copies it.
    store.providerConnections.push({
      orgId: ORG,
      userId: me.id,
      provider: "anthropic",
      keyName: "ANTHROPIC_API_KEY",
      ...sealForTest(ORG, me.id, "anthropic", "sk-connected"),
      keyVersion: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as (typeof store.providerConnections)[number]);
    const database = fakeAgentsDb(store);

    await createAgent({ actor: me, orgId: ORG, input: { ...input, secrets: {} }, ctx: ctxFor(database), database });
    const keyRow = store.agentSecrets.find((s) => s.key === "ANTHROPIC_API_KEY");
    expect(keyRow).toBeDefined();
    expect(keyRow?.ciphertext).not.toContain("sk-connected");
  });

  it("rejects duplicate slugs, unknown models, unknown/archived/foreign-personal skills", async () => {
    const store = emptyStore();
    seedSkill(store, "meeting-digest", "1.3.0");
    seedAgent(store, "new-agent");
    const database = fakeAgentsDb(store);
    const ctx = ctxFor(database);

    await expect(createAgent({ actor: me, orgId: ORG, input, ctx, database })).rejects.toThrow(AgentValidationError);

    const fresh = emptyStore();
    seedSkill(fresh, "meeting-digest", "1.3.0");
    const freshDb = fakeAgentsDb(fresh);
    await expect(
      createAgent({ actor: me, orgId: ORG, input: { ...input, model: "nope/none" }, ctx: ctxFor(freshDb), database: freshDb }),
    ).rejects.toThrow(/model/);
    await expect(
      createAgent({
        actor: me,
        orgId: ORG,
        input: { ...input, skills: [{ slug: "ghost" }] },
        ctx: ctxFor(freshDb),
        database: freshDb,
      }),
    ).rejects.toThrow(/ghost/);

    const withPersonal = emptyStore();
    const { skillId } = seedSkill(withPersonal, "their-skill", "1.0.0");
    withPersonal.skills.find((s) => s.id === skillId)!.scope = "personal";
    const personalDb = fakeAgentsDb(withPersonal);
    await expect(
      createAgent({
        actor: me,
        orgId: ORG,
        input: { ...input, skills: [{ slug: "their-skill" }] },
        ctx: ctxFor(personalDb),
        database: personalDb,
      }),
    ).rejects.toThrow(/their-skill/);
  });
});

describe("setAgentSecrets", () => {
  it("upserts and deletes write-only; audit logs keys only", async () => {
    const store = emptyStore();
    seedSkill(store, "monka-triage", "2.1.0", [{ key: "ZENDESK_API_TOKEN" }]);
    seedAgent(store, "monka-support", {}, [{ slug: "monka-triage", version: "2.1.0" }]);
    const database = fakeAgentsDb(store);

    const states = await setAgentSecrets({
      actor: me,
      orgId: ORG,
      slug: "monka-support",
      secrets: { ZENDESK_API_TOKEN: "zd-secret" },
      ctx: ctxFor(database),
      database,
    });
    expect(states).toEqual([expect.objectContaining({ key: "ZENDESK_API_TOKEN", set: true })]);
    expect(JSON.stringify(store.audit)).not.toContain("zd-secret");

    const after = await setAgentSecrets({
      actor: me,
      orgId: ORG,
      slug: "monka-support",
      secrets: { ZENDESK_API_TOKEN: null },
      ctx: ctxFor(database),
      database,
    });
    expect(after).toEqual([expect.objectContaining({ key: "ZENDESK_API_TOKEN", set: false })]);
  });
});

describe("destroyAgent / pauseAgent", () => {
  it("requires the exact name and cascades the row", async () => {
    const store = emptyStore();
    seedAgent(store, "doomed", {}, []);
    const database = fakeAgentsDb(store);

    await expect(
      destroyAgent({ actor: me, orgId: ORG, slug: "doomed", confirm: "nope", ctx: ctxFor(database), database }),
    ).rejects.toThrow(/confirmation/);

    const res = await destroyAgent({ actor: me, orgId: ORG, slug: "doomed", confirm: "doomed", ctx: ctxFor(database), database });
    expect(res.sandbox?.sandboxName).toBe(sandboxNameFor(ORG, "doomed", 1));
    expect(store.agents).toHaveLength(0);
    expect(store.audit.some((a) => a.action === "agent.destroy")).toBe(true);
  });

  it("pause flips pausedAt and only works on ready agents", async () => {
    const store = emptyStore();
    seedAgent(store, "runner");
    seedAgent(store, "broken", { lifecycle: "error" });
    const database = fakeAgentsDb(store);

    await pauseAgent({ actor: me, orgId: ORG, slug: "runner", database });
    expect(store.agents.find((a) => a.slug === "runner")?.pausedAt).not.toBeNull();
    await expect(pauseAgent({ actor: me, orgId: ORG, slug: "broken", database })).rejects.toThrow(/not ready/);
  });
});

describe("pushSkillUpdate", () => {
  it("sets pending_op and guards concurrent operations", async () => {
    const store = emptyStore();
    seedSkill(store, "meeting-digest", "1.3.0");
    seedAgent(store, "worker", {}, [{ slug: "meeting-digest", version: "1.2.4" }]);
    const database = fakeAgentsDb(store);

    const { op } = await pushSkillUpdate({ actor: me, orgId: ORG, slug: "worker", skillSlug: "meeting-digest", database });
    expect(op).toMatchObject({ kind: "skill-push", from_version: "1.2.4", to_version: "1.3.0", phase: "pushing" });

    await expect(
      pushSkillUpdate({ actor: me, orgId: ORG, slug: "worker", skillSlug: "meeting-digest", database }),
    ).rejects.toThrow(AgentBusyError);
  });

  it("rejects skills the agent does not run", async () => {
    const store = emptyStore();
    seedSkill(store, "meeting-digest", "1.3.0");
    seedAgent(store, "worker", {}, []);
    const database = fakeAgentsDb(store);
    await expect(
      pushSkillUpdate({ actor: me, orgId: ORG, slug: "worker", skillSlug: "meeting-digest", database }),
    ).rejects.toThrow(/does not run/);
  });
});

describe("listAffectedAgents", () => {
  it("returns only agents pinning a different version, with changelog bullets", async () => {
    const store = emptyStore();
    const { skillId, versionId } = seedSkill(store, "meeting-digest", "1.3.0");
    store.skillVersions.find((v) => v.id === versionId)!.frontmatter = JSON.stringify({
      name: "meeting-digest",
      description: "Summarize meetings.",
      companion: {
        name: "meeting-digest",
        version: "1.3.0",
        $schema: "https://companion.dev/schema/companion.json",
        metadata: {
          changelog: [
            { version: "1.3.0", changes: ["Handles multi-speaker transcripts", "New digest-weekly command"] },
            { version: "1.2.4", changes: ["Old stuff"] },
          ],
        },
      },
    });
    void skillId;
    seedAgent(store, "behind-agent", {}, [{ slug: "meeting-digest", version: "1.2.4" }]);
    seedAgent(store, "current-agent", { scope: "org" }, [{ slug: "meeting-digest", version: "1.3.0" }]);
    const database = fakeAgentsDb(store);

    const res = await listAffectedAgents({ actor: me, orgId: ORG, skillSlug: "meeting-digest", database });
    expect(res?.skill).toMatchObject({ slug: "meeting-digest", latest_version: "1.3.0" });
    expect(res?.skill.changelog).toEqual(["Handles multi-speaker transcripts", "New digest-weekly command"]);
    expect(res?.agents).toEqual([expect.objectContaining({ slug: "behind-agent", pinned_version: "1.2.4" })]);
  });
});

describe("getProvisionProgress", () => {
  it("returns the slim polling shape", async () => {
    const store = emptyStore();
    seedAgent(store, "prov", {
      lifecycle: "provisioning",
      provisionSteps: [{ key: "fork", label: "Fork snapshot", detail: "", state: "running", duration_ms: null }],
    });
    const database = fakeAgentsDb(store);
    const progress = await getProvisionProgress({ actor: me, orgId: ORG, slug: "prov", database });
    expect(progress).toMatchObject({ lifecycle: "provisioning", status: "provisioning", attempt: 1 });
    expect(progress?.steps[0]).toMatchObject({ key: "fork", state: "running" });
  });
});
