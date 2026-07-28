/**
 * Credential-gated smoke of the real persistent Project runtime. This is not run in CI.
 *
 * Lifecycle-only mode (the default; does not exercise model dispatch):
 *
 *   VERCEL_TOKEN=… VERCEL_TEAM_ID=… VERCEL_PROJECT_ID=… \
 *   COMPANION_GOLDEN_SNAPSHOT_ID=… \
 *   pnpm --filter @companion/sandbox smoke:project-vercel
 *
 * Full prompt mode (requires two different models and an explicit allowlist of provider
 * credential environment variables to inject into the sandbox):
 *
 *   VERCEL_TOKEN=… VERCEL_TEAM_ID=… VERCEL_PROJECT_ID=… \
 *   COMPANION_GOLDEN_SNAPSHOT_ID=… \
 *   COMPANION_PROJECT_SMOKE_MODE=prompt \
 *   COMPANION_PROJECT_SMOKE_MODEL_A=anthropic/claude-sonnet-4-5 \
 *   COMPANION_PROJECT_SMOKE_MODEL_B=openai/gpt-5.2 \
 *   COMPANION_PROJECT_SMOKE_PROVIDER_ENV_KEYS=ANTHROPIC_API_KEY,OPENAI_API_KEY \
 *   ANTHROPIC_API_KEY=… OPENAI_API_KEY=… \
 *   pnpm --filter @companion/sandbox smoke:project-vercel
 *
 * Lifecycle mode proves the provider/runtime contract only up to the prompt boundary: one named
 * persistent sandbox, one OpenCode server, multiple native sessions, atomic Skills + managed Files
 * projections, checkpoint/stop, disappearance, and restoration from the last checkpoint.
 *
 * Prompt mode additionally dispatches two prompts concurrently with distinct explicit models over
 * one Project-wide event subscription. Each session writes its own file, waits for and reads the
 * other session's file, and reports the peer marker. The smoke then verifies event demultiplexing,
 * isolated native transcripts, the shared filesystem, and checkpoint restoration of both writes.
 */
import { randomBytes } from "node:crypto";
import { Sandbox } from "@vercel/sandbox";
import type { RunChatHistoryItem } from "@companion/contracts";
import {
  modelPartsForProject,
  OPENCODE_SERVER_USERNAME,
  type ProjectChatEventEnvelope,
  type ProjectWorkspaceRef,
} from "@companion/core";
import {
  createOpencodeProjectChatRuntime,
  createVercelProjectWorkspaceRuntime,
  vercelConfigFromEnv,
} from "../src/index";

const SKILL_MD = `---
name: project-smoke
description: A probe used to verify persistent Project skill synchronization.
---

# Project smoke

This package exists only for the credential-gated Project runtime smoke.
`;

type SmokeMode = "lifecycle" | "prompt";
const CONTROL_PLANE_ENV_KEYS = new Set([
  "DATABASE_URL",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
  "VERCEL_PROJECT_ID",
  "VERCEL_TEAM_ID",
  "VERCEL_TOKEN",
]);

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

function smokeMode(): SmokeMode {
  const raw = process.env.COMPANION_PROJECT_SMOKE_MODE?.trim().toLowerCase() || "lifecycle";
  if (raw !== "lifecycle" && raw !== "prompt") {
    throw new Error(
      "COMPANION_PROJECT_SMOKE_MODE must be either lifecycle or prompt",
    );
  }
  return raw;
}

function providerEnvironment(): Record<string, string> {
  const names = required("COMPANION_PROJECT_SMOKE_PROVIDER_ENV_KEYS")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  if (names.length === 0) {
    throw new Error(
      "COMPANION_PROJECT_SMOKE_PROVIDER_ENV_KEYS must name at least one credential variable",
    );
  }
  const unique = new Set(names);
  if (unique.size !== names.length) {
    throw new Error(
      "COMPANION_PROJECT_SMOKE_PROVIDER_ENV_KEYS contains a duplicate variable",
    );
  }
  const env: Record<string, string> = {};
  for (const name of names) {
    if (
      !/^[A-Z][A-Z0-9_]*$/.test(name)
      || name.startsWith("OPENCODE_SERVER_")
      || CONTROL_PLANE_ENV_KEYS.has(name)
    ) {
      throw new Error(`Unsafe provider credential environment variable ${name}`);
    }
    env[name] = required(name);
  }
  return env;
}

function messageId(): string {
  const createdAt = Date.now();
  const time = ((BigInt(createdAt) * 0x1000n + 1n) & ((1n << 48n) - 1n))
    .toString(16)
    .padStart(12, "0");
  return `msg_${time}${randomBytes(7).toString("hex")}`;
}

function sessionPrompt(input: {
  ownPath: string;
  ownMarker: string;
  peerPath: string;
  completionMarker: string;
}): string {
  return [
    "This is a concurrency smoke test. Use the bash tool to run this exact script:",
    "```sh",
    "mkdir -p concurrency",
    `printf '%s\\n' '${input.ownMarker}' > '${input.ownPath}'`,
    `for attempt in $(seq 1 120); do test -f '${input.peerPath}' && break; sleep 1; done`,
    `peer_value="$(cat '${input.peerPath}')"`,
    `printf 'PEER=%s\\n' "$peer_value"`,
    "```",
    `Then reply with ${input.completionMarker}, one space, and the exact value printed after PEER=.`,
    "Do not create or modify any other file.",
  ].join("\n");
}

function transcriptText(
  items: RunChatHistoryItem[],
  kind: "user" | "assistant",
): string {
  return items
    .filter((item): item is Extract<RunChatHistoryItem, { kind: typeof kind }> =>
      item.kind === kind
    )
    .map((item) => item.text)
    .join("\n");
}

async function runConcurrentPromptProbe(input: {
  chat: ReturnType<typeof createOpencodeProjectChatRuntime>;
  target: { domain: string; password: string };
  sessions: {
    first: { id: string; title: string };
    second: { id: string; title: string };
  };
  models: { first: string; second: string };
  markers: {
    first: string;
    second: string;
    firstComplete: string;
    secondComplete: string;
  };
}): Promise<{
  eventSessions: Set<string>;
  eventText: Map<string, string>;
  firstTranscript: string;
  secondTranscript: string;
  firstAssistant: string;
  secondAssistant: string;
}> {
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), 4 * 60_000);
  const eventSessions = new Set<string>();
  const eventText = new Map<string, string>();
  const idleSessions = new Set<string>();
  let connectedResolve: (() => void) | null = null;
  let didConnect = false;
  const connected = new Promise<void>((resolve) => {
    connectedResolve = resolve;
  });
  const stream = input.chat.streamEvents(
    input.target,
    abort.signal,
    () => {
      didConnect = true;
      connectedResolve?.();
    },
    {},
  );
  const collect = (async () => {
    try {
      for await (const envelope of stream) {
        eventSessions.add(envelope.sessionId);
        if (envelope.event.type === "text.delta") {
          eventText.set(
            envelope.sessionId,
            `${eventText.get(envelope.sessionId) ?? ""}${envelope.event.delta}`,
          );
        }
        if (isSessionIdle(envelope)) idleSessions.add(envelope.sessionId);
        if (
          idleSessions.has(input.sessions.first.id)
          && idleSessions.has(input.sessions.second.id)
        ) {
          return;
        }
      }
    } catch (error) {
      if (!abort.signal.aborted) throw error;
    }
  })();

  try {
    await Promise.race([
      connected,
      collect.then(() => {
        if (!didConnect) {
          throw new Error("Project event stream ended before it connected");
        }
      }),
      new Promise<never>((_, reject) => {
        const onAbort = () => reject(new Error("Project event stream did not connect before timeout"));
        abort.signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
    await Promise.all([
      input.chat.sendPrompt(
        input.target,
        input.sessions.first.id,
        sessionPrompt({
          ownPath: "concurrency/session-a.txt",
          ownMarker: input.markers.first,
          peerPath: "concurrency/session-b.txt",
          completionMarker: input.markers.firstComplete,
        }),
        messageId(),
        input.models.first,
        abort.signal,
      ),
      input.chat.sendPrompt(
        input.target,
        input.sessions.second.id,
        sessionPrompt({
          ownPath: "concurrency/session-b.txt",
          ownMarker: input.markers.second,
          peerPath: "concurrency/session-a.txt",
          completionMarker: input.markers.secondComplete,
        }),
        messageId(),
        input.models.second,
        abort.signal,
      ),
    ]);
    await collect;
    if (
      !idleSessions.has(input.sessions.first.id)
      || !idleSessions.has(input.sessions.second.id)
    ) {
      throw new Error("Concurrent Project prompts did not both become idle before timeout");
    }
    const [firstItems, secondItems] = await Promise.all([
      input.chat.loadItems(input.target, input.sessions.first.id, abort.signal),
      input.chat.loadItems(input.target, input.sessions.second.id, abort.signal),
    ]);
    return {
      eventSessions,
      eventText,
      firstTranscript: JSON.stringify(firstItems),
      secondTranscript: JSON.stringify(secondItems),
      firstAssistant: transcriptText(firstItems, "assistant"),
      secondAssistant: transcriptText(secondItems, "assistant"),
    };
  } finally {
    clearTimeout(timeout);
    abort.abort();
    await collect.catch(() => undefined);
  }
}

function isSessionIdle(envelope: ProjectChatEventEnvelope): boolean {
  return envelope.event.type === "session.idle"
    && envelope.event.session_id === envelope.sessionId;
}

async function main(): Promise<void> {
  const mode = smokeMode();
  const config = vercelConfigFromEnv();
  if (!config) {
    throw new Error("Set VERCEL_TOKEN, VERCEL_TEAM_ID, and VERCEL_PROJECT_ID");
  }
  const goldenSnapshotId = required("COMPANION_GOLDEN_SNAPSHOT_ID");
  const promptConfig = mode === "prompt"
    ? {
        models: {
          first: required("COMPANION_PROJECT_SMOKE_MODEL_A"),
          second: required("COMPANION_PROJECT_SMOKE_MODEL_B"),
        },
        providerEnv: providerEnvironment(),
      }
    : null;
  if (
    promptConfig &&
    promptConfig.models.first === promptConfig.models.second
  ) {
    throw new Error("Project prompt smoke requires two different explicit model references");
  }
  if (promptConfig) {
    modelPartsForProject(promptConfig.models.first);
    modelPartsForProject(promptConfig.models.second);
  }
  const runtime = createVercelProjectWorkspaceRuntime(config);
  const chat = createOpencodeProjectChatRuntime();
  const password = randomBytes(24).toString("base64url");
  const probeId = randomBytes(8).toString("hex");
  const markers = {
    first: `SESSION_A_FILE_${probeId}`,
    second: `SESSION_B_FILE_${probeId}`,
    firstComplete: `SESSION_A_READ_PEER_${probeId}`,
    secondComplete: `SESSION_B_READ_PEER_${probeId}`,
  };
  const ref: ProjectWorkspaceRef = {
    sandboxName: `cmp-project-smoke-${Date.now().toString(36)}`,
    sandboxId: null,
    region: process.env.COMPANION_SANDBOX_REGION?.trim() || "iad1",
    timeoutMs: 10 * 60_000,
  };
  const report = new Map<string, boolean>();
  let checkpointId: string | null = null;

  try {
    const activated = await runtime.activate({
      ref,
      sourceSnapshotId: goldenSnapshotId,
    });
    ref.sandboxId = activated.sandboxId;
    report.set("created_from_golden", activated.restoredFromSnapshot);

    await runtime.syncSkillBundles({
      ref,
      generation: 1,
      skills: [{
        slug: "project-smoke",
        version: "1.0.0",
        files: [{
          path: "SKILL.md",
          data: Buffer.from(SKILL_MD),
          executable: false,
        }],
      }],
    });
    await runtime.syncFiles({
      ref,
      files: [{
        path: "shared/note.txt",
        data: Buffer.from("persistent project file\n"),
      }],
    });

    await runtime.startServer({
      ref,
      env: {
        ...promptConfig?.providerEnv,
        OPENCODE_SERVER_USERNAME,
        OPENCODE_SERVER_PASSWORD: password,
      },
    });
    await runtime.healthCheck({
      ref,
      domain: activated.domain,
      password,
    });
    report.set("server_healthy", true);

    const target = { domain: activated.domain, password };
    const [first, second] = await Promise.all([
      chat.createSession(target, "project-smoke:first"),
      chat.createSession(target, "project-smoke:second"),
    ]);
    report.set("two_native_sessions", first.id !== second.id);
    report.set(
      "sessions_share_server",
      Boolean(
        await chat.findSessionByTitle(target, first.title)
        && await chat.findSessionByTitle(target, second.title),
      ),
    );

    if (promptConfig) {
      const probe = await runConcurrentPromptProbe({
        chat,
        target,
        sessions: { first, second },
        models: promptConfig.models,
        markers,
      });
      report.set(
        "events_demultiplexed",
        probe.eventSessions.has(first.id)
        && probe.eventSessions.has(second.id)
        && [...probe.eventSessions].every((sessionId) =>
          sessionId === first.id || sessionId === second.id
        )
        && (probe.eventText.get(first.id) ?? "").includes(markers.firstComplete)
        && (probe.eventText.get(first.id) ?? "").includes(markers.second)
        && !(probe.eventText.get(first.id) ?? "").includes(markers.secondComplete)
        && (probe.eventText.get(second.id) ?? "").includes(markers.secondComplete)
        && (probe.eventText.get(second.id) ?? "").includes(markers.first)
        && !(probe.eventText.get(second.id) ?? "").includes(markers.firstComplete),
      );
      report.set(
        "first_transcript_isolated",
        probe.firstTranscript.includes(markers.first)
        && probe.firstAssistant.includes(markers.firstComplete)
        && probe.firstAssistant.includes(markers.second)
        && !probe.firstTranscript.includes(markers.secondComplete),
      );
      report.set(
        "second_transcript_isolated",
        probe.secondTranscript.includes(markers.second)
        && probe.secondAssistant.includes(markers.secondComplete)
        && probe.secondAssistant.includes(markers.first)
        && !probe.secondTranscript.includes(markers.firstComplete),
      );
    }

    const beforeCheckpoint = await runtime.listFiles({
      ref,
      maxFiles: 10,
      maxFileBytes: 1_000_000,
      maxTotalBytes: 2_000_000,
    });
    report.set(
      "managed_file_visible",
      beforeCheckpoint.some((file) =>
        file.path === "shared/note.txt"
        && file.data.toString("utf8") === "persistent project file\n"
      ),
    );
    if (promptConfig) {
      report.set(
        "concurrent_shared_files",
        beforeCheckpoint.some((file) =>
          file.path === "concurrency/session-a.txt"
          && file.data.toString("utf8").trim() === markers.first
        )
        && beforeCheckpoint.some((file) =>
          file.path === "concurrency/session-b.txt"
          && file.data.toString("utf8").trim() === markers.second
        ),
      );
    }

    await runtime.scrubAgentState(ref);
    const checkpoint = await runtime.checkpointAndStop(ref);
    checkpointId = checkpoint.snapshotId;
    report.set("checkpoint_stopped", (await runtime.observe(ref)).state === "stopped");

    // Simulate provider-side loss without deleting the checkpoint. ProjectWorkspaceRuntime.destroy
    // intentionally removes both, so the smoke deletes only the named sandbox here.
    const providerSandbox = await Sandbox.get({
      token: config.token,
      teamId: config.teamId,
      projectId: config.projectId,
      name: ref.sandboxName,
      resume: false,
    });
    await providerSandbox.delete();
    report.set("sandbox_missing", (await runtime.observe(ref)).state === "missing");

    const restored = await runtime.activate({
      ref,
      sourceSnapshotId: checkpoint.snapshotId,
    });
    ref.sandboxId = restored.sandboxId;
    report.set("restored_from_checkpoint", restored.restoredFromSnapshot);
    const afterRestore = await runtime.listFiles({
      ref,
      maxFiles: 10,
      maxFileBytes: 1_000_000,
      maxTotalBytes: 2_000_000,
    });
    report.set(
      "file_survived_restore",
      afterRestore.some((file) =>
        file.path === "shared/note.txt"
        && file.data.toString("utf8") === "persistent project file\n"
      ),
    );
    if (promptConfig) {
      report.set(
        "concurrent_files_survived_restore",
        afterRestore.some((file) =>
          file.path === "concurrency/session-a.txt"
          && file.data.toString("utf8").trim() === markers.first
        )
        && afterRestore.some((file) =>
          file.path === "concurrency/session-b.txt"
          && file.data.toString("utf8").trim() === markers.second
        ),
      );
    }
  } finally {
    await runtime.destroy(ref).catch(() => undefined);
  }

  console.log(`Project Vercel ${mode} smoke`);
  for (const [name, passed] of report) {
    console.log(`${passed ? "PASS" : "FAIL"} ${name}`);
  }
  if (mode === "lifecycle") {
    console.log(
      "SKIP concurrent prompts, model dispatch, event demultiplexing, and transcript isolation",
    );
    console.log(
      "     rerun with COMPANION_PROJECT_SMOKE_MODE=prompt and the documented model credentials",
    );
  }
  const requiredChecks = [
    "created_from_golden",
    "server_healthy",
    "two_native_sessions",
    "sessions_share_server",
    "managed_file_visible",
    "checkpoint_stopped",
    "sandbox_missing",
    "restored_from_checkpoint",
    "file_survived_restore",
    ...(mode === "prompt"
      ? [
          "events_demultiplexed",
          "first_transcript_isolated",
          "second_transcript_isolated",
          "concurrent_shared_files",
          "concurrent_files_survived_restore",
        ]
      : []),
  ];
  const passed = requiredChecks.every((name) => report.get(name) === true);
  if (!passed) {
    throw new Error(
      `Project Vercel smoke failed${checkpointId ? ` after checkpoint ${checkpointId}` : ""}`,
    );
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  process.exit(1);
});
