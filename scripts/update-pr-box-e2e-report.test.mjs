import assert from "node:assert/strict";
import test from "node:test";

import {
  REPORT_END,
  REPORT_START,
  parsePerformanceLog,
  renderPerformanceReport,
  replacePerformanceReport,
  updatePullRequestReport,
} from "./update-pr-box-e2e-report.mjs";

const SHA = "a".repeat(40);
const TOKEN = "github-token-that-must-not-be-logged";

function config(overrides = {}) {
  return {
    token: TOKEN,
    repository: "owner/repository",
    pullNumber: 42,
    testedSha: SHA,
    stepOutcome: "success",
    reportPath: "/tmp/runtime-e2e.log",
    runUrl: "https://github.com/owner/repository/actions/runs/123",
    apiUrl: "https://api.github.com",
    ...overrides,
  };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const successfulLog = [
  { phase: "create", status: "succeeded", duration_ms: 522 },
  { phase: "stage_runtime", status: "succeeded", duration_ms: 28_625 },
  { phase: "start_pi", status: "succeeded", duration_ms: 7_485 },
  { phase: "first_message", status: "succeeded", duration_ms: 20_473 },
  { phase: "cleanup", status: "succeeded", duration_ms: 982 },
  { phase: "runtime_change_e2e", status: "succeeded", total_duration_ms: 58_088 },
].map(JSON.stringify).join("\n");

test("renders safe phase timings and replaces the report at the end of the PR body", () => {
  const report = parsePerformanceLog(`pnpm output\n${successfulLog}`, "success");
  const block = renderPerformanceReport({
    testedSha: SHA,
    runUrl: config().runUrl,
    report,
  });
  const existing = `Intro\n\n${REPORT_START}\nold report\n${REPORT_END}\n\nDetails`;
  const body = replacePerformanceReport(existing, block);

  assert.match(body, /Création de la Box[^\n]*522 ms/);
  assert.match(body, /Premier message accepté et répondu[^\n]*20\.473 s/);
  assert.match(body, /Temps total : \*\*58\.088 s\*\*/);
  assert.equal(body.match(new RegExp(REPORT_START, "g"))?.length, 1);
  assert.equal(body.endsWith(`${REPORT_END}\n`), true);
  assert.match(body, /^Intro\n\nDetails\n\n/);
});

test("does not overwrite a newer commit report", async () => {
  const calls = [];
  const events = [];
  const result = await updatePullRequestReport(config(), {
    fetch: async (_input, init) => {
      calls.push(init.method);
      return jsonResponse({ head: { sha: "b".repeat(40) }, body: "Description" });
    },
    readFile: async () => successfulLog,
    logger: (event) => events.push(event),
  });

  assert.equal(result.status, "skipped_stale");
  assert.deepEqual(calls, ["GET"]);
  assert.deepEqual(events, [{ phase: "pr_report", status: "skipped_stale", commit: SHA.slice(0, 12) }]);
});

test("updates the current PR without exposing credentials or its existing body", async () => {
  const calls = [];
  const events = [];
  const privateBody = "Private release notes";
  const result = await updatePullRequestReport(config(), {
    fetch: async (_input, init) => {
      calls.push({
        method: init.method,
        authorization: new Headers(init.headers).get("authorization"),
        body: init.body ? JSON.parse(init.body) : null,
      });
      if (init.method === "GET") return jsonResponse({ head: { sha: SHA }, body: privateBody });
      return jsonResponse({ number: 42, head: { sha: SHA }, body: JSON.parse(init.body).body });
    },
    readFile: async () => successfulLog,
    logger: (event) => events.push(event),
  });

  assert.equal(result.status, "updated");
  assert.deepEqual(calls.map((call) => call.method), ["GET", "GET", "PATCH"]);
  assert.equal(calls[0].authorization, `Bearer ${TOKEN}`);
  assert.match(calls[2].body.body, /^Private release notes/);
  assert.equal(calls[2].body.body.endsWith(`${REPORT_END}\n`), true);
  const logged = JSON.stringify(events);
  assert.equal(logged.includes(TOKEN), false);
  assert.equal(logged.includes(privateBody), false);
});

test("publishes a stable failure when the performance log is unavailable", async () => {
  let patchedBody = "";
  const missing = Object.assign(new Error("missing"), { code: "ENOENT" });
  const result = await updatePullRequestReport(config({ stepOutcome: "failure" }), {
    fetch: async (_input, init) => {
      if (init.method === "GET") return jsonResponse({ head: { sha: SHA }, body: "" });
      patchedBody = JSON.parse(init.body).body;
      return jsonResponse({ number: 42, head: { sha: SHA }, body: patchedBody });
    },
    readFile: async () => { throw missing; },
    logger: () => undefined,
  });

  assert.equal(result.report.code, "workflow_failed");
  assert.match(patchedBody, /Aucune mesure de phase disponible/);
  assert.match(patchedBody, /Échec \(`workflow_failed`\)/);
});

test("re-reads a concurrent human edit before replacing the report", async () => {
  const methods = [];
  let getCount = 0;
  let finalBody = "";
  const result = await updatePullRequestReport(config(), {
    fetch: async (_input, init) => {
      methods.push(init.method);
      if (init.method === "GET") {
        getCount += 1;
        const body = getCount === 1 ? "Initial notes" : "Initial notes\n\nHuman edit";
        return jsonResponse({ head: { sha: SHA }, body });
      }
      finalBody = JSON.parse(init.body).body;
      return jsonResponse({ number: 42, head: { sha: SHA }, body: finalBody });
    },
    readFile: async () => successfulLog,
    logger: () => undefined,
  });

  assert.equal(result.status, "updated");
  assert.deepEqual(methods, ["GET", "GET", "GET", "GET", "PATCH"]);
  assert.match(finalBody, /^Initial notes\n\nHuman edit/);
  assert.equal(finalBody.endsWith(`${REPORT_END}\n`), true);
});
