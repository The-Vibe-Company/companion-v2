import { gzipSync } from "node:zlib";
import { pack as tarPack } from "tar-stream";
import { describe, expect, it, vi } from "vitest";
import { fallbackCompanionManifest, type RunDeclaredSecret, type RunDeclaredVariable } from "@companion/contracts";
import { schema, type Db } from "@companion/db";
import {
  RunBusyError,
  RunValidationError,
  assertRunDependencyPinsMatch,
  attachmentWorkspacePath,
  buildOpencodeJson,
  buildSkillBundle,
  capTranscript,
  composeRunPrompt,
  createRun,
  deterministicRunMessageId,
  hashRunCreationPayload,
  hashRunPayload,
  loadRunDeclarations,
  materializeRunWorkspace,
  materializeRunAttachmentFiles,
  normalizeRunTranscript,
  resolveRunDependencyClosure,
  sandboxNameForRun,
  validateRunInputSelection,
  validateRunMessageAttachments,
  type ResolvedRunSkill,
  type RunControlContext,
} from "../src/skillRuns";
import type { ActorContext } from "../src/services";

const ORG = "00000000-0000-0000-0000-000000000001";
const ROOT = "10000000-0000-0000-0000-000000000001";
const DEP = "10000000-0000-0000-0000-000000000002";
const ROOT_VERSION = "20000000-0000-0000-0000-000000000001";
const DEP_VERSION = "20000000-0000-0000-0000-000000000002";
const SLOT = "30000000-0000-0000-0000-000000000001";
const SECRET = "40000000-0000-0000-0000-000000000001";
const PROVIDER_CONNECTION = "40000000-0000-0000-0000-000000000002";
const actor: ActorContext = { id: "user-me", email: "me@example.com", name: "Me" };

interface ClosureStore {
  skills: Array<Record<string, unknown>>;
  versions: Array<Record<string, unknown>>;
  dependencies: Array<Record<string, unknown>>;
  slots?: Array<Record<string, unknown>>;
  bindings?: Array<Record<string, unknown>>;
}

function fakeClosureDb(store: ClosureStore): Db {
  return {
    select: () => ({
      from: (table: unknown) => ({
        where: async () => {
          if (table === schema.skills) return store.skills;
          if (table === schema.skillVersions) return store.versions;
          if (table === schema.skillVersionDependencies) return store.dependencies;
          if (table === schema.skillVersionSecretSlots) return store.slots ?? [];
          if (table === schema.skillSecretBindings) return store.bindings ?? [];
          throw new Error("unexpected table");
        },
      }),
    }),
  } as unknown as Db;
}

function manifest(env: Record<string, { required: boolean; description: string }> = {}): string {
  return JSON.stringify({
    companion: fallbackCompanionManifest({ summary: "Test skill", environment: { env, secrets: {} } }),
  });
}

function baseClosureStore(): ClosureStore {
  return {
    skills: [
      {
        id: ROOT,
        slug: "root-skill",
        scope: "org",
        creatorId: actor.id,
        archivedAt: null,
        currentVersionId: ROOT_VERSION,
      },
      {
        id: DEP,
        slug: "dep-skill",
        scope: "org",
        creatorId: "other",
        archivedAt: null,
        currentVersionId: DEP_VERSION,
      },
    ],
    versions: [
      {
        id: ROOT_VERSION,
        skillId: ROOT,
        version: "1.2.0",
        frontmatter: manifest({ REGION: { required: true, description: "Region" } }),
        storagePath: "root.tgz",
      },
      {
        id: DEP_VERSION,
        skillId: DEP,
        version: "2.0.1",
        frontmatter: manifest(),
        storagePath: "dep.tgz",
      },
    ],
    dependencies: [
      { skillVersionId: ROOT_VERSION, dependsOnSlug: "dep-skill", dependsOnSkillId: DEP },
    ],
  };
}

describe("dependency closure", () => {
  it("pins the exact root and every exact current dependency in deterministic mount order", async () => {
    const closure = await resolveRunDependencyClosure({
      actor,
      orgId: ORG,
      slug: "root-skill",
      skillVersionId: ROOT_VERSION,
      database: fakeClosureDb(baseClosureStore()),
    });
    expect(closure.map(({ slug, version, root, mountOrder }) => ({ slug, version, root, mountOrder }))).toEqual([
      { slug: "root-skill", version: "1.2.0", root: true, mountOrder: 0 },
      { slug: "dep-skill", version: "2.0.1", root: false, mountOrder: 1 },
    ]);
    expect(() =>
      assertRunDependencyPinsMatch(closure, [{ skill_id: DEP, skill_version_id: DEP_VERSION }]),
    ).not.toThrow();
    expect(() =>
      assertRunDependencyPinsMatch(closure, [{ skill_id: DEP, skill_version_id: ROOT_VERSION }]),
    ).toThrow(/dependency graph changed/);
    expect(() => assertRunDependencyPinsMatch(closure, [])).toThrow(/dependency graph changed/);
  });

  it("fails closed when the launcher version is stale", async () => {
    await expect(
      resolveRunDependencyClosure({
        actor,
        orgId: ORG,
        slug: "root-skill",
        skillVersionId: DEP_VERSION,
        database: fakeClosureDb(baseClosureStore()),
      }),
    ).rejects.toMatchObject({ code: "stale_skill_version" });
  });

  it("detects cycles and inaccessible personal dependencies", async () => {
    const cyclic = baseClosureStore();
    cyclic.dependencies.push({
      skillVersionId: DEP_VERSION,
      dependsOnSlug: "root-skill",
      dependsOnSkillId: ROOT,
    });
    await expect(
      resolveRunDependencyClosure({
        actor,
        orgId: ORG,
        slug: "root-skill",
        skillVersionId: ROOT_VERSION,
        database: fakeClosureDb(cyclic),
      }),
    ).rejects.toMatchObject({ code: "dependency_cycle" });

    const privateDependency = baseClosureStore();
    Object.assign(privateDependency.skills[1]!, { scope: "personal", creatorId: "another-user" });
    await expect(
      resolveRunDependencyClosure({
        actor,
        orgId: ORG,
        slug: "root-skill",
        skillVersionId: ROOT_VERSION,
        database: fakeClosureDb(privateDependency),
      }),
    ).rejects.toMatchObject({ code: "dependency_unavailable" });
  });

  it("reports a missing edge without revealing another resource", async () => {
    const store = baseClosureStore();
    store.dependencies[0]!.dependsOnSkillId = null;
    await expect(
      resolveRunDependencyClosure({
        actor,
        orgId: ORG,
        slug: "root-skill",
        skillVersionId: ROOT_VERSION,
        database: fakeClosureDb(store),
      }),
    ).rejects.toMatchObject({ code: "dependency_missing" });
  });
});

describe("declarations and explicit inputs", () => {
  const secretDeclaration: RunDeclaredSecret = {
    skill_id: ROOT,
    skill_version_id: ROOT_VERSION,
    skill_slug: "root-skill",
    slot_id: SLOT,
    env_key: "API_TOKEN",
    description: "API token",
    required: true,
    candidates: [],
    prefill_secret_id: null,
  };
  const variableDeclaration: RunDeclaredVariable = {
    skill_id: ROOT,
    skill_version_id: ROOT_VERSION,
    skill_slug: "root-skill",
    env_key: "REGION",
    description: "Region",
    required: true,
  };
  const pin = (secretId: string) => ({
    secretId,
    version: 3,
    key: "API_TOKEN",
    name: "Token",
    ownerId: actor.id,
    ownerName: actor.name,
    audience: "personal" as const,
  });
  const providerPin = {
    connectionId: PROVIDER_CONNECTION,
    credentialVersion: 3,
    provider: "anthropic",
    keyName: "ANTHROPIC_API_KEY",
    scope: "personal" as const,
  };
  const validate = (overrides: Partial<Parameters<typeof validateRunInputSelection>[0]> = {}) =>
    validateRunInputSelection({
      actor,
      orgId: ORG,
      model: "anthropic/claude-sonnet",
      modelEnvKeys: ["ANTHROPIC_API_KEY"],
      modelProviderConnectionId: PROVIDER_CONNECTION,
      modelProviderCredentialVersion: 3,
      selection: {
        secrets: [{ skill_id: ROOT, slot_id: SLOT, secret_id: SECRET }],
        variables: [{ skill_id: ROOT, env_key: "REGION", value: "eu-west-1" }],
      },
      declarations: { secrets: [secretDeclaration], variables: [variableDeclaration] },
      database: {} as Db,
      pinSecret: async (id) => pin(id),
      providerPin,
      ...overrides,
    });

  it("parses variables from every exact manifest and slots from the exact version table", async () => {
    const store = baseClosureStore();
    store.slots = [
      {
        orgId: ORG,
        skillId: ROOT,
        skillVersionId: ROOT_VERSION,
        slotId: SLOT,
        envKey: "API_TOKEN",
        description: "API token",
        required: true,
      },
    ];
    const closure = (await resolveRunDependencyClosure({
      actor,
      orgId: ORG,
      slug: "root-skill",
      skillVersionId: ROOT_VERSION,
      database: fakeClosureDb(store),
    })) as ResolvedRunSkill[];
    const declarations = await loadRunDeclarations({
      actor,
      orgId: ORG,
      closure,
      database: fakeClosureDb(store),
    });
    expect(declarations.secrets.map((row) => row.env_key)).toEqual(["API_TOKEN"]);
    expect(declarations.variables.map((row) => row.env_key)).toEqual(["REGION"]);
  });

  it("keeps selected vault secrets separate from the exact model-provider snapshot", async () => {
    const resolved = await validate();
    expect(resolved.secrets.map((row) => [row.provenance, row.envKey, row.pin.secretId])).toEqual([
      ["skill", "API_TOKEN", SECRET],
    ]);
    expect(resolved.modelProvider).toEqual({ ...providerPin, envKey: "ANTHROPIC_API_KEY" });
    expect(resolved.variables).toEqual([
      { skillId: ROOT, skillSlug: "root-skill", envKey: "REGION", value: "eu-west-1" },
    ]);
  });

  it("never adds a model provider credential that was not explicitly pinned by the launcher", async () => {
    await expect(
      validate({ modelProviderConnectionId: null, modelProviderCredentialVersion: null }),
    ).rejects.toMatchObject({ code: "provider_credential_missing" });
    await expect(
      validate({ modelProviderConnectionId: SECRET }),
    ).rejects.toMatchObject({ code: "provider_credential_unavailable" });
    await expect(
      validate({ modelProviderCredentialVersion: 2 }),
    ).rejects.toMatchObject({ code: "provider_credential_unavailable" });
  });

  it("uses the latest provider pin at commit instead of a stale launcher observation", async () => {
    const latest = { ...providerPin, credentialVersion: 4 };
    const resolved = await validate({
      modelProviderCredentialVersion: 3,
      providerPin: latest,
      requireExplicitProviderSelection: false,
    });
    expect(resolved.modelProvider).toEqual({ ...latest, envKey: "ANTHROPIC_API_KEY" });
  });

  it("rejects missing required, unknown, duplicate and invalid variable inputs", async () => {
    await expect(validate({ selection: { secrets: [], variables: [] } })).rejects.toMatchObject({
      code: "required_secret_missing",
    });
    await expect(
      validate({
        selection: {
          secrets: [{ skill_id: DEP, slot_id: SLOT, secret_id: SECRET }],
          variables: [{ skill_id: ROOT, env_key: "REGION", value: "eu" }],
        },
      }),
    ).rejects.toMatchObject({ code: "unknown_secret_slot" });
    await expect(
      validate({
        selection: {
          secrets: [
            { skill_id: ROOT, slot_id: SLOT, secret_id: SECRET },
            { skill_id: ROOT, slot_id: SLOT, secret_id: SECRET },
          ],
          variables: [{ skill_id: ROOT, env_key: "REGION", value: "eu" }],
        },
      }),
    ).rejects.toMatchObject({ code: "duplicate_secret_slot" });
    await expect(
      validate({
        selection: {
          secrets: [{ skill_id: ROOT, slot_id: SLOT, secret_id: SECRET }],
          variables: [{ skill_id: ROOT, env_key: "REGION", value: "bad\0value" }],
        },
      }),
    ).rejects.toMatchObject({ code: "invalid_variable_value" });
  });

  it("rejects every provider/vault collision because the credential domains are separate", async () => {
    const sameProviderDeclaration = { ...secretDeclaration, env_key: "ANTHROPIC_API_KEY" };
    await expect(
      validate({
        declarations: { secrets: [sameProviderDeclaration], variables: [] },
        selection: { secrets: [{ skill_id: ROOT, slot_id: SLOT, secret_id: SECRET }], variables: [] },
        pinSecret: async () => pin(SECRET),
      }),
    ).rejects.toMatchObject({ code: "input_collision" });

    await expect(
      validate({
        declarations: { secrets: [sameProviderDeclaration], variables: [] },
        selection: { secrets: [{ skill_id: ROOT, slot_id: SLOT, secret_id: SECRET }], variables: [] },
      }),
    ).rejects.toMatchObject({ code: "input_collision" });

    await expect(
      validate({
        declarations: {
          secrets: [secretDeclaration],
          variables: [{ ...variableDeclaration, env_key: "API_TOKEN" }],
        },
        selection: {
          secrets: [{ skill_id: ROOT, slot_id: SLOT, secret_id: SECRET }],
          variables: [{ skill_id: ROOT, env_key: "API_TOKEN", value: "plain" }],
        },
      }),
    ).rejects.toMatchObject({ code: "input_collision" });
  });

  it("never adds the install binding when the explicit selection is empty", async () => {
    const resolved = await validate({
      declarations: { secrets: [{ ...secretDeclaration, required: false }], variables: [] },
      selection: { secrets: [], variables: [] },
      providerRequired: false,
      providerPin: null,
      modelProviderConnectionId: null,
      modelProviderCredentialVersion: null,
    });
    expect(resolved.secrets).toEqual([]);
    expect(resolved.modelProvider).toBeNull();
  });
});

function archive(files: Record<string, string>): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const pack = tarPack();
    const chunks: Buffer[] = [];
    pack.on("data", (chunk: Buffer) => chunks.push(chunk));
    pack.on("end", () => resolve(gzipSync(Buffer.concat(chunks))));
    pack.on("error", reject);
    for (const [name, value] of Object.entries(files)) pack.entry({ name }, value);
    pack.finalize();
  });
}

describe("workspace and durable helper invariants", () => {
  it("mounts root + dependencies and prefixes homonymous attachments with their ids", async () => {
    const rootArchive = await archive({ "root/SKILL.md": "# Root" });
    const depArchive = await archive({ "dep/SKILL.md": "# Dep" });
    const files = await materializeRunWorkspace({
      plan: {
        row: { model: "anthropic/claude" } as never,
        creator: actor,
        skills: [
          { slug: "root-skill", version: "1.0.0", storagePath: "root" },
          { slug: "dep-skill", version: "2.0.0", storagePath: "dep" },
        ],
        attachments: [
          { id: "a-id", fileName: "notes.txt", contentType: "text/plain", byteSize: 1, storageKey: "a" },
          { id: "b-id", fileName: "notes.txt", contentType: "text/plain", byteSize: 1, storageKey: "b" },
        ],
        env: {},
        injectedLiterals: [],
        serverPassword: "password",
      },
      fetchArchive: async (path) => (path === "root" ? rootArchive : depArchive),
      fetchObject: async (key) => Buffer.from(key),
    });
    expect(files.skills.map((skill) => skill.slug)).toEqual(["root-skill", "dep-skill"]);
    expect(files.attachments.map((item) => item.path)).toEqual(["a-id-notes.txt", "b-id-notes.txt"]);
  });

  it("materializes follow-up attachment bytes under stable id-prefixed paths", async () => {
    const files = await materializeRunAttachmentFiles({
      attachments: [{
        id: "follow-up-id",
        fileName: "../brief.pdf",
        contentType: "application/pdf",
        byteSize: 4,
        storageKey: "stored/follow-up",
      }],
      fetchObject: async (key) => Buffer.from(key === "stored/follow-up" ? "data" : ""),
    });
    expect(files).toEqual([{ path: "follow-up-id-brief.pdf", data: Buffer.from("data") }]);
  });

  it("rejects unsafe archives", async () => {
    const unsafe = await archive({ "../escape.txt": "oops", "SKILL.md": "# Skill" });
    await expect(buildSkillBundle("root", "1.0.0", "path", async () => unsafe)).rejects.toThrow(
      /safety checks/,
    );
  });

  it("keeps deterministic ids/hashes stable and payload-sensitive", () => {
    const createdAt = Date.UTC(2026, 6, 13, 12, 0, 0);
    const messageId = deterministicRunMessageId("run-1", 2, createdAt);
    expect(messageId).toBe(deterministicRunMessageId("run-1", 2, createdAt));
    expect(messageId).not.toBe(deterministicRunMessageId("run-1", 3, createdAt));
    expect(messageId).toMatch(/^msg_[0-9A-Za-z]{26}$/);

    const assistantOneTime = ((BigInt(createdAt + 1) * 0x1000n + 1n) & ((1n << 48n) - 1n))
      .toString(16)
      .padStart(12, "0");
    const assistantOneId = `msg_${assistantOneTime}${"0".repeat(14)}`;
    const nextMessage = deterministicRunMessageId("run-1", 3, createdAt + 2);
    const assistantTwoTime = ((BigInt(createdAt + 3) * 0x1000n + 1n) & ((1n << 48n) - 1n))
      .toString(16)
      .padStart(12, "0");
    const assistantTwoId = `msg_${assistantTwoTime}${"0".repeat(14)}`;
    expect([messageId, assistantOneId, nextMessage, assistantTwoId]).toEqual(
      [...[messageId, assistantOneId, nextMessage, assistantTwoId]].sort(),
    );
    expect(hashRunPayload({ b: 2, a: 1 })).toBe(hashRunPayload({ a: 1, b: 2 }));
    expect(hashRunPayload({ a: 1 })).not.toBe(hashRunPayload({ a: 2 }));
  });

  it("sanitizes attachment paths and preserves the run prompt contract", () => {
    expect(attachmentWorkspacePath({ id: "file-id", fileName: "../../report.txt" })).toBe("file-id-report.txt");
    expect(sandboxNameForRun(ORG, ROOT)).toBe(`run-${ROOT}`);
    expect(sandboxNameForRun(ORG, "00000000-0000-4000-8000-0000000000aa")).not.toBe(
      sandboxNameForRun(ORG, "00000000-0000-4000-8000-0000000000bb"),
    );
    expect(buildOpencodeJson({ model: "anthropic/claude" })).toContain('"model": "anthropic/claude"');
    const composed = composeRunPrompt({
      prompt: "Summarize",
      skillSlug: "root-skill",
      attachments: [{ fileName: "notes.txt", workspacePath: "file-id-notes.txt" }],
    });
    expect(composed).toContain('"notes.txt" → "./attachments/file-id-notes.txt"');
    expect(composed).toContain("For an HTML deliverable");
    expect(composed).toContain("use relative URLs");
    const fileOnly = composeRunPrompt({
      prompt: "",
      skillSlug: "root-skill",
      attachments: [{ fileName: "notes.txt", workspacePath: "file-id-notes.txt" }],
    });
    expect(fileOnly).toContain("Inspect the attached files");
    expect(() => composeRunPrompt({ prompt: "", skillSlug: "root-skill", attachments: [] })).toThrowError(
      expect.objectContaining({ code: "empty_prompt" }),
    );
  });

  it("restores raw user text and message ids in frozen legacy transcripts", () => {
    expect(normalizeRunTranscript(
      [
        { kind: "user", text: "runtime instructions with ./attachments/private-path" },
        { kind: "assistant", text: "done" },
      ],
      [{ messageId: "msg-initial", userText: "Summarize the document" }],
    )).toEqual([
      { kind: "user", text: "Summarize the document", message_id: "msg-initial" },
      { kind: "assistant", text: "done" },
    ]);
  });

  it("aligns front-capped legacy transcript users with the surviving prompt tail", () => {
    expect(normalizeRunTranscript(
      [
        { kind: "user", text: "runtime follow-up two" },
        { kind: "assistant", text: "second answer" },
        { kind: "user", text: "runtime follow-up three" },
      ],
      [
        { messageId: "msg-initial", userText: "Initial", runtimePrompt: "runtime initial" },
        { messageId: "msg-two", userText: "Follow-up two", runtimePrompt: "runtime follow-up two" },
        { messageId: "msg-three", userText: "Follow-up three", runtimePrompt: "runtime follow-up three" },
      ],
    )).toEqual([
      { kind: "user", text: "Follow-up two", message_id: "msg-two" },
      { kind: "assistant", text: "second answer" },
      { kind: "user", text: "Follow-up three", message_id: "msg-three" },
    ]);
  });

  it("does not match repeated surviving text to a dropped prompt", () => {
    expect(normalizeRunTranscript(
      [{ kind: "user", text: "continue" }],
      [
        { messageId: "msg-dropped", userText: "continue", runtimePrompt: "continue" },
        { messageId: "msg-surviving", userText: "continue", runtimePrompt: "continue" },
      ],
    )).toEqual([{ kind: "user", text: "continue", message_id: "msg-surviving" }]);
  });

  it("enforces per-message and cumulative attachment limits in the service layer", () => {
    const attachment = (id: string, byteSize: number) => ({
      id,
      fileName: `${id}.bin`,
      contentType: "application/octet-stream",
      byteSize,
      storageKey: `attachments/${id}`,
    });
    expect(() => validateRunMessageAttachments({ text: "", attachments: [attachment("one", 1)] })).not.toThrow();
    expect(() => validateRunMessageAttachments({ text: "", attachments: [] })).toThrowError(
      expect.objectContaining({ code: "empty_prompt" }),
    );
    expect(() => validateRunMessageAttachments({
      text: "files",
      attachments: Array.from({ length: 6 }, (_, index) => attachment(String(index), 1)),
    })).toThrowError(expect.objectContaining({ code: "too_many_attachments" }));
    expect(() => validateRunMessageAttachments({
      text: "more",
      attachments: [attachment("overflow", 1)],
      existingBytes: 100 * 1024 * 1024,
    })).toThrowError(expect.objectContaining({ code: "attachment_total_too_large" }));
  });

  it("trims tool output before losing the final assistant response", () => {
    const huge = "x".repeat(300_000);
    const capped = capTranscript([
      { kind: "tool", call_id: "a", tool: "bash", skill: null, title: null, input: "", output: huge, duration_ms: 1 },
      { kind: "tool", call_id: "b", tool: "bash", skill: null, title: null, input: "", output: huge, duration_ms: 1 },
      { kind: "assistant", text: "final" },
    ]);
    expect(capped.at(-1)).toEqual({ kind: "assistant", text: "final" });
    expect(capped.filter((item) => item.kind === "tool").every((item) => item.output.length <= 4_000)).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(capped))).toBeLessThanOrEqual(512 * 1024);
  });

  it("bounds a single multibyte transcript message without dropping it", () => {
    const capped = capTranscript([{ kind: "assistant", text: "🤖".repeat(300_000) }]);

    expect(capped).toHaveLength(1);
    expect(capped[0]?.kind).toBe("assistant");
    expect(Buffer.byteLength(JSON.stringify(capped), "utf8")).toBeLessThanOrEqual(512 * 1024);
  });

  it("exposes explicit validation/conflict error classes", () => {
    expect(new RunValidationError("invalid")).toBeInstanceOf(Error);
    expect(new RunBusyError("busy")).toBeInstanceOf(Error);
  });
});

function committedReplayDb(
  row: Record<string, unknown>,
  currentSkillSlug = "root-skill",
): Db & { transaction: ReturnType<typeof vi.fn> } {
  const rowsFor = (table: unknown): Record<string, unknown>[] => {
    if (table === schema.skills) return [{ id: ROOT, slug: currentSkillSlug }];
    if (table === schema.skillRuns) return [row];
    return [];
  };
  const queryFor = (rows: Record<string, unknown>[]) => {
    const query = {
      innerJoin: () => query,
      where: () => query,
      orderBy: () => Promise.resolve(rows),
      then: <TResult1 = Record<string, unknown>[], TResult2 = never>(
        onFulfilled?: ((value: Record<string, unknown>[]) => TResult1 | PromiseLike<TResult1>) | null,
        onRejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
      ) => Promise.resolve(rows).then(onFulfilled, onRejected),
    };
    return query;
  };
  const transaction = vi.fn(async () => {
    throw new Error("a committed replay must not open the creation transaction");
  });
  return {
    query: {
      memberships: {
        findFirst: vi.fn(async () => ({ orgRole: "developer" })),
      },
    },
    select: vi.fn(() => ({
      from: (table: unknown) => queryFor(rowsFor(table)),
    })),
    transaction,
  } as unknown as Db & { transaction: ReturnType<typeof vi.fn> };
}

describe("createRun committed idempotent replay", () => {
  const request = {
    slug: "root-skill",
    skillVersionId: ROOT_VERSION,
    dependencyPins: [{ skill_id: DEP, skill_version_id: DEP_VERSION }],
    prompt: "Run the report",
    model: "anthropic/claude-sonnet",
    modelProviderConnectionId: PROVIDER_CONNECTION,
    modelProviderCredentialVersion: 3,
    inputs: {
      secrets: [{ skill_id: ROOT, slot_id: SLOT, secret_id: SECRET }],
      variables: [{ skill_id: ROOT, env_key: "REGION", value: "eu-west-1" }],
    },
    runConfigId: null,
    idempotencyKey: "committed-request",
    attachments: [],
  };

  const existingRow = (payloadHash: string) => ({
    id: "50000000-0000-4000-8000-000000000001",
    orgId: ORG,
    skillId: ROOT,
    creatorId: actor.id,
    skillVersionId: ROOT_VERSION,
    skillVersion: "1.2.0",
    runConfigId: null,
    runConfigNameSnapshot: null,
    idempotencyKey: request.idempotencyKey,
    payloadHash,
    model: request.model,
    prompt: request.prompt,
    status: "queued",
    phase: "queued",
    errorCode: null,
    userMessage: null,
    cancelRequestedAt: null,
    sandboxName: "run-existing",
    sandboxId: null,
    sandboxDomain: null,
    goldenSnapshotId: "snapshot-at-creation",
    opencodeVersion: null,
    opencodeSessionId: null,
    serverPasswordEnc: "opaque",
    timeoutMs: 300_000,
    transcript: [],
    warnings: [],
    transcriptEventSequence: 0,
    transcriptUpdatedAt: null,
    lastActiveAt: null,
    frozenAt: null,
    sandboxCleanedAt: null,
    cleanupLeaseOwner: null,
    cleanupLeaseExpiresAt: null,
    cleanupAttempt: 0,
    createdAt: new Date("2026-07-13T12:00:00.000Z"),
    updatedAt: new Date("2026-07-13T12:00:00.000Z"),
  });

  const unavailableContext = (): RunControlContext => ({
    masterKey: Buffer.alloc(32, 7),
    goldenSnapshotId: null,
    opencodeVersion: null,
    region: "iad1",
    timeoutMs: 300_000,
    runtimeAvailable: false,
    runtimeMessage: "runtime disabled after the original commit",
    resolveModelKeys: vi.fn(async () => {
      throw new Error("mutable model catalog must not be consulted");
    }),
  });

  it("returns the committed run before mutable runtime and catalog validation", async () => {
    const payloadHash = hashRunCreationPayload(request);
    const database = committedReplayDb(existingRow(payloadHash), "renamed-after-commit");
    const ctx = unavailableContext();
    ctx.goldenSnapshotId = "snapshot-current";
    ctx.runtimeAvailable = true;
    ctx.resolveRuntimeReadiness = vi.fn(async () => {
      throw new Error("live worker readiness must not be consulted for a replay");
    });

    const detail = await createRun({ ...request, actor, orgId: ORG, ctx, database });

    expect(detail.id).toBe("50000000-0000-4000-8000-000000000001");
    expect(detail.skill_slug).toBe("renamed-after-commit");
    expect(detail.input_snapshot).toEqual({ skills: [], secrets: [], variables: [], model_provider: null });
    expect(ctx.resolveModelKeys).not.toHaveBeenCalled();
    expect(ctx.resolveRuntimeReadiness).not.toHaveBeenCalled();
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it("returns the committed snapshot when a provider credential rotates after the click", async () => {
    const payloadHash = hashRunCreationPayload(request);
    const database = committedReplayDb(existingRow(payloadHash));
    const ctx = unavailableContext();

    const detail = await createRun({
      ...request,
      modelProviderConnectionId: SECRET,
      modelProviderCredentialVersion: request.modelProviderCredentialVersion + 1,
      actor,
      orgId: ORG,
      ctx,
      database,
    });
    expect(detail.id).toBe("50000000-0000-4000-8000-000000000001");
    expect(ctx.resolveModelKeys).not.toHaveBeenCalled();
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it("treats the dependency closure as part of the idempotent launch payload", async () => {
    const payloadHash = hashRunCreationPayload(request);
    const database = committedReplayDb(existingRow(payloadHash));
    const ctx = unavailableContext();

    await expect(
      createRun({
        ...request,
        dependencyPins: [{ skill_id: DEP, skill_version_id: ROOT_VERSION }],
        actor,
        orgId: ORG,
        ctx,
        database,
      }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    expect(ctx.resolveModelKeys).not.toHaveBeenCalled();
    expect(database.transaction).not.toHaveBeenCalled();
  });
});
