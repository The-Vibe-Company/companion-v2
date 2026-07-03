/**
 * Cred-gated smoke of the REAL Vercel runtime against the phase-1 success criteria. NOT run in CI.
 *
 *   VERCEL_TOKEN=… VERCEL_TEAM_ID=… VERCEL_PROJECT_ID=… \
 *   COMPANION_GOLDEN_SNAPSHOT_ID=… ANTHROPIC_API_KEY=… \
 *   pnpm --filter @companion/sandbox smoke:vercel
 *
 * Flow: fork golden → push a tiny probe skill → serve → health → prompt once through the chat
 * bridge (skills trigger + script execution) → stop (snapshot) → wake → measure resume latency
 * (<5–8s criterion) → destroy. Prints an honest report; exits non-zero on any failure.
 */
import { randomBytes } from "node:crypto";
import { createVercelRuntime, vercelConfigFromEnv } from "../src/vercel";
import { createChatClient, createChatSession, sendPromptAsync, streamChatEvents } from "../src/opencodeChat";
import type { SandboxRef } from "@companion/core";

const SKILL_MD = `---
name: smoke-probe
description: Answers smoke-test probes by running its bundled Python script.
---

# smoke-probe

When the user asks for a "smoke probe", run \`scripts/probe.py\` with bash and report its output verbatim.
`;

const PROBE_PY = `#!/usr/bin/env python3
print("PROBE-OK-4242")
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
    await runtime.pushSkills({
      ref,
      files: {
        agentSlug: "smoke-agent",
        agentMarkdown: `---\ndescription: "Smoke agent"\nmode: primary\nmodel: ${JSON.stringify(model)}\n---\n\nYou are a smoke-test agent. Use your skills.\n`,
        opencodeJson: `${JSON.stringify({ $schema: "https://opencode.ai/config.json", model, permission: { edit: "deny", bash: "allow" } }, null, 2)}\n`,
        skills: [
          {
            slug: "smoke-probe",
            version: "0.0.1",
            files: [
              { path: "SKILL.md", data: Buffer.from(SKILL_MD), executable: false },
              { path: "scripts/probe.py", data: Buffer.from(PROBE_PY), executable: true },
            ],
          },
        ],
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
    let text = "";
    // Hard deadline: abort the underlying SSE fetch so a silent stream can NEVER hang the smoke.
    const chatAbort = new AbortController();
    const chatDeadline = setTimeout(() => chatAbort.abort(), 180_000);
    const events = streamChatEvents({ client, sessionId: session.id, signal: chatAbort.signal });
    await sendPromptAsync(client, session.id, "Run a smoke probe and tell me the exact output.");
    try {
      for await (const event of events) {
        if (event.type === "tool.start") sawTool = true;
        if (event.type === "tool.done" && event.output.includes("PROBE-OK-4242")) sawProbeOutput = true;
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
    console.log(`  skill triggered=${report["skill_triggered"]} script ran=${report["script_ran"]}`);

    console.log("stop (snapshot)…");
    await runtime.stop(ref);
    await new Promise((resolve) => setTimeout(resolve, 5_000));

    console.log("wake…");
    const woke = await runtime.wake({ ref, env });
    await runtime.healthCheck({ ref, domain: woke.domain, password });
    report["resume_ms"] = String(woke.resumeMs);
    console.log(`  resumed in ${woke.resumeMs}ms (criterion: <5000–8000ms)`);
  } finally {
    console.log("destroy…");
    await runtime.destroy(ref);
  }

  console.log("\n=== smoke report ===");
  for (const [key, value] of Object.entries(report)) console.log(`${key.padEnd(18)} ${value}`);
  const pass =
    report["skill_triggered"] === "true" && report["script_ran"] === "true" && Number(report["resume_ms"]) < 8000;
  console.log(pass ? "\nPASS" : "\nFAIL (see criteria above)");
  process.exit(pass ? 0 : 1);
}

main().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  process.exit(1);
});
