import { describe, expect, it } from "vitest";
import type { ProjectPromptJob, ProjectWorkspaceJob } from "@companion/contracts";
import { schema, type Db } from "@companion/db";
import {
  appendCompletedProjectPromptArtifactsUpdated,
  buildProjectAuthorityInputs,
  classifyProjectAuthorityChange,
  isProjectSessionProviderAdmitted,
  LostProjectWorkspaceLeaseError,
  projectFileConflictState,
  projectPromptSendFenceDecision,
} from "../src/projectJobs";
import {
  assertValidProjectCreateIdempotencyKey,
  assertCompatibleProjectSkillClosure,
  deriveProjectSessionTitle,
  isProjectSessionUnread,
  projectFileChangeKind,
  ProjectValidationError,
  reopenedProjectSessionState,
  sandboxNameForProject,
} from "../src/projects";

const artifactJob: ProjectWorkspaceJob = {
  orgId: "00000000-0000-4000-8000-000000000001",
  projectId: "00000000-0000-4000-8000-000000000002",
  creatorId: "creator",
  status: "running",
  sandboxName: "project-artifact-test",
  sandboxId: "project-artifact-test",
  sandboxDomain: "https://project.invalid",
  checkpointId: null,
  checkpointGeneration: 0,
  desiredGeneration: 1,
  appliedGeneration: 1,
  desiredFileRevision: 0,
  appliedFileRevision: 0,
  lastActivityAt: new Date(),
  idleDeadlineAt: null,
  activationRevision: 1,
  authorityRevision: "authority-1",
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

const artifactPrompt: ProjectPromptJob = {
  id: "00000000-0000-4000-8000-000000000003",
  orgId: artifactJob.orgId,
  projectId: artifactJob.projectId,
  creatorId: artifactJob.creatorId,
  sessionId: "00000000-0000-4000-8000-000000000004",
  sequence: 1,
  text: "Create the deliverable",
  model: "openai/gpt-5",
  opencodeSessionId: "opencode-session",
  opencodeMessageId: "opencode-message",
  sendAttemptedAt: new Date(),
  leaseOwner: "worker",
};

function completedArtifactEventDb(input: {
  entered?: boolean;
  promptStatus?: "completed" | "running";
} = {}) {
  let transcriptSequence = 7;
  let fileReconciliationEventSequence: number | null = null;
  let transactionTail = Promise.resolve();
  const events: Array<{
    sequence: number;
    event: Record<string, unknown>;
  }> = [];
  const handle = {
    transaction: async (fn: (transaction: Db) => Promise<unknown>) => {
      const previous = transactionTail;
      let release!: () => void;
      transactionTail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        return await fn(handle as unknown as Db);
      } finally {
        release();
      }
    },
    execute: async () => [{ entered: input.entered ?? true }],
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({
          limit: () => ({
            for: async () => table === schema.projectPrompts
              ? [{
                  id: artifactPrompt.id,
                  status: input.promptStatus ?? "completed",
                  eventSequence: fileReconciliationEventSequence,
                }]
              : (() => {
                  throw new Error("unexpected artifact event select");
                })(),
          }),
        }),
      }),
    }),
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => ({
        where: () => ({
          returning: async () => {
            if (table === schema.projectSessions) {
              transcriptSequence += 1;
              return [{ sequence: transcriptSequence }];
            }
            if (table === schema.projectPrompts) {
              if (fileReconciliationEventSequence !== null) return [];
              fileReconciliationEventSequence =
                values.fileReconciliationEventSequence as number;
              return [{ id: artifactPrompt.id }];
            }
            throw new Error("unexpected artifact event update");
          },
        }),
      }),
    }),
    insert: (table: unknown) => ({
      values: async (value: Record<string, unknown>) => {
        if (table !== schema.projectSessionEvents) {
          throw new Error("unexpected artifact event insert");
        }
        events.push({
          sequence: value.sequence as number,
          event: value.event as Record<string, unknown>,
        });
      },
    }),
  };
  return {
    database: handle as unknown as Db,
    events,
    sequence: () => transcriptSequence,
    reconciliationSequence: () => fileReconciliationEventSequence,
  };
}

describe("Cowork project helpers", () => {
  it("accepts only bounded visible Project create idempotency keys", () => {
    expect(() =>
      assertValidProjectCreateIdempotencyKey("project.create:abc-123_4"),
    ).not.toThrow();

    for (const value of [
      "short",
      "project create",
      "project/create",
      "project\ncreate",
      `project-${"a".repeat(193)}`,
    ]) {
      expect(() => assertValidProjectCreateIdempotencyKey(value)).toThrow(
        expect.objectContaining({ code: "invalid_idempotency_key" }),
      );
    }
  });

  it("derives a compact title from the first non-empty prompt line", () => {
    expect(deriveProjectSessionTitle("\n  Prepare   the quarterly review \nwith charts")).toBe(
      "Prepare the quarterly review",
    );
  });

  it("keeps sandbox names deterministic and free of user-authored input", () => {
    expect(
      sandboxNameForProject("00000000-0000-4000-8000-000000000001"),
    ).toBe("project-00000000-0000-4000-8000-000000000001");
  });

  it("clears stale stop/error copy when an explicit prompt reopens a session", () => {
    expect(
      reopenedProjectSessionState({ isWorking: false, hasActivePrompt: false }),
    ).toEqual({
      status: "queued",
      stopRequestedAt: null,
      errorCode: null,
      userMessage: null,
    });
  });

  it("keeps terminal results unread until their transcript is actually viewed", () => {
    const lastViewedAt = new Date("2026-07-24T08:00:00.000Z");
    expect(
      isProjectSessionUnread({
        status: "completed",
        updatedAt: new Date("2026-07-24T08:01:00.000Z"),
        lastViewedAt,
      }),
    ).toBe(true);
    expect(
      isProjectSessionUnread({
        status: "working",
        updatedAt: new Date("2026-07-24T08:01:00.000Z"),
        lastViewedAt,
      }),
    ).toBe(false);
  });

  it("classifies file changes from the observed base rather than the persisted version", () => {
    expect(projectFileChangeKind({ baseVersion: 0, version: 1 })).toBe("created");
    expect(projectFileChangeKind({ baseVersion: 1, version: 2 })).toBe("updated");
    expect(
      // A concurrent creator can persist version 2 while still having observed no file.
      projectFileChangeKind({ baseVersion: 0, version: 2 }),
    ).toBe("created");
    expect(projectFileChangeKind({ baseVersion: null, version: 1 })).toBe("created");
    expect(projectFileChangeKind({ baseVersion: null, version: 2 })).toBe("updated");
  });

  it("keeps a detected file race sticky after the final neutral LWW mirror", () => {
    const firstWriter = projectFileConflictState({
      existingConflict: false,
      currentVersion: 0,
      observedBaseVersion: 0,
    });
    const racingWriter = projectFileConflictState({
      existingConflict: firstWriter,
      currentVersion: 1,
      observedBaseVersion: 0,
    });
    const neutralMirror = projectFileConflictState({
      existingConflict: racingWriter,
      currentVersion: 2,
      observedBaseVersion: 2,
    });
    expect([firstWriter, racingWriter, neutralMirror]).toEqual([false, true, true]);
  });

  it("allows compatible roots to share one dependency version", () => {
    expect(() =>
      assertCompatibleProjectSkillClosure([
        { skill_id: "root-a", skill_version_id: "root-a-v1" },
        { skill_id: "shared", skill_version_id: "shared-v2" },
        { skill_id: "root-b", skill_version_id: "root-b-v1" },
        { skill_id: "shared", skill_version_id: "shared-v2" },
      ]),
    ).not.toThrow();
  });

  it("rejects roots whose closures require incompatible dependency versions", () => {
    try {
      assertCompatibleProjectSkillClosure([
        { skill_id: "shared", skill_version_id: "shared-v1" },
        { skill_id: "shared", skill_version_id: "shared-v2" },
      ]);
      throw new Error("expected dependency conflict");
    } catch (error) {
      expect(error).toBeInstanceOf(ProjectValidationError);
      expect(error).toMatchObject({ code: "skill_dependency_version_conflict" });
    }
  });
});

describe("Project file reconciliation barrier", () => {
  it("linearizes concurrent retries into one artifacts.updated event", async () => {
    const state = completedArtifactEventDb();
    const [first, retried] = await Promise.all([
      appendCompletedProjectPromptArtifactsUpdated({
        job: artifactJob,
        prompt: artifactPrompt,
        workerId: "worker",
        count: 3,
        database: state.database,
      }),
      appendCompletedProjectPromptArtifactsUpdated({
        job: artifactJob,
        prompt: artifactPrompt,
        workerId: "worker",
        count: 3,
        database: state.database,
      }),
    ]);

    expect(first).toBe(8);
    expect(retried).toBe(8);
    expect(state.sequence()).toBe(8);
    expect(state.reconciliationSequence()).toBe(8);
    expect(state.events).toEqual([{
      sequence: 8,
      event: {
        type: "artifacts.updated",
        count: 3,
        prompt_id: artifactPrompt.id,
      },
    }]);
  });

  it("rejects the barrier unless both the workspace lease and terminal prompt are valid", async () => {
    const running = completedArtifactEventDb({ promptStatus: "running" });
    await expect(appendCompletedProjectPromptArtifactsUpdated({
      job: artifactJob,
      prompt: artifactPrompt,
      workerId: "worker",
      count: 0,
      database: running.database,
    })).rejects.toBeInstanceOf(LostProjectWorkspaceLeaseError);
    expect(running.events).toEqual([]);

    const lostLease = completedArtifactEventDb({ entered: false });
    await expect(appendCompletedProjectPromptArtifactsUpdated({
      job: artifactJob,
      prompt: artifactPrompt,
      workerId: "worker",
      count: 0,
      database: lostLease.database,
    })).rejects.toBeInstanceOf(LostProjectWorkspaceLeaseError);
    expect(lostLease.events).toEqual([]);
  });
});

describe("Project authority change classification", () => {
  const orgModel = {
    provider: "anthropic",
    envKey: "ANTHROPIC_API_KEY",
    connectionId: "00000000-0000-4000-8000-000000000010",
    credentialVersion: 1,
    connectionScope: "organization" as const,
  };
  const personalModel = {
    ...orgModel,
    connectionId: "00000000-0000-4000-8000-000000000011",
    connectionScope: "personal" as const,
  };
  const secret = {
    envKey: "CRM_TOKEN",
    secretId: "00000000-0000-4000-8000-000000000020",
    secretVersion: 1,
  };

  it("defers a personal provider override while the injected org source remains available", () => {
    expect(
      classifyProjectAuthorityChange({
        currentSecrets: [],
        pinnedSecrets: [],
        availablePinnedSecretSources: new Set(),
        currentModels: [personalModel],
        pinnedModels: [orgModel],
        availablePinnedModelSources: new Set([
          `${orgModel.connectionId}:${orgModel.credentialVersion}`,
        ]),
        environmentInvalid: false,
      }),
    ).toEqual({
      recycleRequired: true,
      mode: "boundary",
      reason: "model_connections_changed",
    });
  });

  it("recycles immediately only when an injected source is no longer available", () => {
    expect(
      classifyProjectAuthorityChange({
        currentSecrets: [],
        pinnedSecrets: [secret],
        availablePinnedSecretSources: new Set(),
        currentModels: [],
        pinnedModels: [orgModel],
        availablePinnedModelSources: new Set([
          `${orgModel.connectionId}:${orgModel.credentialVersion}`,
        ]),
        environmentInvalid: false,
      }),
    ).toMatchObject({ mode: "immediate", reason: "secrets_changed" });
  });

  it("defers rotations and invalid additions to the next quiescent boundary", () => {
    expect(
      classifyProjectAuthorityChange({
        currentSecrets: [{ ...secret, secretVersion: 2 }],
        pinnedSecrets: [secret],
        availablePinnedSecretSources: new Set([
          `${secret.secretId}:${secret.secretVersion}`,
        ]),
        currentModels: [orgModel],
        pinnedModels: [orgModel],
        availablePinnedModelSources: new Set([
          `${orgModel.connectionId}:${orgModel.credentialVersion}`,
        ]),
        environmentInvalid: true,
      }),
    ).toEqual({
      recycleRequired: true,
      mode: "boundary",
      reason: "environment_invalid",
    });
  });
});

describe("Project environment admission", () => {
  const creatorId = "creator-1";
  const secret = (index: number, key: string) => ({
    id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    key,
    currentVersion: 1,
  });
  const connection = (keyName: string) => ({
    id: "00000000-0000-4000-8000-999999999999",
    provider: "openai",
    keyName,
    currentVersion: 1,
    scope: "personal" as const,
    userId: creatorId,
  });

  it("blocks duplicate generic environment keys", () => {
    const result = buildProjectAuthorityInputs({
      creatorId,
      accessibleSecrets: [secret(1, "CRM_TOKEN"), secret(2, "CRM_TOKEN")],
      connections: [],
    });
    expect(result.environmentInvalid).toBe(true);
  });

  it("blocks every OPENCODE_SERVER namespace key even though control-plane keys are excluded", () => {
    const result = buildProjectAuthorityInputs({
      creatorId,
      accessibleSecrets: [secret(1, "opencode_server_password")],
      connections: [],
    });
    expect(result).toMatchObject({ environmentInvalid: true, secrets: [] });
  });

  it("blocks collisions between generic secrets and effective model credentials", () => {
    const result = buildProjectAuthorityInputs({
      creatorId,
      accessibleSecrets: [secret(1, "OPENAI_API_KEY")],
      connections: [connection("OPENAI_API_KEY")],
    });
    expect(result.environmentInvalid).toBe(true);
  });

  it("blocks more than 128 injectable generic secrets", () => {
    const result = buildProjectAuthorityInputs({
      creatorId,
      accessibleSecrets: Array.from({ length: 129 }, (_, index) =>
        secret(index + 1, `GENERIC_SECRET_${index + 1}`),
      ),
      connections: [],
    });
    expect(result.environmentInvalid).toBe(true);
    expect(result.secrets).toHaveLength(129);
  });

  it("silently excludes control-plane credentials without consuming the generic limit", () => {
    const result = buildProjectAuthorityInputs({
      creatorId,
      accessibleSecrets: [
        secret(1, "DATABASE_URL"),
        secret(2, "PAT_AUTOMATION"),
        secret(3, "OAUTH_CLIENT_SECRET"),
        secret(4, "VERCEL_TOKEN"),
        secret(5, "S3_SECRET_ACCESS_KEY"),
        ...Array.from({ length: 128 }, (_, index) =>
          secret(index + 10, `GENERIC_SECRET_${index + 1}`),
        ),
      ],
      connections: [],
    });
    expect(result.environmentInvalid).toBe(false);
    expect(result.secrets).toHaveLength(128);
    expect(result.secrets.map((pin) => pin.envKey)).not.toEqual(
      expect.arrayContaining([
        "DATABASE_URL",
        "PAT_AUTOMATION",
        "OAUTH_CLIENT_SECRET",
        "VERCEL_TOKEN",
        "S3_SECRET_ACCESS_KEY",
      ]),
    );
  });
});

describe("Project prompt provider admission", () => {
  it("requires the effective connection key to match the immutable catalog snapshot", () => {
    expect(
      isProjectSessionProviderAdmitted({
        modelProvider: "openai",
        modelCredentialEnvKeys: ["OPENAI_API_KEY"],
        effectiveProviderKeys: new Map([["openai", "OPENAI_API_KEY"]]),
      }),
    ).toBe(true);
    expect(
      isProjectSessionProviderAdmitted({
        modelProvider: "openai",
        modelCredentialEnvKeys: ["OPENAI_API_KEY"],
        effectiveProviderKeys: new Map([["openai", "OPENAI_COMPAT_TOKEN"]]),
      }),
    ).toBe(false);
  });

  it("admits a model only when the catalog explicitly snapshots it as credentialless", () => {
    expect(
      isProjectSessionProviderAdmitted({
        modelProvider: "local",
        modelCredentialEnvKeys: [],
        effectiveProviderKeys: new Map(),
      }),
    ).toBe(true);
    expect(
      isProjectSessionProviderAdmitted({
        modelProvider: "local",
        modelCredentialEnvKeys: ["LOCAL_API_KEY"],
        effectiveProviderKeys: new Map(),
      }),
    ).toBe(false);
  });

  it("blocks a provider disconnect observed at the final send fence", () => {
    expect(
      projectPromptSendFenceDecision({
        recycleRequired: false,
        modelProvider: "openai",
        modelCredentialEnvKeys: ["OPENAI_API_KEY"],
        effectiveProviderKeys: new Map(),
      }),
    ).toBe("provider_unavailable");
  });

  it("gives a pending recycle precedence over an otherwise valid provider", () => {
    expect(
      projectPromptSendFenceDecision({
        recycleRequired: true,
        modelProvider: "openai",
        modelCredentialEnvKeys: ["OPENAI_API_KEY"],
        effectiveProviderKeys: new Map([["openai", "OPENAI_API_KEY"]]),
      }),
    ).toBe("recycle");
  });
});
