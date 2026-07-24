import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import type {
  ProjectChatRuntime,
  ProjectWorkspaceRuntime,
} from "@companion/core";
import { EntitlementDeniedError, RunRuntimeError } from "@companion/core";
import {
  ProjectAuthorityRevokedError,
  ProjectEnvironmentInvalidError,
} from "@companion/core/services";
import { packDir } from "@companion/skills";
import {
  applyProjectUnifiedPatch,
  createProjectAttachmentRetentionScheduler,
  createProjectSupervisor,
  projectArchiveMatchesChecksum,
  projectFileCacheKey,
  runProjectWorkspaceJob,
  type ProjectCachedFile,
  type ProjectFileStorage,
  type ProjectPromptJob,
  type ProjectUsageMeter,
  type ProjectWorkspaceJob,
  type ProjectWorkspaceStore,
} from "./projectSupervisor";
import type { ProjectWorkerConfig } from "./config";

const job: ProjectWorkspaceJob = {
  orgId: "00000000-0000-4000-8000-000000000001",
  projectId: "00000000-0000-4000-8000-000000000002",
  creatorId: "creator",
  status: "queued",
  sandboxName: "project-org-project",
  sandboxId: null,
  sandboxDomain: null,
  checkpointId: null,
  checkpointGeneration: 0,
  desiredGeneration: 1,
  appliedGeneration: 1,
  desiredFileRevision: 0,
  appliedFileRevision: 0,
  lastActivityAt: new Date(),
  idleDeadlineAt: null,
  activationRevision: 0,
  authorityRevision: null,
  activationAdmissionToken: null,
  activationAdmissionRevision: null,
  activationAdmissionAuthorityRevision: null,
  activationAdmittedAt: null,
  environmentExposureAttemptedAt: null,
  recycleRequestedAt: null,
  recycleReason: null,
  skillSyncErrorAt: null,
  skillSyncErrorCode: null,
  skillSyncErrorMessage: null,
  leaseGeneration: 1,
  deleteRequestedAt: null,
};

const config: ProjectWorkerConfig = {
  enabled: true,
  region: "iad1",
  concurrency: 2,
  claimIntervalMs: 1,
  leaseSeconds: 30,
  heartbeatMs: 1_000,
  idleMs: 8,
  sandboxTimeoutMs: 600_000,
  maxActivationMs: 3_600_000,
};

function usage(): ProjectUsageMeter {
  return {
    reserve: vi.fn(async () => null),
    start: vi.fn(async () => undefined),
    refresh: vi.fn(async () => null),
    extendIdleRunway: vi.fn(async () => null),
    record: vi.fn(async () => undefined),
    settle: vi.fn(async () => undefined),
  };
}

function runtime(files = new Map<string, Buffer>()): ProjectWorkspaceRuntime {
  return {
    provider: "vercel",
    activate: vi.fn(async () => ({
      sandboxId: job.sandboxName,
      domain: "https://project.invalid",
      resumed: false,
      restoredFromSnapshot: false,
    })),
    syncSkillBundles: vi.fn(async () => undefined),
    syncFiles: vi.fn(async ({ files: replacement }) => {
      files.clear();
      for (const file of replacement) files.set(file.path, file.data);
    }),
    pushFiles: vi.fn(async ({ files: pushed }) => {
      for (const file of pushed) files.set(file.path, file.data);
    }),
    listFiles: vi.fn(async () => [...files].map(([path, data]) => ({
      path,
      data,
      byteSize: data.length,
      modifiedAt: new Date("2026-07-23T20:00:00.000Z"),
    }))),
    startServer: vi.fn(async () => undefined),
    healthCheck: vi.fn(async () => ({ ok: true as const, ms: 1 })),
    scrubAgentState: vi.fn(async () => undefined),
    checkpointAndStop: vi.fn(async () => ({ snapshotId: "checkpoint-1" })),
    destroy: vi.fn(async () => undefined),
    observe: vi.fn(async () => ({
      state: "running" as const,
      startedAt: new Date(),
      expiresAt: new Date(Date.now() + 600_000),
      currentSnapshotId: null,
    })),
    extendTimeout: vi.fn(async () => ({
      state: "running" as const,
      startedAt: new Date(),
      expiresAt: new Date(Date.now() + 600_000),
      currentSnapshotId: null,
    })),
  };
}

function baseStore(overrides: Partial<ProjectWorkspaceStore> = {}): ProjectWorkspaceStore {
  return {
    claimProjectWorkspaceJobs: vi.fn(async () => []),
    heartbeatProjectWorkspaceLease: vi.fn(async () => true),
    readProjectWorkspaceControl: vi.fn(async () => ({
      deleteRequestedAt: null,
      status: "ready" as const,
      skillSyncErrorAt: null,
      skillSyncErrorCode: null,
      skillSyncErrorMessage: null,
    })),
    surfaceProjectSkillSyncFailure: vi.fn(async () => true),
    completeProjectWorkspaceRecycle: vi.fn(async () => true),
    releaseProjectWorkspaceLease: vi.fn(async () => true),
    loadProjectMaterializationPlan: vi.fn(async () => ({
      desiredGeneration: 1,
      appliedGeneration: 1,
      desiredFileRevision: 0,
      appliedFileRevision: 0,
      checkpointGeneration: 0,
      skills: [],
      bootstrapFiles: [],
    })),
    validateProjectActivation: vi.fn(async () => undefined),
    beginProjectActivation: vi.fn(async ({ activationRevision }) => ({
      token: "00000000-0000-4000-8000-000000000099",
      authorityRevision: "authority-1",
      activationRevision,
    })),
    cancelProjectActivation: vi.fn(async () => "cancelled" as const),
    prepareProjectActivation: vi.fn(async () => ({
      authorityRevision: "authority-1",
    })),
    resolveProjectActivationEnvironment: vi.fn(async () => ({
      env: {
        GENERIC_PROJECT_SECRET: "generic-secret-value",
        OPENAI_API_KEY: "model-provider-value",
      },
      serverPassword: "password",
      injectedLiterals: [
        "generic-secret-value",
        "model-provider-value",
        "password",
      ],
      authorityRevision: "authority-1",
    })),
    markProjectActivationInjected: vi.fn(async () => true),
    markProjectActivationExposureAttempted: vi.fn(async () => true),
    revalidateProjectWorkspaceAuthority: vi.fn(async () => "current" as const),
    inspectProjectPromptProviderAdmission: vi.fn(async () => "none" as const),
    revalidateProjectPromptProviderAdmission: vi.fn(async () => "admitted" as const),
    updateProjectWorkspaceState: vi.fn(async () => true),
    completeProjectDeletion: vi.fn(async () => true),
    claimProjectPromptJobs: vi.fn(async () => []),
    claimProjectSessionStops: vi.fn(async () => []),
    completeProjectSessionStop: vi.fn(async () => true),
    heartbeatProjectPromptLease: vi.fn(async () => true),
    loadProjectPromptAttachments: vi.fn(async () => []),
    loadProjectSessionTranscript: vi.fn(async () => []),
    rebindProjectSession: vi.fn(async () => true),
    completeProjectPrompt: vi.fn(async () => true),
    markProjectPromptDispatch: vi.fn(async () => true),
    markProjectPromptSendAttempted: vi.fn(async () => "marked" as const),
    failProjectPrompt: vi.fn(async () => true),
    requeueProjectPromptAtBoundary: vi.fn(async () => true),
    requeueProjectPrompts: vi.fn(async () => undefined),
    appendProjectSessionEvent: vi.fn(async () => 1),
    persistProjectFiles: vi.fn(async () => undefined),
    persistProjectFileDeletions: vi.fn(async () => undefined),
    loadProjectFileBaseline: vi.fn(async () => []),
    reserveProjectFileStorageObject: vi.fn(async () => undefined),
    listProjectStorageKeys: vi.fn(async () => []),
    ...overrides,
  };
}

function quietChat(): ProjectChatRuntime {
  return {
    findSessionByTitle: vi.fn(async () => null),
    createSession: vi.fn(async (_target, title) => ({ id: title, title })),
    abortSession: vi.fn(async () => undefined),
    getSessionState: vi.fn(async () => "idle" as const),
    getMessageState: vi.fn(async () => "missing" as const),
    rehydrateSession: vi.fn(async () => undefined),
    sendPrompt: vi.fn(async () => undefined),
    loadItems: vi.fn(async () => []),
    getFileChanges: vi.fn(async () => []),
    async *streamEvents(_target, signal, onConnected) {
      onConnected?.();
      await new Promise<void>((resolve) => {
        if (signal.aborted) return resolve();
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
    },
  };
}

const emptyStorage: ProjectFileStorage = {
  get: vi.fn(async () => Buffer.alloc(0)),
  putContentAddressed: vi.fn(async ({ orgId, projectId, checksum }) =>
    projectFileCacheKey({ orgId, projectId, checksum })),
  delete: vi.fn(async () => undefined),
};

describe("Project skill archive integrity", () => {
  it("validates a stored tar.gz against the canonical uncompressed tar checksum", async () => {
    const directory = await mkdtemp(join(tmpdir(), "companion-project-skill-"));
    try {
      await writeFile(
        join(directory, "SKILL.md"),
        "---\nname: release-notes\ndescription: Draft release notes\n---\n\n# Release notes\n",
      );
      const packed = await packDir(directory);
      const rawArchiveChecksum =
        `sha256:${createHash("sha256").update(packed.archive).digest("hex")}`;

      expect(rawArchiveChecksum).not.toBe(packed.checksum);
      expect(projectArchiveMatchesChecksum(packed.archive, packed.checksum)).toBe(true);

      const tamperedTar = Buffer.from(packed.tar);
      const lastByte = tamperedTar.length - 1;
      tamperedTar[lastByte] = (tamperedTar[lastByte] ?? 0) ^ 1;
      const tamperedArchive = gzipSync(tamperedTar, { level: 9 });
      expect(projectArchiveMatchesChecksum(tamperedArchive, packed.checksum)).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("Project turn-scoped file capture", () => {
  it("reconstructs message-specific modified and added bytes from unified patches", () => {
    expect(applyProjectUnifiedPatch(
      Buffer.from("base\n"),
      "@@ -1,1 +1,1 @@\n-base\n+session-a\n",
    ).toString()).toBe("session-a\n");
    expect(applyProjectUnifiedPatch(
      Buffer.alloc(0),
      "@@ -0,0 +1,1 @@\n+new file\n",
    ).toString()).toBe("new file\n");
  });

  it("refuses a binary/non-applicable patch instead of attributing shared bytes", () => {
    expect(() => applyProjectUnifiedPatch(
      Buffer.from([0xff, 0x00]),
      "Binary files differ",
    )).toThrow();
  });
});

describe("Project workspace lifecycle", () => {
  it("releases quiescent Projects so a third Project is scheduled before the idle deadline", async () => {
    const queued = [0, 1, 2].map((index): ProjectWorkspaceJob => ({
      ...job,
      projectId: `00000000-0000-4000-8000-00000000000${index + 2}`,
      sandboxName: `project-${index + 1}`,
      lastActivityAt: new Date(),
    }));
    const claimed: string[] = [];
    const store = baseStore({
      claimProjectWorkspaceJobs: vi.fn(async ({ limit }) => {
        const jobs = queued.splice(0, limit);
        claimed.push(...jobs.map((entry) => entry.projectId));
        return jobs;
      }),
    });
    const projectRuntime = runtime();
    const supervisor = createProjectSupervisor({
      store,
      runtime: projectRuntime,
      chat: quietChat(),
      usage: usage(),
      storage: emptyStorage,
      goldenSnapshotId: "golden",
      config: {
        ...config,
        concurrency: 2,
        idleMs: 10 * 60_000,
      },
      workerId: "worker",
    });
    try {
      for (let attempt = 0; attempt < 100 && claimed.length < 3; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
    } finally {
      await supervisor.stop();
    }

    expect(claimed).toHaveLength(3);
    expect(projectRuntime.checkpointAndStop).not.toHaveBeenCalled();
  });

  it("provisions a warm Project without resolving secrets, starting OpenCode, or holding until idle", async () => {
    const projectRuntime = runtime();
    const store = baseStore();
    const meter = usage();
    await runProjectWorkspaceJob({
      job: { ...job, lastActivityAt: new Date() },
      workerId: "worker",
      store,
      runtime: projectRuntime,
      chat: quietChat(),
      usage: meter,
      storage: emptyStorage,
      goldenSnapshotId: "golden",
      config: { ...config, idleMs: 60_000 },
      signal: new AbortController().signal,
    });

    expect(projectRuntime.activate).toHaveBeenCalledOnce();
    expect(store.prepareProjectActivation).toHaveBeenCalledOnce();
    expect(projectRuntime.startServer).not.toHaveBeenCalled();
    expect(store.resolveProjectActivationEnvironment).not.toHaveBeenCalled();
    expect(projectRuntime.checkpointAndStop).not.toHaveBeenCalled();
    expect(meter.extendIdleRunway).toHaveBeenCalledOnce();
    expect(projectRuntime.observe).toHaveBeenCalledOnce();
    const readyCallIndex = vi.mocked(store.updateProjectWorkspaceState).mock.calls
      .findIndex(([state]) => state.status === "ready");
    expect(readyCallIndex).toBeGreaterThanOrEqual(0);
    const readyCallOrder =
      vi.mocked(store.updateProjectWorkspaceState).mock.invocationCallOrder[readyCallIndex]!;
    expect(vi.mocked(meter.extendIdleRunway).mock.invocationCallOrder[0]!)
      .toBeLessThan(readyCallOrder);
    expect(vi.mocked(projectRuntime.observe).mock.invocationCallOrder[0]!)
      .toBeLessThan(readyCallOrder);
  });

  it("applies a durable creator upload to a warm workspace before prompt admission", async () => {
    const uploaded = Buffer.from("uploaded outside a conversation");
    const uploadedChecksum =
      `sha256:${createHash("sha256").update(uploaded).digest("hex")}`;
    const files = new Map([["brief.txt", Buffer.from("stale runtime bytes")]]);
    const projectRuntime = runtime(files);
    const store = baseStore({
      loadProjectMaterializationPlan: vi.fn(async () => ({
        desiredGeneration: 1,
        appliedGeneration: 1,
        desiredFileRevision: 1,
        appliedFileRevision: 0,
        checkpointGeneration: 1,
        skills: [],
        bootstrapFiles: [{
          storageKey: "project-upload",
          workspacePath: "files/brief.txt",
          checksum: uploadedChecksum,
        }],
      })),
    });
    const storage: ProjectFileStorage = {
      ...emptyStorage,
      get: vi.fn(async () => uploaded),
    };

    await runProjectWorkspaceJob({
      job: {
        ...job,
        status: "ready",
        sandboxId: job.sandboxName,
        checkpointId: "checkpoint-before-upload",
        checkpointGeneration: 1,
        desiredFileRevision: 1,
        appliedFileRevision: 0,
        activationRevision: 1,
        authorityRevision: "authority-1",
        lastActivityAt: new Date(),
      },
      workerId: "worker",
      store,
      runtime: projectRuntime,
      chat: quietChat(),
      usage: usage(),
      storage,
      goldenSnapshotId: "golden",
      config: { ...config, idleMs: 60_000 },
      signal: new AbortController().signal,
    });

    expect(files.get("brief.txt")).toEqual(uploaded);
    expect(store.updateProjectWorkspaceState).toHaveBeenCalledWith(
      expect.objectContaining({ appliedFileRevision: 1 }),
    );
    expect(
      vi.mocked(projectRuntime.syncFiles).mock.invocationCallOrder[0],
    ).toBeLessThan(
      vi.mocked(store.claimProjectPromptJobs).mock.invocationCallOrder[0]!,
    );
    expect(store.persistProjectFiles).not.toHaveBeenCalled();
  });

  it("restarts a warm OpenCode server after a file upload lands between prompts", async () => {
    const uploaded = Buffer.from("new project context");
    const uploadedChecksum =
      `sha256:${createHash("sha256").update(uploaded).digest("hex")}`;
    const first: ProjectPromptJob = {
      id: "prompt-before-upload",
      orgId: job.orgId,
      projectId: job.projectId,
      creatorId: job.creatorId,
      sessionId: "session-before-upload",
      sequence: 1,
      text: "Work while a file is uploaded",
      model: "openai/gpt-5",
      opencodeSessionId: null,
      opencodeMessageId: "msg_before_upload",
      sendAttemptedAt: null,
      leaseOwner: "worker",
    };
    const second: ProjectPromptJob = {
      ...first,
      id: "prompt-after-upload",
      sessionId: "session-after-upload",
      text: "Use the newly uploaded context",
      opencodeMessageId: "msg_after_upload",
    };
    let uploadCommitted = false;
    let fileApplied = false;
    let firstClaimed = false;
    let secondClaimed = false;
    let serverRunning = false;
    let secondSent = false;
    const sentMessages = new Set<string>();
    const projectRuntime = runtime();
    vi.mocked(projectRuntime.startServer).mockImplementation(async () => {
      serverRunning = true;
    });
    vi.mocked(projectRuntime.syncFiles).mockImplementation(async () => {
      // The Vercel adapter stops OpenCode before replacing the managed tree.
      serverRunning = false;
    });
    const store = baseStore({
      loadProjectMaterializationPlan: vi.fn(async () => ({
        desiredGeneration: 1,
        appliedGeneration: 1,
        desiredFileRevision: uploadCommitted ? 1 : 0,
        appliedFileRevision: fileApplied ? 1 : 0,
        checkpointGeneration: 0,
        skills: [],
        bootstrapFiles: uploadCommitted
          ? [{
              storageKey: "direct-upload",
              workspacePath: "files/context.txt",
              checksum: uploadedChecksum,
            }]
          : [],
      })),
      updateProjectWorkspaceState: vi.fn(async (input) => {
        if (input.appliedFileRevision === 1) fileApplied = true;
        return true;
      }),
      claimProjectPromptJobs: vi.fn(async () => {
        if (!firstClaimed) {
          firstClaimed = true;
          return [first];
        }
        if (fileApplied && !secondClaimed) {
          secondClaimed = true;
          return [second];
        }
        return [];
      }),
    });
    const chat = quietChat();
    vi.mocked(chat.getMessageState).mockImplementation(
      async (_target, _sessionId, messageId) =>
        sentMessages.has(messageId) ? "completed" : "missing",
    );
    vi.mocked(chat.sendPrompt).mockImplementation(async (_target, _sessionId, _text, messageId) => {
      if (!serverRunning) throw new Error("OpenCode server is stopped");
      sentMessages.add(messageId);
      if (messageId === first.opencodeMessageId) {
        uploadCommitted = true;
        // Keep the first turn active past the materialization poll. The upload must wait for this
        // quiescent boundary rather than replacing files under a running turn.
        await new Promise((resolve) => setTimeout(resolve, 5_100));
      } else {
        secondSent = true;
      }
    });
    const storage: ProjectFileStorage = {
      ...emptyStorage,
      get: vi.fn(async () => uploaded),
    };

    await runProjectWorkspaceJob({
      job: { ...job, lastActivityAt: new Date() },
      workerId: "worker",
      store,
      runtime: projectRuntime,
      chat,
      usage: usage(),
      storage,
      goldenSnapshotId: "golden",
      config: { ...config, idleMs: 60_000 },
      signal: new AbortController().signal,
    });

    expect(fileApplied).toBe(true);
    expect(secondSent).toBe(true);
    expect(projectRuntime.startServer).toHaveBeenCalledTimes(2);
    expect(vi.mocked(projectRuntime.syncFiles).mock.invocationCallOrder[1]!).toBeLessThan(
      vi.mocked(projectRuntime.startServer).mock.invocationCallOrder[1]!,
    );
  }, 15_000);

  it("clamps initial provider timeout to the already-admitted activation budget", async () => {
    const projectRuntime = runtime();
    const meter = usage();
    vi.mocked(meter.reserve).mockResolvedValue({ limitMs: 300_000 });

    await runProjectWorkspaceJob({
      job: { ...job, lastActivityAt: new Date() },
      workerId: "worker",
      store: baseStore(),
      runtime: projectRuntime,
      chat: quietChat(),
      usage: meter,
      storage: emptyStorage,
      goldenSnapshotId: "golden",
      config,
      signal: new AbortController().signal,
    });

    expect(projectRuntime.activate).toHaveBeenCalledWith(
      expect.objectContaining({
        ref: expect.objectContaining({ timeoutMs: 300_000 }),
      }),
    );
    expect(meter.start).toHaveBeenCalledWith(
      expect.objectContaining({
        activationRevision: 1,
        runtimeDeadlineAt: expect.any(Date),
      }),
    );
  });

  it("blocks an invalid environment before reservation or provider activation", async () => {
    const projectRuntime = runtime();
    const meter = usage();
    const store = baseStore({
      validateProjectActivation: vi.fn(async () => {
        throw new ProjectEnvironmentInvalidError();
      }),
    });

    await expect(runProjectWorkspaceJob({
      job,
      workerId: "worker",
      store,
      runtime: projectRuntime,
      chat: quietChat(),
      usage: meter,
      storage: emptyStorage,
      goldenSnapshotId: "golden",
      config,
      signal: new AbortController().signal,
    })).rejects.toBeInstanceOf(ProjectEnvironmentInvalidError);

    expect(store.validateProjectActivation).toHaveBeenCalledOnce();
    expect(meter.reserve).not.toHaveBeenCalled();
    expect(meter.start).not.toHaveBeenCalled();
    expect(projectRuntime.observe).not.toHaveBeenCalled();
    expect(projectRuntime.activate).not.toHaveBeenCalled();
    expect(store.prepareProjectActivation).not.toHaveBeenCalled();
    expect(store.claimProjectPromptJobs).not.toHaveBeenCalled();
    expect(store.updateProjectWorkspaceState).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "error",
        errorCode: "project_environment_invalid",
        errorMessage: "Project environment configuration is invalid.",
      }),
    );
  });

  it("never persists raw runtime error text", async () => {
    const projectRuntime = runtime();
    projectRuntime.activate = vi.fn(async () => {
      throw new RunRuntimeError("provider body contains generic-secret-value");
    });
    const store = baseStore();

    await expect(runProjectWorkspaceJob({
      job,
      workerId: "worker",
      store,
      runtime: projectRuntime,
      chat: quietChat(),
      usage: usage(),
      storage: emptyStorage,
      goldenSnapshotId: "golden",
      config,
      signal: new AbortController().signal,
    })).rejects.toThrow("provider body contains generic-secret-value");

    expect(store.updateProjectWorkspaceState).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "error",
        errorCode: "project_runtime_failed",
        errorMessage: "Project runtime operation failed",
      }),
    );
  });

  it("validates an existing workspace before any admission-path provider observation", async () => {
    const projectRuntime = runtime();
    const store = baseStore({
      validateProjectActivation: vi.fn(async () => {
        throw new ProjectEnvironmentInvalidError();
      }),
    });

    await expect(runProjectWorkspaceJob({
      job: {
        ...job,
        status: "stopped",
        sandboxId: job.sandboxName,
        activationRevision: 3,
        authorityRevision: "authority-3",
      },
      workerId: "worker",
      store,
      runtime: projectRuntime,
      chat: quietChat(),
      usage: usage(),
      storage: emptyStorage,
      goldenSnapshotId: "golden",
      config,
      signal: new AbortController().signal,
    })).rejects.toBeInstanceOf(ProjectEnvironmentInvalidError);

    expect(store.validateProjectActivation).toHaveBeenCalledOnce();
    expect(projectRuntime.observe).not.toHaveBeenCalled();
    expect(projectRuntime.activate).not.toHaveBeenCalled();
  });

  it("fences a mutation after preflight before reservation or provider activation", async () => {
    const projectRuntime = runtime();
    const meter = usage();
    let invalidated = false;
    const store = baseStore({
      validateProjectActivation: vi.fn(async () => {
        if (invalidated) throw new ProjectEnvironmentInvalidError();
      }),
      inspectProjectPromptProviderAdmission: vi.fn(async () => {
        // Deterministically commit the conceptual secret/provider mutation after the cheap initial
        // preflight. The next lease-fenced validation must reject it before admission/reservation.
        invalidated = true;
        return "none" as const;
      }),
    });

    await expect(runProjectWorkspaceJob({
      job,
      workerId: "worker",
      store,
      runtime: projectRuntime,
      chat: quietChat(),
      usage: meter,
      storage: emptyStorage,
      goldenSnapshotId: "golden",
      config,
      signal: new AbortController().signal,
    })).rejects.toBeInstanceOf(ProjectEnvironmentInvalidError);

    expect(store.validateProjectActivation).toHaveBeenCalledTimes(2);
    expect(store.beginProjectActivation).not.toHaveBeenCalled();
    expect(meter.reserve).not.toHaveBeenCalled();
    expect(projectRuntime.observe).not.toHaveBeenCalled();
    expect(projectRuntime.activate).not.toHaveBeenCalled();
  });

  it("orders a post-admission mutation before prepare so no credential is injected", async () => {
    let admissionCommitted = false;
    let recycleRecorded = false;
    const projectRuntime = runtime();
    projectRuntime.activate = vi.fn(async () => {
      expect(admissionCommitted).toBe(true);
      // This models a secret/provider signal that commits after the durable admission point. The
      // provider activation is already admitted, but the signal records recycle before prepare.
      recycleRecorded = true;
      return {
        sandboxId: job.sandboxName,
        domain: "https://project.invalid",
        resumed: false,
        restoredFromSnapshot: false,
      };
    });
    const store = baseStore({
      beginProjectActivation: vi.fn(async ({ activationRevision }) => {
        admissionCommitted = true;
        return {
          token: "00000000-0000-4000-8000-000000000099",
          authorityRevision: "authority-1",
          activationRevision,
        };
      }),
      prepareProjectActivation: vi.fn(async () => {
        expect(recycleRecorded).toBe(true);
        throw new ProjectAuthorityRevokedError({
          authorityRevision: "authority-2",
          recycleRequired: true,
          mode: "immediate",
          reason: "recycle_requested",
        });
      }),
    });

    await expect(runProjectWorkspaceJob({
      job,
      workerId: "worker",
      store,
      runtime: projectRuntime,
      chat: quietChat(),
      usage: usage(),
      storage: emptyStorage,
      goldenSnapshotId: "golden",
      config,
      signal: new AbortController().signal,
    })).rejects.toBeInstanceOf(ProjectAuthorityRevokedError);

    expect(store.beginProjectActivation).toHaveBeenCalledOnce();
    expect(projectRuntime.activate).toHaveBeenCalledOnce();
    expect(store.prepareProjectActivation).toHaveBeenCalledWith(
      expect.objectContaining({
        admissionToken: "00000000-0000-4000-8000-000000000099",
        activationRevision: 1,
      }),
    );
    expect(store.resolveProjectActivationEnvironment).not.toHaveBeenCalled();
    expect(projectRuntime.startServer).not.toHaveBeenCalled();
    expect(projectRuntime.checkpointAndStop).toHaveBeenCalledOnce();
  });

  it("keeps the admission and reservation when provider activation returns ambiguously", async () => {
    const projectRuntime = runtime();
    projectRuntime.activate = vi.fn(async () => {
      throw new Error("provider transport closed");
    });
    const meter = usage();
    const store = baseStore();

    await expect(runProjectWorkspaceJob({
      job,
      workerId: "worker",
      store,
      runtime: projectRuntime,
      chat: quietChat(),
      usage: meter,
      storage: emptyStorage,
      goldenSnapshotId: "golden",
      config,
      signal: new AbortController().signal,
    })).rejects.toThrow("provider transport closed");

    expect(store.beginProjectActivation).toHaveBeenCalledOnce();
    expect(meter.reserve).toHaveBeenCalledOnce();
    expect(store.cancelProjectActivation).not.toHaveBeenCalled();
    expect(meter.settle).not.toHaveBeenCalled();
    expect(store.prepareProjectActivation).not.toHaveBeenCalled();
  });

  it("requeues a never-provisioned pending admission once recycle observes no sandbox", async () => {
    const pendingToken = "00000000-0000-4000-8000-000000000099";
    const projectRuntime = runtime();
    projectRuntime.observe = vi.fn(async () => ({
      state: "missing" as const,
      startedAt: null,
      expiresAt: null,
      currentSnapshotId: null,
    }));
    const meter = usage();
    const store = baseStore({
      cancelProjectActivation: vi.fn(async () => "fresh_requeued" as const),
    });

    await runProjectWorkspaceJob({
      job: {
        ...job,
        status: "provisioning",
        activationAdmissionToken: pendingToken,
        activationAdmissionRevision: 1,
        activationAdmissionAuthorityRevision: "authority-1",
        activationAdmittedAt: new Date(),
        recycleRequestedAt: new Date(),
        recycleReason: "immediate:secrets_changed",
      },
      workerId: "worker",
      store,
      runtime: projectRuntime,
      chat: quietChat(),
      usage: meter,
      storage: emptyStorage,
      goldenSnapshotId: "golden",
      config,
      signal: new AbortController().signal,
    });

    expect(store.cancelProjectActivation).toHaveBeenCalledWith(
      expect.objectContaining({
        admissionToken: pendingToken,
        activationRevision: 1,
        resetFreshRecycle: true,
      }),
    );
    expect(meter.settle).toHaveBeenCalledWith(
      expect.objectContaining({ activationRevision: 1 }),
    );
    expect(projectRuntime.activate).not.toHaveBeenCalled();
  });

  it("retries one pending activation without charging its secretless VM to the old revision", async () => {
    const pendingToken = "00000000-0000-4000-8000-000000000099";
    const projectRuntime = runtime();
    const meter = usage();
    const store = baseStore({
      beginProjectActivation: vi.fn(async ({ activationRevision }) => ({
        token: pendingToken,
        authorityRevision: "authority-5",
        activationRevision,
      })),
    });

    await runProjectWorkspaceJob({
      job: {
        ...job,
        status: "provisioning",
        sandboxId: job.sandboxName,
        checkpointId: "checkpoint-4",
        activationRevision: 4,
        authorityRevision: "authority-4",
        activationAdmissionToken: pendingToken,
        activationAdmissionRevision: 5,
        activationAdmissionAuthorityRevision: "authority-5",
        activationAdmittedAt: new Date(),
      },
      workerId: "worker",
      store,
      runtime: projectRuntime,
      chat: quietChat(),
      usage: meter,
      storage: emptyStorage,
      goldenSnapshotId: "golden",
      config,
      signal: new AbortController().signal,
    });

    expect(store.beginProjectActivation).toHaveBeenCalledWith(
      expect.objectContaining({ activationRevision: 5 }),
    );
    expect(meter.reserve).toHaveBeenCalledWith(
      expect.objectContaining({ activationRevision: 5 }),
    );
    expect(store.prepareProjectActivation).toHaveBeenCalledWith(
      expect.objectContaining({
        admissionToken: pendingToken,
        activationRevision: 5,
      }),
    );
    expect(meter.record).not.toHaveBeenCalledWith(
      expect.objectContaining({ activationRevision: 4 }),
    );
    expect(meter.settle).not.toHaveBeenCalledWith(
      expect.objectContaining({ activationRevision: 4 }),
    );
  });

  it("preserves a recovered pending fence until recycle observes and settles that revision", async () => {
    const pendingToken = "00000000-0000-4000-8000-000000000099";
    const pendingJob: ProjectWorkspaceJob = {
      ...job,
      status: "provisioning",
      sandboxId: job.sandboxName,
      checkpointId: "checkpoint-4",
      activationRevision: 4,
      authorityRevision: "authority-4",
      activationAdmissionToken: pendingToken,
      activationAdmissionRevision: 5,
      activationAdmissionAuthorityRevision: "authority-5",
      activationAdmittedAt: new Date(),
    };
    const racedStore = baseStore({
      validateProjectActivation: vi.fn(async () => {
        throw new ProjectAuthorityRevokedError({
          authorityRevision: "authority-5",
          recycleRequired: true,
          mode: "immediate",
          reason: "recycle_requested",
        });
      }),
    });
    const racedMeter = usage();

    await expect(runProjectWorkspaceJob({
      job: pendingJob,
      workerId: "worker",
      store: racedStore,
      runtime: runtime(),
      chat: quietChat(),
      usage: racedMeter,
      storage: emptyStorage,
      goldenSnapshotId: "golden",
      config,
      signal: new AbortController().signal,
    })).rejects.toBeInstanceOf(ProjectAuthorityRevokedError);

    // This worker did not create the token and cannot know whether a prior activate succeeded.
    expect(racedStore.cancelProjectActivation).not.toHaveBeenCalled();
    expect(racedMeter.settle).not.toHaveBeenCalled();

    const recycleStore = baseStore();
    const recycleMeter = usage();
    await runProjectWorkspaceJob({
      job: {
        ...pendingJob,
        recycleRequestedAt: new Date(),
        recycleReason: "immediate:secrets_changed",
      },
      workerId: "worker",
      store: recycleStore,
      runtime: runtime(),
      chat: quietChat(),
      usage: recycleMeter,
      storage: emptyStorage,
      goldenSnapshotId: "golden",
      config,
      signal: new AbortController().signal,
    });

    expect(recycleMeter.record).toHaveBeenCalledWith(
      expect.objectContaining({ activationRevision: 5, state: "stopped" }),
    );
    expect(recycleMeter.settle).toHaveBeenCalledWith(
      expect.objectContaining({ activationRevision: 5 }),
    );
    expect(recycleMeter.settle).not.toHaveBeenCalledWith(
      expect.objectContaining({ activationRevision: 4 }),
    );
    expect(recycleStore.completeProjectWorkspaceRecycle).toHaveBeenCalledOnce();
  });

  it("keeps provider-blocked prompts queued without VM or billing churn", async () => {
    const projectRuntime = runtime();
    const meter = usage();
    const store = baseStore({
      inspectProjectPromptProviderAdmission: vi.fn(
        async () => "provider_unavailable" as const,
      ),
    });

    await runProjectWorkspaceJob({
      job,
      workerId: "worker",
      store,
      runtime: projectRuntime,
      chat: quietChat(),
      usage: meter,
      storage: emptyStorage,
      goldenSnapshotId: "golden",
      config,
      signal: new AbortController().signal,
    });

    expect(meter.reserve).not.toHaveBeenCalled();
    expect(meter.start).not.toHaveBeenCalled();
    expect(projectRuntime.observe).not.toHaveBeenCalled();
    expect(projectRuntime.activate).not.toHaveBeenCalled();
    expect(store.prepareProjectActivation).not.toHaveBeenCalled();
    expect(store.claimProjectPromptJobs).not.toHaveBeenCalled();
    expect(store.updateProjectWorkspaceState).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "error",
        errorCode: "project_provider_unavailable",
      }),
    );
  });

  it("keeps one usage activation across lease-free warm wakes", async () => {
    const projectRuntime = runtime();
    const meter = usage();
    const store = baseStore();

    await runProjectWorkspaceJob({
      job: {
        ...job,
        status: "ready",
        sandboxId: job.sandboxName,
        sandboxDomain: "https://project.invalid",
        activationRevision: 4,
        authorityRevision: "authority-1",
        lastActivityAt: new Date(),
        idleDeadlineAt: new Date(Date.now() + 60_000),
      },
      workerId: "worker",
      store,
      runtime: projectRuntime,
      chat: quietChat(),
      usage: meter,
      storage: emptyStorage,
      goldenSnapshotId: "golden",
      config: { ...config, idleMs: 60_000 },
      signal: new AbortController().signal,
    });

    expect(meter.refresh).toHaveBeenCalledWith(expect.objectContaining({
      activationRevision: 4,
    }));
    expect(meter.reserve).not.toHaveBeenCalled();
    expect(meter.start).not.toHaveBeenCalled();
    expect(meter.settle).not.toHaveBeenCalled();
    expect(store.prepareProjectActivation).not.toHaveBeenCalled();
    expect(projectRuntime.activate).toHaveBeenCalledOnce();
  });

  it("suspends an expired warm Project without reserving a throwaway activation", async () => {
    const projectRuntime = runtime();
    const meter = usage();
    const store = baseStore();

    await runProjectWorkspaceJob({
      job: {
        ...job,
        status: "ready",
        sandboxId: job.sandboxName,
        sandboxDomain: "https://project.invalid",
        activationRevision: 4,
        authorityRevision: "authority-1",
        lastActivityAt: new Date(Date.now() - 60_000),
        idleDeadlineAt: new Date(Date.now() - 1_000),
      },
      workerId: "worker",
      store,
      runtime: projectRuntime,
      chat: quietChat(),
      usage: meter,
      storage: emptyStorage,
      goldenSnapshotId: "golden",
      config,
      signal: new AbortController().signal,
    });

    expect(projectRuntime.syncFiles).toHaveBeenCalledWith(
      expect.objectContaining({ files: [] }),
    );
    expect(projectRuntime.scrubAgentState).toHaveBeenCalledOnce();
    expect(projectRuntime.checkpointAndStop).toHaveBeenCalledOnce();
    expect(projectRuntime.activate).not.toHaveBeenCalled();
    expect(meter.reserve).not.toHaveBeenCalled();
    expect(meter.start).not.toHaveBeenCalled();
    expect(meter.settle).toHaveBeenCalledWith(expect.objectContaining({
      activationRevision: 4,
    }));
  });

  it("stops a warm Project at a credential boundary before admitting another prompt", async () => {
    const projectRuntime = runtime();
    const store = baseStore({
      revalidateProjectWorkspaceAuthority: vi.fn(async () => "boundary" as const),
    });
    await runProjectWorkspaceJob({
      job: {
        ...job,
        status: "stopped",
        sandboxId: job.sandboxName,
        checkpointId: "checkpoint-before-rotation",
        recycleRequestedAt: new Date("2026-07-23T20:00:00.000Z"),
        recycleReason: "boundary:secrets_changed",
      },
      workerId: "worker",
      store,
      runtime: projectRuntime,
      chat: quietChat(),
      usage: usage(),
      storage: emptyStorage,
      goldenSnapshotId: "golden",
      config,
      signal: new AbortController().signal,
    });

    expect(store.prepareProjectActivation).not.toHaveBeenCalled();
    expect(store.claimProjectPromptJobs).not.toHaveBeenCalled();
    expect(store.resolveProjectActivationEnvironment).not.toHaveBeenCalled();
    expect(projectRuntime.startServer).not.toHaveBeenCalled();
    expect(projectRuntime.scrubAgentState).toHaveBeenCalledOnce();
    expect(projectRuntime.checkpointAndStop).toHaveBeenCalledOnce();
    expect(store.completeProjectWorkspaceRecycle).toHaveBeenCalledWith(
      expect.objectContaining({ checkpointId: "checkpoint-1" }),
    );
  });

  it("keeps a transient runtime failure retryable after a lost start response and failed scrub", async () => {
    const prompt: ProjectPromptJob = {
      id: "lost-start-response",
      orgId: job.orgId,
      projectId: job.projectId,
      creatorId: job.creatorId,
      sessionId: "session-lost-start",
      sequence: 1,
      text: "Start once",
      model: "openai/gpt-5",
      opencodeSessionId: null,
      opencodeMessageId: "msg_lost_start",
      sendAttemptedAt: null,
      leaseOwner: "worker",
    };
    let claimed = false;
    const store = baseStore({
      claimProjectPromptJobs: vi.fn(async () => {
        if (claimed) return [];
        claimed = true;
        return [prompt];
      }),
    });
    const projectRuntime = runtime();
    vi.mocked(projectRuntime.startServer).mockRejectedValue(new Error("response lost"));
    vi.mocked(projectRuntime.scrubAgentState).mockRejectedValue(new Error("provider unavailable"));

    await expect(runProjectWorkspaceJob({
      job,
      workerId: "worker",
      store,
      runtime: projectRuntime,
      chat: quietChat(),
      usage: usage(),
      storage: emptyStorage,
      goldenSnapshotId: "golden",
      config,
      signal: new AbortController().signal,
    })).rejects.toBeInstanceOf(Error);

    expect(store.markProjectActivationExposureAttempted).toHaveBeenCalledOnce();
    expect(projectRuntime.startServer).toHaveBeenCalledOnce();
    expect(store.markProjectActivationInjected).not.toHaveBeenCalled();
    expect(projectRuntime.scrubAgentState).toHaveBeenCalledOnce();
    expect(projectRuntime.checkpointAndStop).not.toHaveBeenCalled();
    expect(store.updateProjectWorkspaceState).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "error",
        errorCode: "project_runtime_failed",
      }),
    );
    expect(store.releaseProjectWorkspaceLease).toHaveBeenCalledWith(
      expect.objectContaining({ delayMs: config.claimIntervalMs }),
    );
  });

  it("reserves needs-attention for an activated Project with no sandbox or checkpoint", async () => {
    const projectRuntime = runtime();
    vi.mocked(projectRuntime.observe).mockResolvedValue({
      state: "missing",
      startedAt: null,
      expiresAt: null,
      currentSnapshotId: null,
    });
    const store = baseStore();

    await expect(runProjectWorkspaceJob({
      job: {
        ...job,
        status: "error",
        sandboxId: job.sandboxName,
        checkpointId: null,
        activationRevision: 1,
      },
      workerId: "worker",
      store,
      runtime: projectRuntime,
      chat: quietChat(),
      usage: usage(),
      storage: emptyStorage,
      goldenSnapshotId: "golden",
      config,
      signal: new AbortController().signal,
    })).rejects.toThrow("Project workspace is missing and has no restorable checkpoint");

    expect(projectRuntime.activate).not.toHaveBeenCalled();
    expect(store.updateProjectWorkspaceState).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "needs_attention",
        errorCode: "project_workspace_unrecoverable",
      }),
    );
  });

  it("does not resurrect a tombstoned file restored by an older checkpoint", async () => {
    const restoredFiles = new Map([
      ["deleted.txt", Buffer.from("stale checkpoint bytes")],
    ]);
    const projectRuntime = runtime(restoredFiles);
    vi.mocked(projectRuntime.observe).mockResolvedValue({
      state: "stopped",
      startedAt: null,
      expiresAt: null,
      currentSnapshotId: "checkpoint-before-delete",
    });
    const store = baseStore({
      loadProjectMaterializationPlan: vi.fn(async () => ({
        desiredGeneration: 1,
        appliedGeneration: 1,
        desiredFileRevision: 0,
        appliedFileRevision: 0,
        checkpointGeneration: 1,
        skills: [],
        // The active S3 projection excludes the durable tombstone.
        bootstrapFiles: [],
      })),
      loadProjectFileBaseline: vi.fn(async () => []),
    });

    await runProjectWorkspaceJob({
      job: {
        ...job,
        status: "stopped",
        sandboxId: job.sandboxName,
        checkpointId: "checkpoint-before-delete",
        activationRevision: 1,
      },
      workerId: "worker",
      store,
      runtime: projectRuntime,
      chat: quietChat(),
      usage: usage(),
      storage: emptyStorage,
      goldenSnapshotId: "golden",
      config,
      signal: new AbortController().signal,
    });

    expect(projectRuntime.syncFiles).toHaveBeenCalledWith(
      expect.objectContaining({ files: [] }),
    );
    expect(restoredFiles.has("deleted.txt")).toBe(false);
    expect(store.persistProjectFiles).not.toHaveBeenCalledWith(
      expect.objectContaining({
        files: expect.arrayContaining([
          expect.objectContaining({ path: "files/deleted.txt" }),
        ]),
      }),
    );
  });

  it("resyncs the desired skill generation after restoring an older checkpoint", async () => {
    const projectRuntime = runtime();
    vi.mocked(projectRuntime.observe).mockResolvedValue({
      state: "stopped",
      startedAt: null,
      expiresAt: null,
      currentSnapshotId: "checkpoint-generation-1",
    });
    vi.mocked(projectRuntime.activate).mockResolvedValue({
      sandboxId: job.sandboxName,
      domain: "https://project.invalid",
      resumed: false,
      restoredFromSnapshot: true,
    });
    const store = baseStore({
      loadProjectMaterializationPlan: vi.fn(async () => ({
        desiredGeneration: 2,
        appliedGeneration: 2,
        desiredFileRevision: 0,
        appliedFileRevision: 0,
        checkpointGeneration: 1,
        skills: [],
        bootstrapFiles: [],
      })),
    });

    await runProjectWorkspaceJob({
      job: {
        ...job,
        status: "stopped",
        sandboxId: job.sandboxName,
        checkpointId: "checkpoint-generation-1",
        checkpointGeneration: 1,
        desiredGeneration: 2,
        appliedGeneration: 2,
        activationRevision: 1,
        lastActivityAt: new Date(Date.now() - config.idleMs - 1),
      },
      workerId: "worker",
      store,
      runtime: projectRuntime,
      chat: quietChat(),
      usage: usage(),
      storage: emptyStorage,
      goldenSnapshotId: "golden",
      config,
      signal: new AbortController().signal,
    });

    expect(store.updateProjectWorkspaceState).toHaveBeenCalledWith(
      expect.objectContaining({ appliedGeneration: 1 }),
    );
    expect(projectRuntime.syncSkillBundles).toHaveBeenCalledWith(
      expect.objectContaining({ generation: 2 }),
    );
    expect(store.updateProjectWorkspaceState).toHaveBeenCalledWith(
      expect.objectContaining({ appliedGeneration: 2 }),
    );
    expect(store.updateProjectWorkspaceState).toHaveBeenCalledWith(
      expect.objectContaining({
        checkpointId: "checkpoint-1",
        checkpointGeneration: 2,
        appliedGeneration: 2,
      }),
    );
    expect(projectRuntime.startServer).not.toHaveBeenCalled();
  });

  it("recovers a completed deterministic message without dispatching it twice", async () => {
    const recovered: ProjectPromptJob = {
      id: "recovered",
      orgId: job.orgId,
      projectId: job.projectId,
      creatorId: job.creatorId,
      sessionId: "session-recovered",
      sequence: 1,
      text: "Do not duplicate me",
      model: "openai/gpt-5",
      opencodeSessionId: "native-recovered",
      opencodeMessageId: "msg_recovered",
      sendAttemptedAt: new Date("2026-07-23T20:00:00.000Z"),
      leaseOwner: "worker",
    };
    let claimed = false;
    const store = baseStore({
      claimProjectPromptJobs: vi.fn(async () => {
        if (claimed) return [];
        claimed = true;
        return [recovered];
      }),
      loadProjectFileBaseline: vi.fn(async () => [{
        path: "files/removed.txt",
        version: 3,
        checksum: `sha256:${"0".repeat(64)}`,
      }]),
    });
    const chat = quietChat();
    vi.mocked(chat.getMessageState).mockResolvedValue("completed");
    vi.mocked(chat.loadItems).mockResolvedValue([{
      kind: "assistant",
      text: `generic-secret-value${"x".repeat(600_000)}`,
    }]);
    vi.mocked(chat.getFileChanges).mockResolvedValue([{
      path: "files/removed.txt",
      status: "deleted",
      patch: "",
    }]);

    await runProjectWorkspaceJob({
      job,
      workerId: "worker",
      store,
      runtime: runtime(),
      chat,
      usage: usage(),
      storage: emptyStorage,
      goldenSnapshotId: "golden",
      config,
      signal: new AbortController().signal,
    });

    expect(chat.findSessionByTitle).not.toHaveBeenCalled();
    expect(chat.createSession).not.toHaveBeenCalled();
    expect(chat.sendPrompt).not.toHaveBeenCalled();
    expect(store.completeProjectPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: recovered,
        opencodeSessionId: "native-recovered",
      }),
    );
    const completedTranscript = vi.mocked(store.completeProjectPrompt).mock.calls[0]?.[0].transcript;
    expect(Buffer.byteLength(JSON.stringify(completedTranscript), "utf8")).toBeLessThanOrEqual(
      512 * 1024,
    );
    expect(JSON.stringify(completedTranscript)).not.toContain("generic-secret-value");
    expect(store.persistProjectFileDeletions).toHaveBeenCalledWith(
      expect.objectContaining({
        files: [{
          path: "files/removed.txt",
          modifiedBySessionId: recovered.sessionId,
          modifiedByPromptId: recovered.id,
          baseVersion: 3,
        }],
      }),
    );
  });

  it("attributes deletion of a path created by another Session after turn start as a conflict", async () => {
    const prompt: ProjectPromptJob = {
      id: "delete-concurrent-create",
      orgId: job.orgId,
      projectId: job.projectId,
      creatorId: job.creatorId,
      sessionId: "session-delete-concurrent",
      sequence: 1,
      text: "Remove the concurrently-created draft",
      model: "openai/gpt-5",
      opencodeSessionId: null,
      opencodeMessageId: "msg_delete_concurrent",
      sendAttemptedAt: null,
      leaseOwner: "worker",
    };
    let claimed = false;
    let baselineReads = 0;
    const store = baseStore({
      claimProjectPromptJobs: vi.fn(async () => {
        if (claimed) return [];
        claimed = true;
        return [prompt];
      }),
      loadProjectFileBaseline: vi.fn(async () => {
        baselineReads += 1;
        return baselineReads === 1
          ? []
          : [{
              path: "files/draft.md",
              version: 1,
              checksum: `sha256:${"a".repeat(64)}`,
            }];
      }),
    });
    const chat = quietChat();
    vi.mocked(chat.getMessageState).mockResolvedValue("completed");
    vi.mocked(chat.getFileChanges).mockResolvedValue([{
      path: "draft.md",
      status: "deleted",
      patch: "",
    }]);

    await runProjectWorkspaceJob({
      job,
      workerId: "worker",
      store,
      runtime: runtime(new Map()),
      chat,
      usage: usage(),
      storage: emptyStorage,
      goldenSnapshotId: "golden",
      config,
      signal: new AbortController().signal,
    });

    expect(store.persistProjectFileDeletions).toHaveBeenCalledWith(
      expect.objectContaining({
        files: expect.arrayContaining([{
          path: "files/draft.md",
          modifiedBySessionId: prompt.sessionId,
          modifiedByPromptId: prompt.id,
          baseVersion: 0,
        }]),
      }),
    );
  });

  it("recreates and rehydrates a native session missing from the restored checkpoint", async () => {
    const followUp: ProjectPromptJob = {
      id: "follow-up",
      orgId: job.orgId,
      projectId: job.projectId,
      creatorId: job.creatorId,
      sessionId: "session-restored",
      sequence: 2,
      text: "Continue from the prior answer",
      model: "openai/gpt-5",
      opencodeSessionId: "native-after-checkpoint",
      opencodeMessageId: "msg_follow_up",
      sendAttemptedAt: null,
      leaseOwner: "worker",
    };
    const transcript = [
      { kind: "user" as const, text: "Initial question", message_id: "msg_initial" },
      { kind: "assistant" as const, text: "Prior durable answer", message_id: "msg_answer" },
    ];
    let claimed = false;
    let dispatched = false;
    const store = baseStore({
      claimProjectPromptJobs: vi.fn(async () => {
        if (claimed) return [];
        claimed = true;
        return [followUp];
      }),
      loadProjectSessionTranscript: vi.fn(async () => transcript),
    });
    const chat = quietChat();
    vi.mocked(chat.getSessionState).mockImplementation(async (_target, sessionId) =>
      sessionId === "native-after-checkpoint" ? "missing" : "idle");
    vi.mocked(chat.createSession).mockResolvedValue({
      id: "native-recreated",
      title: "companion:session-restored",
    });
    vi.mocked(chat.sendPrompt).mockImplementation(async () => {
      dispatched = true;
    });
    vi.mocked(chat.getMessageState).mockImplementation(async () =>
      dispatched ? "completed" : "missing");
    const projectRuntime = runtime();
    vi.mocked(projectRuntime.observe)
      .mockResolvedValueOnce({
        state: "stopped",
        startedAt: null,
        expiresAt: null,
        currentSnapshotId: "checkpoint-before-native-session",
      })
      .mockResolvedValue({
        state: "running",
        startedAt: new Date(),
        expiresAt: new Date(Date.now() + 600_000),
        currentSnapshotId: null,
      });

    await runProjectWorkspaceJob({
      job: {
        ...job,
        status: "stopped",
        sandboxId: job.sandboxName,
        checkpointId: "checkpoint-before-native-session",
        checkpointGeneration: 1,
        activationRevision: 1,
      },
      workerId: "worker",
      store,
      runtime: projectRuntime,
      chat,
      usage: usage(),
      storage: emptyStorage,
      goldenSnapshotId: "golden",
      config,
      signal: new AbortController().signal,
    });

    expect(chat.rehydrateSession).toHaveBeenCalledWith(
      expect.anything(),
      "native-recreated",
      transcript,
      expect.any(AbortSignal),
    );
    expect(store.rebindProjectSession).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: followUp,
        opencodeSessionId: "native-recreated",
      }),
    );
    expect(chat.sendPrompt).toHaveBeenCalledWith(
      expect.anything(),
      "native-recreated",
      followUp.text,
      followUp.opencodeMessageId,
      followUp.model,
      expect.any(AbortSignal),
    );
    expect(vi.mocked(chat.rehydrateSession).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(chat.sendPrompt).mock.invocationCallOrder[0]!);
  });

  it("never re-sends an attempted prompt when its restored native session is missing", async () => {
    const attempted: ProjectPromptJob = {
      id: "attempted",
      orgId: job.orgId,
      projectId: job.projectId,
      creatorId: job.creatorId,
      sessionId: "session-attempted",
      sequence: 1,
      text: "Potential external side effect",
      model: "openai/gpt-5",
      opencodeSessionId: "native-lost",
      opencodeMessageId: "msg_attempted",
      sendAttemptedAt: new Date("2026-07-23T20:00:00.000Z"),
      leaseOwner: "worker",
    };
    let claimed = false;
    const store = baseStore({
      claimProjectPromptJobs: vi.fn(async () => {
        if (claimed) return [];
        claimed = true;
        return [attempted];
      }),
    });
    const chat = quietChat();
    vi.mocked(chat.getSessionState).mockResolvedValue("missing");
    const projectRuntime = runtime();
    vi.mocked(projectRuntime.observe)
      .mockResolvedValueOnce({
        state: "stopped",
        startedAt: null,
        expiresAt: null,
        currentSnapshotId: "checkpoint-without-native-session",
      })
      .mockResolvedValue({
        state: "running",
        startedAt: new Date(),
        expiresAt: new Date(Date.now() + 600_000),
        currentSnapshotId: null,
      });

    await runProjectWorkspaceJob({
      job: {
        ...job,
        status: "stopped",
        sandboxId: job.sandboxName,
        checkpointId: "checkpoint-without-native-session",
        activationRevision: 1,
      },
      workerId: "worker",
      store,
      runtime: projectRuntime,
      chat,
      usage: usage(),
      storage: emptyStorage,
      goldenSnapshotId: "golden",
      config,
      signal: new AbortController().signal,
    });

    expect(chat.createSession).not.toHaveBeenCalled();
    expect(chat.rehydrateSession).not.toHaveBeenCalled();
    expect(chat.sendPrompt).not.toHaveBeenCalled();
    expect(store.failProjectPrompt).toHaveBeenCalledWith(expect.objectContaining({
      errorCode: "project_prompt_interrupted",
      retryAt: undefined,
    }));
  });

  it("keeps the workspace usable after an interrupted turn and admits a deliberate follow-up", async () => {
    // Product promise: an ambiguous attempted turn is never replayed, but it remains a
    // conversation-level failure. The same Project loop must return to ready and accept the
    // member's explicit next message without entering the workspace error path.
    const interrupted: ProjectPromptJob = {
      id: "interrupted-then-continued",
      orgId: job.orgId,
      projectId: job.projectId,
      creatorId: job.creatorId,
      sessionId: "session-interrupted-then-continued",
      sequence: 1,
      text: "Potential external side effect",
      model: "openai/gpt-5",
      opencodeSessionId: "native-lost",
      opencodeMessageId: "msg_interrupted_then_continued",
      sendAttemptedAt: new Date("2026-07-23T20:00:00.000Z"),
      leaseOwner: "worker",
    };
    const followUp: ProjectPromptJob = {
      ...interrupted,
      id: "explicit-follow-up",
      sequence: 2,
      text: "Continue from the files that are already safe",
      opencodeMessageId: "msg_explicit_follow_up",
      sendAttemptedAt: null,
    };
    const pending = [interrupted, followUp];
    const sentMessages = new Set<string>();
    const store = baseStore({
      claimProjectPromptJobs: vi.fn(async () => {
        const next = pending.shift();
        return next ? [next] : [];
      }),
    });
    const chat = quietChat();
    vi.mocked(chat.getSessionState).mockResolvedValue("missing");
    vi.mocked(chat.getMessageState).mockImplementation(
      async (_target, _sessionId, messageId) =>
        sentMessages.has(messageId) ? "completed" : "missing",
    );
    vi.mocked(chat.sendPrompt).mockImplementation(
      async (_target, _sessionId, _text, messageId) => {
        sentMessages.add(messageId);
      },
    );
    const projectRuntime = runtime();
    vi.mocked(projectRuntime.observe)
      .mockResolvedValueOnce({
        state: "stopped",
        startedAt: null,
        expiresAt: null,
        currentSnapshotId: "checkpoint-without-native-session",
      })
      .mockResolvedValue({
        state: "running",
        startedAt: new Date(),
        expiresAt: new Date(Date.now() + 600_000),
        currentSnapshotId: null,
      });

    await runProjectWorkspaceJob({
      job: {
        ...job,
        status: "stopped",
        sandboxId: job.sandboxName,
        checkpointId: "checkpoint-without-native-session",
        activationRevision: 1,
      },
      workerId: "worker",
      store,
      runtime: projectRuntime,
      chat,
      usage: usage(),
      storage: emptyStorage,
      goldenSnapshotId: "golden",
      config: { ...config, concurrency: 1 },
      signal: new AbortController().signal,
    });

    expect(store.failProjectPrompt).toHaveBeenCalledWith(expect.objectContaining({
      prompt: interrupted,
      errorCode: "project_prompt_interrupted",
      retryAt: undefined,
    }));
    expect(chat.sendPrompt).toHaveBeenCalledTimes(1);
    expect(chat.sendPrompt).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      followUp.text,
      followUp.opencodeMessageId,
      followUp.model,
      expect.any(AbortSignal),
    );
    expect(store.completeProjectPrompt).toHaveBeenCalledWith(expect.objectContaining({
      prompt: followUp,
    }));
    expect(vi.mocked(store.updateProjectWorkspaceState).mock.calls
      .some(([state]) => state.status === "error")).toBe(false);
  });

  it("does not send when the durable send fence was already marked by a stale attempt", async () => {
    const prompt: ProjectPromptJob = {
      id: "stale-send-fence",
      orgId: job.orgId,
      projectId: job.projectId,
      creatorId: job.creatorId,
      sessionId: "session-stale-send",
      sequence: 1,
      text: "Do this once",
      model: "openai/gpt-5",
      opencodeSessionId: null,
      opencodeMessageId: "msg_stale_send",
      sendAttemptedAt: null,
      leaseOwner: "worker",
    };
    let claimed = false;
    const store = baseStore({
      claimProjectPromptJobs: vi.fn(async () => {
        if (claimed) return [];
        claimed = true;
        return [prompt];
      }),
      markProjectPromptSendAttempted: vi.fn(async () => "lost" as const),
    });
    const chat = quietChat();

    await expect(runProjectWorkspaceJob({
      job,
      workerId: "worker",
      store,
      runtime: runtime(),
      chat,
      usage: usage(),
      storage: emptyStorage,
      goldenSnapshotId: "golden",
      config,
      signal: new AbortController().signal,
    })).rejects.toBeInstanceOf(Error);

    expect(chat.sendPrompt).not.toHaveBeenCalled();
    expect(store.failProjectPrompt).not.toHaveBeenCalled();
    expect(store.updateProjectWorkspaceState).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: "project_lease_lost" }),
    );
  });

  it("requeues a claimed prompt when its provider disconnects at the final pre-send fence", async () => {
    const prompt: ProjectPromptJob = {
      id: "provider-disconnected-pre-send",
      orgId: job.orgId,
      projectId: job.projectId,
      creatorId: job.creatorId,
      sessionId: "session-provider-disconnected",
      sequence: 1,
      text: "Do not send without my provider",
      model: "openai/gpt-5",
      opencodeSessionId: null,
      opencodeMessageId: "msg_provider_disconnected",
      sendAttemptedAt: null,
      leaseOwner: "worker",
    };
    let claimed = false;
    let blocked = false;
    const store = baseStore({
      inspectProjectPromptProviderAdmission: vi.fn(async () =>
        blocked ? "provider_unavailable" as const : "admitted" as const),
      claimProjectPromptJobs: vi.fn(async () => {
        if (claimed) return [];
        claimed = true;
        return [prompt];
      }),
      markProjectPromptSendAttempted: vi.fn(async () => {
        blocked = true;
        return "provider_unavailable" as const;
      }),
    });
    const chat = quietChat();

    await runProjectWorkspaceJob({
      job,
      workerId: "worker",
      store,
      runtime: runtime(),
      chat,
      usage: usage(),
      storage: emptyStorage,
      goldenSnapshotId: "golden",
      config,
      signal: new AbortController().signal,
    });

    expect(store.revalidateProjectPromptProviderAdmission).toHaveBeenCalled();
    expect(store.requeueProjectPromptAtBoundary).toHaveBeenCalledWith(
      expect.objectContaining({ prompt }),
    );
    expect(store.markProjectPromptSendAttempted).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt,
        activationRevision: 1,
        authorityRevision: "authority-1",
      }),
    );
    expect(chat.sendPrompt).not.toHaveBeenCalled();
    expect(store.updateProjectWorkspaceState).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "ready",
        errorCode: "project_provider_unavailable",
      }),
    );
  });

  it("recycles without sending when revocation wins the atomic send fence", async () => {
    const prompt: ProjectPromptJob = {
      id: "recycle-pre-send",
      orgId: job.orgId,
      projectId: job.projectId,
      creatorId: job.creatorId,
      sessionId: "session-recycle-pre-send",
      sequence: 1,
      text: "This must stay behind the revoke fence",
      model: "openai/gpt-5",
      opencodeSessionId: null,
      opencodeMessageId: "msg_recycle_pre_send",
      sendAttemptedAt: null,
      leaseOwner: "worker",
    };
    let claimed = false;
    const store = baseStore({
      claimProjectPromptJobs: vi.fn(async () => {
        if (claimed) return [];
        claimed = true;
        return [prompt];
      }),
      markProjectPromptSendAttempted: vi.fn(async () => "recycle" as const),
    });
    const chat = quietChat();
    const projectRuntime = runtime();

    await runProjectWorkspaceJob({
      job,
      workerId: "worker",
      store,
      runtime: projectRuntime,
      chat,
      usage: usage(),
      storage: emptyStorage,
      goldenSnapshotId: "golden",
      config,
      signal: new AbortController().signal,
    });

    expect(store.markProjectPromptSendAttempted).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt,
        activationRevision: 1,
        authorityRevision: "authority-1",
      }),
    );
    expect(chat.sendPrompt).not.toHaveBeenCalled();
    expect(store.requeueProjectPrompts).toHaveBeenCalledWith(
      expect.objectContaining({
        prompts: expect.arrayContaining([prompt]),
        reason: "project_credentials_recycled",
      }),
    );
    expect(projectRuntime.scrubAgentState).toHaveBeenCalledOnce();
    expect(projectRuntime.checkpointAndStop).toHaveBeenCalledOnce();
    expect(store.completeProjectWorkspaceRecycle).toHaveBeenCalledOnce();
  });

  it("fails closed when a persisted native message is pending but its session is idle", async () => {
    const prompt: ProjectPromptJob = {
      id: "pending-idle",
      orgId: job.orgId,
      projectId: job.projectId,
      creatorId: job.creatorId,
      sessionId: "session-pending-idle",
      sequence: 1,
      text: "Already attempted",
      model: "openai/gpt-5",
      opencodeSessionId: "native-pending-idle",
      opencodeMessageId: "msg_pending_idle",
      sendAttemptedAt: new Date("2026-07-23T20:00:00.000Z"),
      leaseOwner: "worker",
    };
    let claimed = false;
    const store = baseStore({
      claimProjectPromptJobs: vi.fn(async () => {
        if (claimed) return [];
        claimed = true;
        return [prompt];
      }),
    });
    const chat = quietChat();
    vi.mocked(chat.getSessionState).mockResolvedValue("idle");
    vi.mocked(chat.getMessageState).mockResolvedValue("pending");

    await runProjectWorkspaceJob({
      job,
      workerId: "worker",
      store,
      runtime: runtime(),
      chat,
      usage: usage(),
      storage: emptyStorage,
      goldenSnapshotId: "golden",
      config,
      signal: new AbortController().signal,
    });

    expect(chat.sendPrompt).not.toHaveBeenCalled();
    expect(store.failProjectPrompt).toHaveBeenCalledWith(expect.objectContaining({
      errorCode: "project_prompt_interrupted",
      retryAt: undefined,
    }));
  });

  it("does not interrupt a delivered reply while OpenCode message and idle views converge", async () => {
    // Product promise: a reply already delivered to the live stream is durably completed even when
    // OpenCode's message and session endpoints briefly disagree. This worker-level test exercises
    // the non-atomic poll boundary; restoring immediate idle failure makes it fail sensitively.
    const prompt: ProjectPromptJob = {
      id: "idle-convergence",
      orgId: job.orgId,
      projectId: job.projectId,
      creatorId: job.creatorId,
      sessionId: "session-idle-convergence",
      sequence: 1,
      text: "Reply quickly",
      model: "openai/gpt-5",
      opencodeSessionId: null,
      opencodeMessageId: "msg_idle_convergence",
      sendAttemptedAt: null,
      leaseOwner: "worker",
    };
    let claimed = false;
    let sent = false;
    let messagePoll = 0;
    let sessionPoll = 0;
    const store = baseStore({
      claimProjectPromptJobs: vi.fn(async () => {
        if (claimed) return [];
        claimed = true;
        return [prompt];
      }),
    });
    const chat = quietChat();
    vi.mocked(chat.sendPrompt).mockImplementation(async () => {
      sent = true;
    });
    vi.mocked(chat.getMessageState).mockImplementation(async () => {
      if (!sent) return "missing";
      messagePoll += 1;
      return messagePoll >= 3 ? "completed" : "pending";
    });
    vi.mocked(chat.getSessionState).mockImplementation(async () => {
      sessionPoll += 1;
      return sessionPoll === 1 ? "busy" : "idle";
    });

    await runProjectWorkspaceJob({
      job,
      workerId: "worker",
      store,
      runtime: runtime(),
      chat,
      usage: usage(),
      storage: emptyStorage,
      goldenSnapshotId: "golden",
      config,
      signal: new AbortController().signal,
    });

    expect(chat.sendPrompt).toHaveBeenCalledOnce();
    expect(store.failProjectPrompt).not.toHaveBeenCalled();
    expect(store.completeProjectPrompt).toHaveBeenCalledOnce();
  });

  it("still fails closed when a newly dispatched prompt remains pending and idle", async () => {
    // The bounded convergence window must not weaken the no-replay boundary. A turn with no durable
    // assistant reply remains ambiguous and is terminalized without a second send.
    const prompt: ProjectPromptJob = {
      id: "idle-interrupted",
      orgId: job.orgId,
      projectId: job.projectId,
      creatorId: job.creatorId,
      sessionId: "session-idle-interrupted",
      sequence: 1,
      text: "Potential external side effect",
      model: "openai/gpt-5",
      opencodeSessionId: null,
      opencodeMessageId: "msg_idle_interrupted",
      sendAttemptedAt: null,
      leaseOwner: "worker",
    };
    let claimed = false;
    let sent = false;
    let sessionPoll = 0;
    const store = baseStore({
      claimProjectPromptJobs: vi.fn(async () => {
        if (claimed) return [];
        claimed = true;
        return [prompt];
      }),
    });
    const chat = quietChat();
    vi.mocked(chat.sendPrompt).mockImplementation(async () => {
      sent = true;
    });
    vi.mocked(chat.getMessageState).mockImplementation(async () =>
      sent ? "pending" : "missing");
    vi.mocked(chat.getSessionState).mockImplementation(async () => {
      sessionPoll += 1;
      return sessionPoll === 1 ? "busy" : "idle";
    });

    await runProjectWorkspaceJob({
      job,
      workerId: "worker",
      store,
      runtime: runtime(),
      chat,
      usage: usage(),
      storage: emptyStorage,
      goldenSnapshotId: "golden",
      config,
      signal: new AbortController().signal,
    });

    expect(chat.sendPrompt).toHaveBeenCalledOnce();
    expect(store.completeProjectPrompt).not.toHaveBeenCalled();
    expect(store.failProjectPrompt).toHaveBeenCalledWith(expect.objectContaining({
      errorCode: "project_prompt_interrupted",
      retryAt: undefined,
    }));
  });

  it("interrupts and recycles an active turn immediately when credential authority is revoked", async () => {
    const prompt: ProjectPromptJob = {
      id: "revoked-active",
      orgId: job.orgId,
      projectId: job.projectId,
      creatorId: job.creatorId,
      sessionId: "session-revoked",
      sequence: 1,
      text: "Long running turn",
      model: "openai/gpt-5",
      opencodeSessionId: null,
      opencodeMessageId: "msg_revoked",
      sendAttemptedAt: null,
      leaseOwner: "worker",
    };
    let claimed = false;
    let sent = false;
    const store = baseStore({
      claimProjectPromptJobs: vi.fn(async () => {
        if (claimed) return [];
        claimed = true;
        return [prompt];
      }),
      revalidateProjectWorkspaceAuthority: vi.fn(async () =>
        sent ? "immediate" as const : "current" as const),
    });
    const chat = quietChat();
    vi.mocked(chat.sendPrompt).mockImplementation(async () => {
      sent = true;
    });
    vi.mocked(chat.getMessageState).mockImplementation(async () =>
      sent ? "pending" : "missing");
    vi.mocked(chat.getSessionState).mockResolvedValue("busy");
    const projectRuntime = runtime();

    await runProjectWorkspaceJob({
      job,
      workerId: "worker",
      store,
      runtime: projectRuntime,
      chat,
      usage: usage(),
      storage: emptyStorage,
      goldenSnapshotId: "golden",
      config: { ...config, heartbeatMs: 5, idleMs: 60_000 },
      signal: new AbortController().signal,
    });

    expect(chat.sendPrompt).toHaveBeenCalledOnce();
    expect(chat.abortSession).toHaveBeenCalledWith(
      expect.anything(),
      "companion:session-revoked",
      expect.anything(),
    );
    expect(store.requeueProjectPrompts).toHaveBeenCalledWith(expect.objectContaining({
      prompts: expect.arrayContaining([prompt]),
      reason: "project_credentials_recycled",
    }));
    expect(projectRuntime.scrubAgentState).toHaveBeenCalledOnce();
    expect(projectRuntime.checkpointAndStop).toHaveBeenCalledOnce();
    expect(store.completeProjectWorkspaceRecycle).toHaveBeenCalledOnce();
  });

  it("extends provider time only after refreshed durable budget admits it", async () => {
    const prompt: ProjectPromptJob = {
      id: "extend-active",
      orgId: job.orgId,
      projectId: job.projectId,
      creatorId: job.creatorId,
      sessionId: "session-extend",
      sequence: 1,
      text: "Keep working",
      model: "openai/gpt-5",
      opencodeSessionId: null,
      opencodeMessageId: "msg_extend",
      sendAttemptedAt: null,
      leaseOwner: "worker",
    };
    let claimed = false;
    let sent = false;
    let extended = false;
    const store = baseStore({
      claimProjectPromptJobs: vi.fn(async () => {
        if (claimed) return [];
        claimed = true;
        return [prompt];
      }),
    });
    const meter = usage();
    vi.mocked(meter.refresh).mockImplementation(async () => {
      extended = true;
      return { limitMs: 2_000 };
    });
    const projectRuntime = runtime();
    vi.mocked(projectRuntime.observe).mockImplementation(async () => ({
      state: "running",
      startedAt: new Date(),
      expiresAt: new Date(Date.now() + 5),
      currentSnapshotId: null,
    }));
    const chat = quietChat();
    vi.mocked(chat.sendPrompt).mockImplementation(async () => {
      sent = true;
    });
    vi.mocked(chat.getMessageState).mockImplementation(async () => {
      if (!sent) return "missing";
      return extended ? "completed" : "pending";
    });
    vi.mocked(chat.getSessionState).mockResolvedValue("busy");

    await runProjectWorkspaceJob({
      job,
      workerId: "worker",
      store,
      runtime: projectRuntime,
      chat,
      usage: meter,
      storage: emptyStorage,
      goldenSnapshotId: "golden",
      config: {
        ...config,
        heartbeatMs: 5,
        idleMs: 60_000,
        sandboxTimeoutMs: 1_000,
        maxActivationMs: 4_000,
      },
      signal: new AbortController().signal,
    });

    expect(meter.refresh).toHaveBeenCalledWith(expect.objectContaining({
      activationRevision: 1,
    }));
    expect(projectRuntime.extendTimeout).toHaveBeenCalled();
    expect(vi.mocked(meter.refresh).mock.invocationCallOrder[0]!)
      .toBeLessThan(vi.mocked(projectRuntime.extendTimeout).mock.invocationCallOrder[0]!);
  });

  it("admits and provisions the exact idle runway after a completed turn", async () => {
    // Product promise: Ready means the warm Project can actually survive until its advertised
    // idle deadline. This worker-level test fixes provider expiry at the original ten-minute
    // activation and proves the post-turn delta is reserved before Vercel is extended.
    const prompt: ProjectPromptJob = {
      id: "idle-runway",
      orgId: job.orgId,
      projectId: job.projectId,
      creatorId: job.creatorId,
      sessionId: "session-idle-runway",
      sequence: 1,
      text: "Create a short result",
      model: "openai/gpt-5",
      opencodeSessionId: null,
      opencodeMessageId: "msg_idle_runway",
      sendAttemptedAt: null,
      leaseOwner: "worker",
    };
    let claimed = false;
    let sent = false;
    const store = baseStore({
      claimProjectPromptJobs: vi.fn(async () => {
        if (claimed) return [];
        claimed = true;
        return [prompt];
      }),
    });
    const meter = usage();
    vi.mocked(meter.extendIdleRunway).mockImplementation(
      async ({ minimumRuntimeMs }) => ({ limitMs: minimumRuntimeMs }),
    );
    const activatedAt = Date.now();
    const initialExpiry = activatedAt + 10 * 60_000;
    const projectRuntime = runtime();
    vi.mocked(projectRuntime.observe).mockResolvedValue({
      state: "running",
      startedAt: new Date(activatedAt),
      expiresAt: new Date(initialExpiry),
      currentSnapshotId: null,
    });
    vi.mocked(projectRuntime.extendTimeout).mockImplementation(
      async (_ref, additionalMs) => ({
        state: "running",
        startedAt: new Date(activatedAt),
        expiresAt: new Date(initialExpiry + additionalMs),
        currentSnapshotId: null,
      }),
    );
    const chat = quietChat();
    vi.mocked(chat.sendPrompt).mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      sent = true;
    });
    vi.mocked(chat.getMessageState).mockImplementation(async () =>
      sent ? "completed" : "missing");

    await runProjectWorkspaceJob({
      job,
      workerId: "worker",
      store,
      runtime: projectRuntime,
      chat,
      usage: meter,
      storage: emptyStorage,
      goldenSnapshotId: "golden",
      config: {
        ...config,
        idleMs: 10 * 60_000,
        sandboxTimeoutMs: 10 * 60_000,
        maxActivationMs: 30 * 60_000,
      },
      signal: new AbortController().signal,
    });

    const runway = vi.mocked(meter.extendIdleRunway).mock.calls[0]?.[0];
    expect(runway?.minimumRuntimeMs).toBeGreaterThan(10 * 60_000);
    expect(projectRuntime.extendTimeout).toHaveBeenCalledOnce();
    expect(vi.mocked(meter.extendIdleRunway).mock.invocationCallOrder[0]!)
      .toBeLessThan(vi.mocked(projectRuntime.extendTimeout).mock.invocationCallOrder[0]!);
    const workspaceStateCalls = vi.mocked(store.updateProjectWorkspaceState).mock.calls;
    const readyCallIndex = workspaceStateCalls.findIndex(
      ([state]) => state.status === "ready" && state.idleDeadlineAt,
    );
    const readyState = workspaceStateCalls[readyCallIndex]?.[0];
    const readyCallOrder =
      vi.mocked(store.updateProjectWorkspaceState).mock.invocationCallOrder[readyCallIndex]!;
    expect(vi.mocked(projectRuntime.extendTimeout).mock.invocationCallOrder[0]!)
      .toBeLessThan(readyCallOrder);
    expect(workspaceStateCalls.filter(([state]) => state.status === "ready")).toHaveLength(1);
    const extension = await vi.mocked(projectRuntime.extendTimeout).mock.results[0]?.value;
    expect(readyState?.idleDeadlineAt).toBeInstanceOf(Date);
    expect(extension?.expiresAt).toBeInstanceOf(Date);
    expect(extension?.expiresAt?.getTime()).toBeGreaterThanOrEqual(
      readyState?.idleDeadlineAt?.getTime() ?? Number.POSITIVE_INFINITY,
    );
  });

  it("never publishes Ready when post-turn idle admission crashes", async () => {
    // Regression caught: a crash after the final prompt used to leave Ready + idleDeadlineAt
    // durable before billing/provider runway existed. A retry could then sleep until a deadline
    // that Vercel was not guaranteed to honor.
    const prompt: ProjectPromptJob = {
      id: "idle-runway-crash",
      orgId: job.orgId,
      projectId: job.projectId,
      creatorId: job.creatorId,
      sessionId: "session-idle-runway-crash",
      sequence: 1,
      text: "Finish, then fail idle admission",
      model: "openai/gpt-5",
      opencodeSessionId: null,
      opencodeMessageId: "msg_idle_runway_crash",
      sendAttemptedAt: null,
      leaseOwner: "worker",
    };
    let claimed = false;
    let sent = false;
    const store = baseStore({
      claimProjectPromptJobs: vi.fn(async () => {
        if (claimed) return [];
        claimed = true;
        return [prompt];
      }),
    });
    const meter = usage();
    vi.mocked(meter.extendIdleRunway).mockRejectedValue(
      new Error("simulated crash before idle admission commits"),
    );
    const projectRuntime = runtime();
    const chat = quietChat();
    vi.mocked(chat.sendPrompt).mockImplementation(async () => {
      sent = true;
    });
    vi.mocked(chat.getMessageState).mockImplementation(async () =>
      sent ? "completed" : "missing");

    await expect(runProjectWorkspaceJob({
      job,
      workerId: "worker",
      store,
      runtime: projectRuntime,
      chat,
      usage: meter,
      storage: emptyStorage,
      goldenSnapshotId: "golden",
      config: {
        ...config,
        idleMs: 10 * 60_000,
        sandboxTimeoutMs: 10 * 60_000,
        maxActivationMs: 30 * 60_000,
      },
      signal: new AbortController().signal,
    })).rejects.toThrow("simulated crash before idle admission commits");

    expect(store.completeProjectPrompt).toHaveBeenCalledOnce();
    expect(meter.extendIdleRunway).toHaveBeenCalledOnce();
    expect(projectRuntime.extendTimeout).not.toHaveBeenCalled();
    const workspaceStates = vi.mocked(store.updateProjectWorkspaceState).mock.calls
      .map(([state]) => state);
    expect(workspaceStates.some((state) => state.status === "ready")).toBe(false);
    expect(workspaceStates.some((state) => state.idleDeadlineAt instanceof Date)).toBe(false);
    expect(workspaceStates).toContainEqual(expect.objectContaining({
      status: "error",
      errorCode: "project_runtime_failed",
    }));
  });

  it("checkpoints cleanly when quota denies the post-turn idle runway", async () => {
    // Quota exhaustion may shorten warmth, never trust. The completed conversation stays durable
    // and the workspace scales to zero without entering the global Project error state.
    const prompt: ProjectPromptJob = {
      id: "idle-runway-denied",
      orgId: job.orgId,
      projectId: job.projectId,
      creatorId: job.creatorId,
      sessionId: "session-idle-runway-denied",
      sequence: 1,
      text: "Finish before quota runs out",
      model: "openai/gpt-5",
      opencodeSessionId: null,
      opencodeMessageId: "msg_idle_runway_denied",
      sendAttemptedAt: null,
      leaseOwner: "worker",
    };
    let claimed = false;
    let sent = false;
    const store = baseStore({
      claimProjectPromptJobs: vi.fn(async () => {
        if (claimed) return [];
        claimed = true;
        return [prompt];
      }),
    });
    const meter = usage();
    vi.mocked(meter.extendIdleRunway).mockRejectedValue(new EntitlementDeniedError({
      code: "sandbox_quota_exhausted",
      feature: "sandbox_runs",
      message: "No sandbox minutes remain.",
      effectivePlan: "pro",
      limit: 250,
      current: 250,
      upgradeUrl: "/settings?view=billing",
    }));
    const projectRuntime = runtime();
    const chat = quietChat();
    vi.mocked(chat.sendPrompt).mockImplementation(async () => {
      sent = true;
    });
    vi.mocked(chat.getMessageState).mockImplementation(async () =>
      sent ? "completed" : "missing");

    await runProjectWorkspaceJob({
      job,
      workerId: "worker",
      store,
      runtime: projectRuntime,
      chat,
      usage: meter,
      storage: emptyStorage,
      goldenSnapshotId: "golden",
      config: {
        ...config,
        idleMs: 10 * 60_000,
        sandboxTimeoutMs: 10 * 60_000,
        maxActivationMs: 30 * 60_000,
      },
      signal: new AbortController().signal,
    });

    expect(store.completeProjectPrompt).toHaveBeenCalledOnce();
    expect(projectRuntime.extendTimeout).not.toHaveBeenCalled();
    expect(projectRuntime.checkpointAndStop).toHaveBeenCalledOnce();
    expect(meter.settle).toHaveBeenCalledOnce();
    expect(store.updateProjectWorkspaceState).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "stopped",
        idleDeadlineAt: null,
        errorCode: null,
        errorMessage: null,
      }),
    );
    expect(vi.mocked(store.updateProjectWorkspaceState).mock.calls
      .some(([state]) => state.status === "error")).toBe(false);
  });

  it("falls back to the guarded LWW mirror for binary output without failing the prompt", async () => {
    const binary = Buffer.from("%PDF-1.7\\ncompanion\\0binary", "utf8");
    const files = new Map<string, Buffer>();
    const projectRuntime = runtime(files);
    const prompt: ProjectPromptJob = {
      id: "binary",
      orgId: job.orgId,
      projectId: job.projectId,
      creatorId: job.creatorId,
      sessionId: "session-binary",
      sequence: 1,
      text: "Create a PDF",
      model: "openai/gpt-5",
      opencodeSessionId: null,
      opencodeMessageId: "msg_binary",
      sendAttemptedAt: null,
      leaseOwner: "worker",
    };
    let claimed = false;
    let sent = false;
    const persisted: ProjectCachedFile[] = [];
    const store = baseStore({
      claimProjectPromptJobs: vi.fn(async () => {
        if (claimed) return [];
        claimed = true;
        return [prompt];
      }),
      persistProjectFiles: vi.fn(async ({ files: next }) => {
        persisted.push(...next);
      }),
    });
    const chat = quietChat();
    vi.mocked(chat.sendPrompt).mockImplementation(async () => {
      files.set("result.pdf", binary);
      sent = true;
    });
    vi.mocked(chat.getMessageState).mockImplementation(async () =>
      sent ? "completed" : "missing");
    vi.mocked(chat.getFileChanges).mockResolvedValue([{
      path: "result.pdf",
      status: "added",
      patch: "Binary files differ",
    }, {
      path: ".git/config",
      status: "added",
      patch: "@@ -0,0 +1,1 @@\n+[core]\n",
    }]);
    const putContentAddressed = vi.fn(async ({ orgId, projectId, checksum }: {
      orgId: string;
      projectId: string;
      checksum: string;
    }) => projectFileCacheKey({ orgId, projectId, checksum }));

    await runProjectWorkspaceJob({
      job,
      workerId: "worker",
      store,
      runtime: projectRuntime,
      chat,
      usage: usage(),
      storage: {
        ...emptyStorage,
        putContentAddressed,
      },
      goldenSnapshotId: "golden",
      config,
      signal: new AbortController().signal,
    });

    expect(store.failProjectPrompt).not.toHaveBeenCalled();
    expect(store.completeProjectPrompt).toHaveBeenCalledOnce();
    expect(persisted).toContainEqual(expect.objectContaining({
      path: "files/result.pdf",
      modifiedBySessionId: null,
      modifiedByPromptId: null,
      byteSize: binary.length,
    }));
    expect(persisted).not.toContainEqual(expect.objectContaining({
      path: "files/.git/config",
    }));
    const expectedStorageKey = projectFileCacheKey({
      orgId: job.orgId,
      projectId: job.projectId,
      checksum: `sha256:${createHash("sha256").update(binary).digest("hex")}`,
    });
    expect(store.reserveProjectFileStorageObject).toHaveBeenCalledWith({
      job,
      workerId: "worker",
      storageKey: expectedStorageKey,
    });
    expect(vi.mocked(store.reserveProjectFileStorageObject).mock.invocationCallOrder[0])
      .toBeLessThan(putContentAddressed.mock.invocationCallOrder[0]!);
  });

  it("preserves both turn versions while the final LWW pointer follows shared filesystem bytes", async () => {
    const baseBytes = Buffer.from("base\n");
    const aBytes = Buffer.from("session-a\n");
    const bBytes = Buffer.from("session-b\n");
    const checksum = (bytes: Buffer) =>
      `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    const shared = new Map<string, Buffer>();
    const projectRuntime = runtime(shared);
    const prompt = (id: "a" | "b"): ProjectPromptJob => ({
      id,
      orgId: job.orgId,
      projectId: job.projectId,
      creatorId: job.creatorId,
      sessionId: `session-${id}`,
      sequence: 1,
      text: `Write ${id}`,
      model: id === "a" ? "openai/gpt-5" : "google/gemini-2.5-pro",
      opencodeSessionId: null,
      opencodeMessageId: `msg_${id}`,
      sendAttemptedAt: null,
      leaseOwner: "worker",
    });
    const a = prompt("a");
    const b = prompt("b");
    let claimed = false;
    const sent = new Set<string>();
    const versions: ProjectCachedFile[] = [];
    let current = {
      path: "files/report.txt",
      version: 1,
      checksum: checksum(baseBytes),
    };
    let releaseB!: () => void;
    const bPersisted = new Promise<void>((resolve) => {
      releaseB = resolve;
    });
    const store = baseStore({
      loadProjectMaterializationPlan: vi.fn(async () => ({
        desiredGeneration: 1,
        appliedGeneration: 1,
        desiredFileRevision: 0,
        appliedFileRevision: 0,
        checkpointGeneration: 0,
        skills: [],
        bootstrapFiles: [{
          storageKey: "base",
          workspacePath: "files/report.txt",
          checksum: checksum(baseBytes),
        }],
      })),
      claimProjectPromptJobs: vi.fn(async () => {
        if (claimed) return [];
        claimed = true;
        return [a, b];
      }),
      loadProjectFileBaseline: vi.fn(async () => [current]),
      persistProjectFiles: vi.fn(async ({ files }) => {
        for (const file of files) {
          current = {
            path: file.path,
            version: current.version + 1,
            checksum: file.checksum,
          };
          versions.push(file);
          if (file.modifiedBySessionId === b.sessionId) releaseB();
        }
      }),
    });
    const chat = quietChat();
    vi.mocked(chat.createSession).mockImplementation(async (_target, title) => ({
      id: title,
      title,
    }));
    vi.mocked(chat.sendPrompt).mockImplementation(async (_target, sessionId) => {
      sent.add(sessionId);
      if (sent.size === 2) shared.set("report.txt", bBytes);
    });
    vi.mocked(chat.getMessageState).mockImplementation(async (_target, sessionId) => {
      if (!sent.has(sessionId)) return "missing";
      return sent.size === 2 ? "completed" : "pending";
    });
    vi.mocked(chat.getSessionState).mockResolvedValue("busy");
    vi.mocked(chat.getFileChanges).mockImplementation(async (_target, sessionId) => {
      if (sessionId.endsWith("session-a")) await bPersisted;
      const value = sessionId.endsWith("session-a") ? "session-a" : "session-b";
      return [{
        path: "report.txt",
        status: "modified",
        patch: `@@ -1,1 +1,1 @@\n-base\n+${value}\n`,
      }];
    });
    const storedBodies = new Map<string, Buffer>();
    const storage: ProjectFileStorage = {
      get: vi.fn(async (key) => key === "base" ? baseBytes : Buffer.alloc(0)),
      putContentAddressed: vi.fn(async ({ orgId, projectId, checksum: value, body }) => {
        storedBodies.set(value, Buffer.from(body));
        return projectFileCacheKey({ orgId, projectId, checksum: value });
      }),
      delete: vi.fn(async () => undefined),
    };

    await runProjectWorkspaceJob({
      job,
      workerId: "worker",
      store,
      runtime: projectRuntime,
      chat,
      usage: usage(),
      storage,
      goldenSnapshotId: "golden",
      config,
      signal: new AbortController().signal,
    });

    expect(versions).toContainEqual(expect.objectContaining({
      checksum: checksum(aBytes),
      modifiedBySessionId: a.sessionId,
      modifiedByPromptId: a.id,
    }));
    expect(versions).toContainEqual(expect.objectContaining({
      checksum: checksum(bBytes),
      modifiedBySessionId: b.sessionId,
      modifiedByPromptId: b.id,
    }));
    expect(storedBodies.get(checksum(aBytes))).toEqual(aBytes);
    expect(storedBodies.get(checksum(bBytes))).toEqual(bBytes);
    expect(current).toMatchObject({
      checksum: checksum(bBytes),
    });
    expect(versions.at(-1)).toMatchObject({
      checksum: checksum(bBytes),
      modifiedBySessionId: null,
      modifiedByPromptId: null,
    });
  });

  it("serializes same-path concurrent attachments without cross-attributing their bytes", async () => {
    const aBytes = Buffer.from("attachment-a");
    const bBytes = Buffer.from("attachment-b");
    const checksum = (bytes: Buffer) =>
      `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    const prompt = (id: "a" | "b"): ProjectPromptJob => ({
      id: `attachment-${id}`,
      orgId: job.orgId,
      projectId: job.projectId,
      creatorId: job.creatorId,
      sessionId: `attachment-session-${id}`,
      sequence: 1,
      text: `Use attachment ${id}`,
      model: "openai/gpt-5",
      opencodeSessionId: null,
      opencodeMessageId: `msg_attachment_${id}`,
      sendAttemptedAt: null,
      leaseOwner: "worker",
    });
    const a = prompt("a");
    const b = prompt("b");
    let claimed = false;
    const versions: ProjectCachedFile[] = [];
    const store = baseStore({
      claimProjectPromptJobs: vi.fn(async () => {
        if (claimed) return [];
        claimed = true;
        return [a, b];
      }),
      loadProjectPromptAttachments: vi.fn(async ({ prompt: current }) => [{
        storageKey: current.id === a.id ? "attachment-a" : "attachment-b",
        workspacePath: "files/shared.txt",
        checksum: current.id === a.id ? checksum(aBytes) : checksum(bBytes),
      }]),
      persistProjectFiles: vi.fn(async ({ files }) => {
        versions.push(...files);
      }),
    });
    const sent = new Set<string>();
    const chat = quietChat();
    vi.mocked(chat.sendPrompt).mockImplementation(async (_target, sessionId) => {
      sent.add(sessionId);
    });
    vi.mocked(chat.getMessageState).mockImplementation(async (_target, sessionId) =>
      sent.has(sessionId) ? "completed" : "missing");
    const shared = new Map<string, Buffer>();
    const storage: ProjectFileStorage = {
      get: vi.fn(async (key) => key === "attachment-a" ? aBytes : bBytes),
      putContentAddressed: vi.fn(async ({ orgId, projectId, checksum: value }) =>
        projectFileCacheKey({ orgId, projectId, checksum: value })),
      delete: vi.fn(async () => undefined),
    };

    await runProjectWorkspaceJob({
      job,
      workerId: "worker",
      store,
      runtime: runtime(shared),
      chat,
      usage: usage(),
      storage,
      goldenSnapshotId: "golden",
      config,
      signal: new AbortController().signal,
    });

    expect(versions).toContainEqual(expect.objectContaining({
      path: "files/shared.txt",
      checksum: checksum(aBytes),
      modifiedBySessionId: a.sessionId,
      modifiedByPromptId: a.id,
    }));
    expect(versions).toContainEqual(expect.objectContaining({
      path: "files/shared.txt",
      checksum: checksum(bBytes),
      modifiedBySessionId: b.sessionId,
      modifiedByPromptId: b.id,
    }));
    const lastAttachmentVersion = versions.filter(
      (version) => version.path === "files/shared.txt" && version.modifiedBySessionId,
    ).at(-1)!;
    expect(checksum(shared.get("shared.txt")!)).toBe(lastAttachmentVersion.checksum);
  });

  it("honors a deletion requested while the workspace lease is already active", async () => {
    const projectRuntime = runtime();
    vi.mocked(projectRuntime.observe).mockResolvedValue({
      state: "stopped",
      startedAt: null,
      expiresAt: null,
      currentSnapshotId: "checkpoint-before-recreate",
    });
    const store = baseStore({
      readProjectWorkspaceControl: vi.fn(async () => ({
        deleteRequestedAt: new Date("2026-07-23T20:00:00.000Z"),
        status: "deleting" as const,
        skillSyncErrorAt: null,
        skillSyncErrorCode: null,
        skillSyncErrorMessage: null,
      })),
      listProjectStorageKeys: vi.fn(async () => ["project/object"]),
    });
    const storage: ProjectFileStorage = {
      ...emptyStorage,
      delete: vi.fn(async () => undefined),
    };

    await runProjectWorkspaceJob({
      job: { ...job, lastActivityAt: new Date() },
      workerId: "worker",
      store,
      runtime: projectRuntime,
      chat: quietChat(),
      usage: usage(),
      storage,
      goldenSnapshotId: "golden",
      config: { ...config, heartbeatMs: 2, idleMs: 50 },
      signal: new AbortController().signal,
    });

    expect(projectRuntime.destroy).toHaveBeenCalledOnce();
    expect(projectRuntime.checkpointAndStop).not.toHaveBeenCalled();
    expect(storage.delete).toHaveBeenCalledWith(
      "project/object",
      expect.any(AbortSignal),
    );
    expect(store.completeProjectDeletion).toHaveBeenCalledOnce();
  });

  it("stops one session without interrupting its peer and makes untouched uploads durable", async () => {
    const prompt = (id: string, sessionId: string, model: string): ProjectPromptJob => ({
      id,
      orgId: job.orgId,
      projectId: job.projectId,
      creatorId: job.creatorId,
      sessionId,
      sequence: 1,
      text: `Prompt ${id}`,
      model,
      opencodeSessionId: null,
      opencodeMessageId: `msg_${id}`,
      sendAttemptedAt: null,
      leaseOwner: "worker",
    });
    const a = prompt("a", "session-a", "openai/gpt-5");
    const b = prompt("b", "session-b", "google/gemini-2.5-pro");
    const sent = new Set<string>();
    const aborted: string[] = [];
    const completed: string[] = [];
    const stateTransitions: Array<{
      status: string;
      aborted: string[];
      completed: string[];
    }> = [];
    const persisted = new Map<string, { version: number; checksum: string }>();
    let promptsClaimed = false;
    let stopCompleted = false;
    const upload = Buffer.from("user attachment");
    const uploadChecksum = `sha256:${createHash("sha256").update(upload).digest("hex")}`;
    const store = baseStore({
      updateProjectWorkspaceState: vi.fn(async ({ status }) => {
        if (status) {
          stateTransitions.push({
            status,
            aborted: [...aborted],
            completed: [...completed],
          });
        }
        return true;
      }),
      claimProjectPromptJobs: vi.fn(async () => {
        if (promptsClaimed) return [];
        promptsClaimed = true;
        return [a, b];
      }),
      claimProjectSessionStops: vi.fn(async () =>
        sent.has("companion:session-a") && !stopCompleted
          ? [{
              orgId: job.orgId,
              projectId: job.projectId,
              creatorId: job.creatorId,
              sessionId: a.sessionId,
              opencodeSessionId: "companion:session-a",
            }]
          : []),
      completeProjectSessionStop: vi.fn(async () => {
        stopCompleted = true;
        return true;
      }),
      loadProjectPromptAttachments: vi.fn(async ({ prompt: claimed }) =>
        claimed.id === a.id
          ? [{
              storageKey: "attachment-a",
              workspacePath: "files/upload.txt",
              checksum: uploadChecksum,
            }]
          : []),
      markProjectPromptDispatch: vi.fn(async () => true),
      completeProjectPrompt: vi.fn(async ({ prompt: claimed }) => {
        completed.push(claimed.id);
        return true;
      }),
      persistProjectFiles: vi.fn(async ({ files }) => {
        for (const file of files) {
          persisted.set(file.path, {
            version: (persisted.get(file.path)?.version ?? 0) + 1,
            checksum: file.checksum,
          });
        }
      }),
      loadProjectFileBaseline: vi.fn(async () =>
        [...persisted].map(([path, value]) => ({ path, ...value }))),
    });
    const chat = quietChat();
    vi.mocked(chat.createSession).mockImplementation(async (_target, title) => ({
      id: title,
      title,
    }));
    vi.mocked(chat.sendPrompt).mockImplementation(async (_target, sessionId) => {
      sent.add(sessionId);
    });
    vi.mocked(chat.getMessageState).mockImplementation(async (_target, sessionId) => {
      if (!sent.has(sessionId)) return "missing";
      return sessionId === "companion:session-a" ? "pending" : "completed";
    });
    vi.mocked(chat.abortSession).mockImplementation(async (_target, sessionId) => {
      aborted.push(sessionId);
    });
    const storage: ProjectFileStorage = {
      get: vi.fn(async (key) => key === "attachment-a" ? upload : Buffer.alloc(0)),
      putContentAddressed: vi.fn(async ({ orgId, projectId, checksum }) =>
        projectFileCacheKey({ orgId, projectId, checksum })),
      delete: vi.fn(async () => undefined),
    };
    const projectRuntime = runtime();

    await runProjectWorkspaceJob({
      job,
      workerId: "worker",
      store,
      runtime: projectRuntime,
      chat,
      usage: usage(),
      storage,
      goldenSnapshotId: "golden",
      config: { ...config, idleMs: 60_000 },
      signal: new AbortController().signal,
    });

    expect(aborted).toEqual(["companion:session-a"]);
    expect(completed).toContain("b");
    expect(store.failProjectPrompt).not.toHaveBeenCalled();
    const runningIndex = stateTransitions.findIndex(({ status }) => status === "running");
    const readyAfterRunning = stateTransitions.findIndex(
      ({ status }, index) => index > runningIndex && status === "ready",
    );
    expect(runningIndex).toBeGreaterThanOrEqual(0);
    expect(readyAfterRunning).toBeGreaterThan(runningIndex);
    expect(stateTransitions[readyAfterRunning]).toMatchObject({
      aborted: ["companion:session-a"],
      completed: expect.arrayContaining(["b"]),
    });
    expect(persisted.get("files/upload.txt")?.checksum).toBe(uploadChecksum);
    expect(store.persistProjectFiles).toHaveBeenCalledWith(
      expect.objectContaining({
        files: expect.arrayContaining([
          expect.objectContaining({
            path: "files/upload.txt",
            contentType: "text/plain; charset=utf-8",
          }),
        ]),
      }),
    );
    expect(projectRuntime.checkpointAndStop).not.toHaveBeenCalled();
    expect(chat.sendPrompt).toHaveBeenCalledWith(
      expect.anything(),
      "companion:session-b",
      b.text,
      b.opencodeMessageId,
      b.model,
      expect.anything(),
    );
    expect(vi.mocked(store.markProjectActivationExposureAttempted).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(projectRuntime.startServer).mock.invocationCallOrder[0]!);
    expect(vi.mocked(projectRuntime.startServer).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(store.markProjectActivationInjected).mock.invocationCallOrder[0]!);
    expect(vi.mocked(store.markProjectActivationInjected).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(projectRuntime.healthCheck).mock.invocationCallOrder[0]!);
    expect(vi.mocked(projectRuntime.healthCheck).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(chat.sendPrompt).mock.invocationCallOrder[0]!);
  });

  it("owns Project orphan retention without relying on the Run supervisor", async () => {
    const sweep = vi.fn(async () => ({
      deleted: 0,
      retained: 0,
      failed: 0,
    }));
    const scheduler = createProjectAttachmentRetentionScheduler({
      intervalMs: 60_000,
      sweep,
    });
    await scheduler.run();
    expect(sweep).toHaveBeenCalledOnce();
    await scheduler.stop();
  });
});
