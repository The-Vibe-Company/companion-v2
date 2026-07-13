import { gzipSync } from "node:zlib";
import { pack as tarPack } from "tar-stream";
import { describe, expect, it } from "vitest";
import { fallbackCompanionManifest, type RunDeclaredSecret, type RunDeclaredVariable } from "@companion/contracts";
import { schema, type Db } from "@companion/db";
import {
  RunBusyError,
  RunValidationError,
  attachmentWorkspacePath,
  buildOpencodeJson,
  buildSkillBundle,
  capTranscript,
  composeRunPrompt,
  deterministicRunMessageId,
  hashRunPayload,
  loadRunDeclarations,
  materializeRunWorkspace,
  resolveRunDependencyClosure,
  sandboxNameForRun,
  validateRunInputSelection,
  type ResolvedRunSkill,
} from "../src/skillRuns";
import type { ActorContext } from "../src/services";

const ORG = "00000000-0000-0000-0000-000000000001";
const ROOT = "10000000-0000-0000-0000-000000000001";
const DEP = "10000000-0000-0000-0000-000000000002";
const ROOT_VERSION = "20000000-0000-0000-0000-000000000001";
const DEP_VERSION = "20000000-0000-0000-0000-000000000002";
const SLOT = "30000000-0000-0000-0000-000000000001";
const SECRET = "40000000-0000-0000-0000-000000000001";
const PROVIDER_SECRET = "40000000-0000-0000-0000-000000000002";
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
  const validate = (overrides: Partial<Parameters<typeof validateRunInputSelection>[0]> = {}) =>
    validateRunInputSelection({
      actor,
      orgId: ORG,
      model: "anthropic/claude-sonnet",
      modelEnvKeys: ["ANTHROPIC_API_KEY"],
      selection: {
        secrets: [{ skill_id: ROOT, slot_id: SLOT, secret_id: SECRET }],
        variables: [{ skill_id: ROOT, env_key: "REGION", value: "eu-west-1" }],
      },
      declarations: { secrets: [secretDeclaration], variables: [variableDeclaration] },
      database: {} as Db,
      pinSecret: async (id) => pin(id),
      providerPin: { keyName: "ANTHROPIC_API_KEY", secret: pin(PROVIDER_SECRET) },
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

  it("pins selected secrets and adds exactly one model-provider snapshot", async () => {
    const resolved = await validate();
    expect(resolved.secrets.map((row) => [row.provenance, row.envKey, row.pin.secretId])).toEqual([
      ["skill", "API_TOKEN", SECRET],
      ["model_provider", "ANTHROPIC_API_KEY", PROVIDER_SECRET],
    ]);
    expect(resolved.variables).toEqual([
      { skillId: ROOT, skillSlug: "root-skill", envKey: "REGION", value: "eu-west-1" },
    ]);
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

  it("allows identical shared env inputs and rejects every silent precedence collision", async () => {
    const sameProviderDeclaration = { ...secretDeclaration, env_key: "ANTHROPIC_API_KEY" };
    await expect(
      validate({
        declarations: { secrets: [sameProviderDeclaration], variables: [] },
        selection: { secrets: [{ skill_id: ROOT, slot_id: SLOT, secret_id: SECRET }], variables: [] },
        pinSecret: async () => pin(PROVIDER_SECRET),
      }),
    ).resolves.toBeDefined();

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
    });
    expect(resolved.secrets).toEqual([]);
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

  it("rejects unsafe archives", async () => {
    const unsafe = await archive({ "../escape.txt": "oops", "SKILL.md": "# Skill" });
    await expect(buildSkillBundle("root", "1.0.0", "path", async () => unsafe)).rejects.toThrow(
      /safety checks/,
    );
  });

  it("keeps deterministic ids/hashes stable and payload-sensitive", () => {
    expect(deterministicRunMessageId("run-1", 2)).toBe(deterministicRunMessageId("run-1", 2));
    expect(deterministicRunMessageId("run-1", 2)).not.toBe(deterministicRunMessageId("run-1", 3));
    expect(hashRunPayload({ b: 2, a: 1 })).toBe(hashRunPayload({ a: 1, b: 2 }));
    expect(hashRunPayload({ a: 1 })).not.toBe(hashRunPayload({ a: 2 }));
  });

  it("sanitizes attachment paths and preserves the run prompt contract", () => {
    expect(attachmentWorkspacePath({ id: "file-id", fileName: "../../report.txt" })).toBe("file-id-report.txt");
    expect(sandboxNameForRun(ORG, ROOT)).toMatch(/^run-/);
    expect(buildOpencodeJson({ model: "anthropic/claude" })).toContain('"model": "anthropic/claude"');
    expect(
      composeRunPrompt({
        prompt: "Summarize",
        skillSlug: "root-skill",
        attachmentNames: ["notes.txt"],
        artifactsEnabled: true,
      }),
    ).toContain("./artifacts/");
  });

  it("trims tool output before losing the final assistant response", () => {
    const huge = "x".repeat(300_000);
    const capped = capTranscript([
      { kind: "tool", call_id: "a", tool: "bash", skill: null, title: null, input: "", output: huge, duration_ms: 1 },
      { kind: "tool", call_id: "b", tool: "bash", skill: null, title: null, input: "", output: huge, duration_ms: 1 },
      { kind: "assistant", text: "final" },
    ]);
    expect(capped.at(-1)).toEqual({ kind: "assistant", text: "final" });
    expect(Buffer.byteLength(JSON.stringify(capped))).toBeLessThanOrEqual(512 * 1024);
  });

  it("exposes explicit validation/conflict error classes", () => {
    expect(new RunValidationError("invalid")).toBeInstanceOf(Error);
    expect(new RunBusyError("busy")).toBeInstanceOf(Error);
  });
});
