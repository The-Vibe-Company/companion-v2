/**
 * Cred-gated smoke of the REAL Vercel runtime against the skill-run success criteria. NOT run in CI.
 *
 *   VERCEL_TOKEN=… VERCEL_TEAM_ID=… VERCEL_PROJECT_ID=… \
 *   COMPANION_GOLDEN_SNAPSHOT_ID=… ANTHROPIC_API_KEY=… \
 *   pnpm --filter @companion/sandbox smoke:vercel
 *
 * Flow: fork golden → push a tiny probe skill workspace → serve → health → prompt once through the
 * chat bridge (skill triggers + script execution + artifact write) → collect artifacts → stop →
 * destroy. Prints an honest report; exits non-zero on any failure.
 */
import { randomBytes } from "node:crypto";
import { createVercelRuntime, vercelConfigFromEnv } from "../src/vercel";
import { createChatClient, createChatSession, sendPromptAsync, streamChatEvents } from "../src/opencodeChat";
import type { SandboxRef } from "@companion/core";

const SKILL_MD = `---
name: smoke-probe
description: Answers smoke-test probes by delegating to its smoke-helper dependency.
---

# smoke-probe

When the user asks for a "smoke probe", use the installed \`smoke-helper\` skill. Run its
\`scripts/probe.py\` with bash, report its non-sensitive output verbatim, and write that output into
\`./artifacts/probe.txt\`. Never print environment variable values.
`;

const HELPER_SKILL_MD = `---
name: smoke-helper
description: Dependency used by smoke-probe to verify dependency closure mounts and secret injection.
---

# smoke-helper

Run \`scripts/probe.py\` for the smoke-probe skill. Never print environment variable values.
`;

const PROBE_PY = `#!/usr/bin/env python3
import os
print("PROBE-OK-4242")
print("SECRET-AVAILABLE" if os.environ.get("SMOKE_SECRET_SENTINEL") else "SECRET-MISSING")
`;

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`Missing required env var ${name}`);
    process.exit(1);
  }
  return value;
}

async function main(): Promise<void> {
  const config = vercelConfigFromEnv();
  if (!config) {
    console.error("Set VERCEL_TOKEN, VERCEL_TEAM_ID, VERCEL_PROJECT_ID.");
    process.exit(1);
  }
  const goldenSnapshotId = required("COMPANION_GOLDEN_SNAPSHOT_ID");
  const anthropicKey = required("ANTHROPIC_API_KEY");
  const model = process.env.SMOKE_MODEL ?? "anthropic/claude-sonnet-4-5";

  const runtime = createVercelRuntime(config);
  const password = randomBytes(24).toString("base64url");
  const secretSentinel = `smoke-secret-${randomBytes(18).toString("hex")}`;
  const ref: SandboxRef = {
    sandboxName: `cmp-smoke-${Date.now().toString(36)}`,
    sandboxId: null,
    region: "iad1",
    timeoutMs: 300000,
  };
  const env = {
    OPENCODE_SERVER_PASSWORD: password,
    OPENCODE_SERVER_USERNAME: "companion",
    ANTHROPIC_API_KEY: anthropicKey,
    SMOKE_SECRET_SENTINEL: secretSentinel,
  };
  const report: Record<string, string> = {};

  try {
    console.log(`fork ${ref.sandboxName} from ${goldenSnapshotId}…`);
    let t = Date.now();
    const forked = await runtime.forkFromGolden({ ref, goldenSnapshotId });
    ref.sandboxId = forked.sandboxId;
    report["fork_ms"] = String(Date.now() - t);
    console.log(`  domain ${forked.domain} (${report["fork_ms"]}ms)`);

    t = Date.now();
    await runtime.pushWorkspace({
      ref,
      files: {
        opencodeJson: `${JSON.stringify({ $schema: "https://opencode.ai/config.json", model, permission: { edit: "allow", bash: "allow" } }, null, 2)}\n`,
        skills: [
          {
            slug: "smoke-probe",
            version: "0.0.1",
            files: [{ path: "SKILL.md", data: Buffer.from(SKILL_MD), executable: false }],
          },
          {
            slug: "smoke-helper",
            version: "0.0.1",
            files: [
              { path: "SKILL.md", data: Buffer.from(HELPER_SKILL_MD), executable: false },
              { path: "scripts/probe.py", data: Buffer.from(PROBE_PY), executable: true },
            ],
          },
        ],
        attachments: [{ path: "note.txt", data: Buffer.from("smoke attachment\n") }],
      },
    });
    report["push_ms"] = String(Date.now() - t);

    t = Date.now();
    await runtime.startServer({ ref, env });
    const health = await runtime.healthCheck({ ref, domain: forked.domain, password });
    report["serve_health_ms"] = String(Date.now() - t);
    console.log(`  healthy in ${health.ms}ms`);

    // One prompt through the chat bridge: does the skill trigger and its Python script run?
    const client = createChatClient({ domain: forked.domain, password });
    const session = await createChatSession(client, "smoke");
    let sawTool = false;
    let sawProbeOutput = false;
    let sawSecretAvailable = false;
    let leakedSecret = false;
    let text = "";
    // Hard deadline: abort the underlying SSE fetch so a silent stream can NEVER hang the smoke.
    const chatAbort = new AbortController();
    const chatDeadline = setTimeout(() => chatAbort.abort(), 180_000);
    const events = streamChatEvents({ client, sessionId: session.id, signal: chatAbort.signal });
    await sendPromptAsync(client, session.id, "Run a smoke probe and tell me the exact output.", {
      signal: chatAbort.signal,
    });
    try {
      for await (const event of events) {
        if (event.type === "tool.start") sawTool = true;
        if (event.type === "tool.done" && event.output.includes("PROBE-OK-4242")) sawProbeOutput = true;
        if (event.type === "tool.done" && event.output.includes("SECRET-AVAILABLE")) sawSecretAvailable = true;
        if (JSON.stringify(event).includes(secretSentinel)) leakedSecret = true;
        if (event.type === "text.delta") text += event.delta;
        if (event.type === "session.idle") break;
      }
    } catch (error) {
      if (!chatAbort.signal.aborted) throw error;
      console.log("  chat window elapsed without session.idle (aborted)");
    } finally {
      clearTimeout(chatDeadline);
      chatAbort.abort();
    }
    report["skill_triggered"] = String(sawTool);
    report["script_ran"] = String(sawProbeOutput || text.includes("PROBE-OK-4242"));
    report["dependency_ran"] = String(sawSecretAvailable || text.includes("SECRET-AVAILABLE"));
    report["secret_not_leaked"] = String(!leakedSecret && !text.includes(secretSentinel));
    console.log(`  skill triggered=${report["skill_triggered"]} script ran=${report["script_ran"]}`);

    console.log("collect artifacts…");
    t = Date.now();
    const artifacts = await runtime.collectFiles({
      ref,
      dir: "/vercel/sandbox/artifacts",
      maxFiles: 20,
      maxFileBytes: 10 * 1024 * 1024,
    });
    report["collect_ms"] = String(Date.now() - t);
    report["artifacts"] = artifacts.map((a) => `${a.path} (${a.byteSize}B)`).join(", ") || "(none)";
    report["artifact_ok"] = String(artifacts.some((a) => a.data.toString("utf8").includes("PROBE-OK-4242")));
    report["artifact_secret_safe"] = String(artifacts.every((a) => !a.data.toString("utf8").includes(secretSentinel)));

    console.log("stop (freeze)…");
    await runtime.stop(ref);
  } finally {
    console.log("destroy…");
    await runtime.destroy(ref);
  }

  console.log("\n=== smoke report ===");
  for (const [key, value] of Object.entries(report)) console.log(`${key.padEnd(18)} ${value}`);
  const pass =
    report["skill_triggered"] === "true" &&
    report["script_ran"] === "true" &&
    report["dependency_ran"] === "true" &&
    report["secret_not_leaked"] === "true" &&
    report["artifact_ok"] === "true" &&
    report["artifact_secret_safe"] === "true";
  console.log(pass ? "\nPASS" : "\nFAIL (see criteria above)");
  process.exit(pass ? 0 : 1);
}

main().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  process.exit(1);
});
