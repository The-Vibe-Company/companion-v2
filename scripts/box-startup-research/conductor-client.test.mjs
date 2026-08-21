import assert from "node:assert/strict";
import test from "node:test";

import { ConductorCloudClient } from "./conductor-client.mjs";

const WORKSPACE = "11111111-1111-4111-a111-111111111111";
const PROJECT = "22222222-2222-4222-a222-222222222222";
const SESSION = "33333333-3333-4333-a333-333333333333";

test("creates a Luna workspace with explicit model, effort and environment", async () => {
  const calls = [];
  const client = new ConductorCloudClient({
    run: async (args) => {
      calls.push(args);
      if (args[0] === "project") return { data: [], offset: 0, hasMore: false };
      return {
        workspaceId: WORKSPACE,
        sessionId: SESSION,
        deepLink: "conductor://workspace",
      };
    },
  });
  const created = await client.createWorkspace({
    projectId: PROJECT,
    branch: "autoresearch/run/w1-c1",
    name: "candidate",
    sessionName: "explore",
    model: "gpt-5.6-luna",
    effort: "high",
    messageId: PROJECT,
    message: "prompt",
    environment: { BOX_STARTUP_RESEARCH_RUN_ID: "run" },
  });

  assert.equal(created.workspaceId, WORKSPACE);
  assert.equal(created.sessionId, SESSION);
  assert.deepEqual(calls[1].slice(0, 2), ["workspace", "create"]);
  assert.ok(calls[1].includes("gpt-5.6-luna"));
  assert.ok(calls[1].includes("BOX_STARTUP_RESEARCH_RUN_ID=run"));
  assert.equal(calls[1].includes("prompt"), false);
  assert.deepEqual(calls[2], [
    "message", "create", "--session", SESSION, "--message-id", PROJECT,
    "--message", "prompt",
  ]);
});

test("assigns an idempotent session id when the first message has an id", async () => {
  const calls = [];
  const client = new ConductorCloudClient({
    run: async (args) => {
      calls.push(args);
      return { id: SESSION, workspaceId: WORKSPACE, agent: "codex" };
    },
  });
  await client.createSession({
    workspaceId: WORKSPACE,
    model: "gpt-5.6-sol",
    effort: "low",
    name: "cleanup",
    messageId: PROJECT,
    message: "cleanup",
  });
  assert.ok(calls[0].includes("--session-id"));
  assert.ok(calls[0].includes("--message-id"));
});

test("uses idempotent message ids when granting work", async () => {
  const calls = [];
  const client = new ConductorCloudClient({ run: async (args) => { calls.push(args); return {}; } });
  await client.sendMessage({ sessionId: SESSION, messageId: WORKSPACE, message: "grant" });
  assert.deepEqual(calls[0], [
    "message", "create", "--session", SESSION, "--message-id", WORKSPACE, "--message", "grant",
  ]);
});

test("fails closed on incomplete Conductor JSON", async () => {
  const client = new ConductorCloudClient({
    run: async (args) => args[0] === "project"
      ? { data: [], offset: 0, hasMore: false }
      : { workspaceId: WORKSPACE },
  });
  await assert.rejects(client.createWorkspace({
    projectId: PROJECT,
    branch: "branch",
    name: "candidate",
    sessionName: "session",
    model: "gpt-5.6-luna",
    effort: "high",
    messageId: PROJECT,
    message: "prompt",
  }), /omitted/);
});

test("recovers an exact named workspace before creating another", async () => {
  const calls = [];
  const client = new ConductorCloudClient({
    run: async (args) => {
      calls.push(args);
      if (args[0] === "project") {
        return {
          data: [{ id: WORKSPACE, name: "candidate", deepLink: "conductor://workspace" }],
          offset: 0,
          hasMore: false,
        };
      }
      if (args[0] === "workspace") {
        return {
          data: [{ id: SESSION, name: "explore", deepLink: "conductor://session" }],
          offset: 0,
          hasMore: false,
        };
      }
      return {};
    },
  });
  const recovered = await client.createWorkspace({
    projectId: PROJECT,
    branch: "autoresearch/run/w1-c1",
    name: "candidate",
    sessionName: "explore",
    model: "gpt-5.6-luna",
    effort: "high",
    messageId: PROJECT,
    message: "prompt",
  });
  assert.equal(recovered.workspaceId, WORKSPACE);
  assert.equal(calls.some((args) => args[0] === "workspace" && args[1] === "create"), false);
  assert.equal(calls.some((args) => args[0] === "message"), true);
});

test("archives the exact workspace id", async () => {
  const calls = [];
  const client = new ConductorCloudClient({ run: async (args) => { calls.push(args); return {}; } });
  await client.archiveWorkspace(WORKSPACE);
  assert.deepEqual(calls, [["workspace", "archive", WORKSPACE]]);
});
