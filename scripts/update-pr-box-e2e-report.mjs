#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export const REPORT_START = "<!-- companion-box-e2e:start -->";
export const REPORT_END = "<!-- companion-box-e2e:end -->";

const SHA_PATTERN = /^[a-f0-9]{40}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SAFE_CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const PHASES = [
  "create", "provider_start", "stage_current_change", "start_pi", "prompt_ack",
  "ready_to_prompt_ack", "first_message", "stop_archive", "resume",
  "resume_provider_start", "resume_prompt_ack", "resume_ready_to_prompt_ack", "resume_message",
  "cleanup",
];
const PHASE_LABELS = new Map([
  ["create", "Création de la Box"],
  ["stage_current_change", "Installation du checkout courant"],
  ["provider_start", "Démarrage provider → Box prête"],
  ["start_pi", "Démarrage de Pi"],
  ["prompt_ack", "Prompt accepté par Pi"],
  ["ready_to_prompt_ack", "Box prête → prompt accepté"],
  ["first_message", "Premier message accepté et répondu"],
  ["stop_archive", "Arrêt de Pi et archivage"],
  ["resume", "Reprise et réactivation"],
  ["resume_provider_start", "Reprise provider → Box prête"],
  ["resume_prompt_ack", "Prompt de reprise accepté par Pi"],
  ["resume_ready_to_prompt_ack", "Box reprise prête → prompt accepté"],
  ["resume_message", "Message après reprise accepté et répondu"],
  ["cleanup", "Suppression de la Box"],
]);

class PullRequestReportError extends Error {
  constructor(code) {
    super(code);
    this.name = "PullRequestReportError";
    this.code = SAFE_CODE_PATTERN.test(code) ? code : "pr_report_failed";
  }
}

function required(env, name) {
  const value = env[name]?.trim();
  if (!value) throw new PullRequestReportError("missing_configuration");
  return value;
}

function safeHttpsUrl(raw) {
  let value;
  try {
    value = new URL(raw);
  } catch {
    throw new PullRequestReportError("invalid_configuration");
  }
  if (value.protocol !== "https:" || value.username || value.password) {
    throw new PullRequestReportError("invalid_configuration");
  }
  return value.toString().replace(/\/+$/, "");
}

export function loadPullRequestReportConfig(env = process.env) {
  const repository = required(env, "GITHUB_REPOSITORY");
  const pullNumber = Number(required(env, "COMPANION_E2E_PR_NUMBER"));
  const testedSha = required(env, "COMPANION_E2E_TESTED_SHA").toLowerCase();
  const stepOutcome = env.COMPANION_E2E_STEP_OUTCOME?.trim() || "unknown";
  if (
    !REPOSITORY_PATTERN.test(repository)
    || !Number.isSafeInteger(pullNumber)
    || pullNumber <= 0
    || !SHA_PATTERN.test(testedSha)
    || !["success", "failure", "cancelled", "skipped", "unknown"].includes(stepOutcome)
  ) {
    throw new PullRequestReportError("invalid_configuration");
  }
  return {
    token: required(env, "GITHUB_TOKEN"),
    repository,
    pullNumber,
    testedSha,
    stepOutcome,
    reportPath: required(env, "COMPANION_E2E_REPORT_PATH"),
    runUrl: safeHttpsUrl(required(env, "COMPANION_E2E_RUN_URL")),
    apiUrl: safeHttpsUrl(env.GITHUB_API_URL?.trim() || "https://api.github.com"),
  };
}

function parseJsonLine(line) {
  try {
    const value = JSON.parse(line);
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function safeDuration(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 24 * 60 * 60 * 1_000
    ? value
    : null;
}

export function parsePerformanceLog(contents, stepOutcome = "unknown") {
  const events = String(contents).split(/\r?\n/).map(parseJsonLine).filter(Boolean);
  const phaseEvents = new Map();
  for (const event of events) {
    if (
      PHASES.includes(event.phase)
      && ["succeeded", "failed"].includes(event.status)
      && safeDuration(event.duration_ms) !== null
    ) {
      phaseEvents.set(event.phase, {
        status: event.status,
        durationMs: event.duration_ms,
      });
    }
  }

  const final = events.findLast((event) =>
    event.phase === "runtime_change_e2e" && ["succeeded", "failed"].includes(event.status));
  const configuration = events.findLast((event) => event.phase === "configuration");
  const finalCode = final?.code ?? configuration?.code;
  const code = typeof finalCode === "string" && SAFE_CODE_PATTERN.test(finalCode)
    ? finalCode
    : stepOutcome === "cancelled" ? "workflow_cancelled" : "workflow_failed";
  const passed = stepOutcome === "success" && final?.status === "succeeded";

  return {
    status: passed ? "succeeded" : "failed",
    code: passed ? null : code,
    phases: PHASES.flatMap((phase) => {
      const event = phaseEvents.get(phase);
      return event ? [{ phase, ...event }] : [];
    }),
    totalDurationMs: safeDuration(final?.total_duration_ms),
  };
}

function formatDuration(milliseconds) {
  if (milliseconds < 1_000) return `${milliseconds} ms`;
  return `${(milliseconds / 1_000).toFixed(3)} s`;
}

export function renderPerformanceReport({ testedSha, runUrl, report }) {
  const succeeded = report.status === "succeeded";
  const status = succeeded ? "✅ Réussi" : `❌ Échec (\`${report.code}\`)`;
  const rows = report.phases.length === 0
    ? "_Aucune mesure de phase disponible._"
    : [
        "| Phase | Résultat | Durée |",
        "| --- | --- | ---: |",
        ...report.phases.map(({ phase, status: phaseStatus, durationMs }) =>
          `| ${PHASE_LABELS.get(phase)} | ${phaseStatus === "succeeded" ? "✅" : "❌"} | ${formatDuration(durationMs)} |`),
      ].join("\n");
  const total = report.totalDurationMs === null
    ? "Non disponible"
    : formatDuration(report.totalDurationMs);

  return [
    REPORT_START,
    "## Performance Box/Pi E2E",
    "",
    `Commit testé : \`${testedSha.slice(0, 12)}\` · Résultat : ${status}`,
    "",
    rows,
    "",
    `Temps total : **${total}** · [Voir l’exécution GitHub Actions](${runUrl})`,
    REPORT_END,
  ].join("\n");
}

export function replacePerformanceReport(body, block) {
  const pattern = /(?:\r?\n)*<!-- companion-box-e2e:start -->[\s\S]*?<!-- companion-box-e2e:end -->(?:\r?\n)*/g;
  const source = String(body ?? "");
  const preserved = source.replace(pattern, (match, offset) => {
    const hasContentBefore = source.slice(0, offset).trim().length > 0;
    const hasContentAfter = source.slice(offset + match.length).trim().length > 0;
    return hasContentBefore && hasContentAfter ? "\n\n" : "";
  }).trimEnd();
  return preserved.length === 0 ? `${block}\n` : `${preserved}\n\n${block}\n`;
}

async function githubRequest(config, fetchImpl, method, body) {
  let response;
  try {
    response = await fetchImpl(
      `${config.apiUrl}/repos/${config.repository}/pulls/${config.pullNumber}`,
      {
        method,
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${config.token}`,
          "x-github-api-version": "2022-11-28",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
    );
  } catch {
    throw new PullRequestReportError("github_network_error");
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new PullRequestReportError(`github_http_${response.status}`);
  }
  try {
    return await response.json();
  } catch {
    throw new PullRequestReportError("invalid_github_response");
  }
}

export async function updatePullRequestReport(config, dependencies = {}) {
  const fetchImpl = dependencies.fetch ?? globalThis.fetch;
  const read = dependencies.readFile ?? readFile;
  const logger = dependencies.logger ?? ((event) => process.stdout.write(`${JSON.stringify(event)}\n`));
  let contents = "";
  try {
    contents = await read(config.reportPath, "utf8");
  } catch (error) {
    if (!error || typeof error !== "object" || error.code !== "ENOENT") throw error;
  }
  const report = parsePerformanceLog(contents, config.stepOutcome);
  const block = renderPerformanceReport({
    testedSha: config.testedSha,
    runUrl: config.runUrl,
    report,
  });
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const pull = await githubRequest(config, fetchImpl, "GET");
    if (!SHA_PATTERN.test(pull?.head?.sha ?? "")) {
      throw new PullRequestReportError("invalid_github_response");
    }
    if (pull.head.sha.toLowerCase() !== config.testedSha) {
      logger({ phase: "pr_report", status: "skipped_stale", commit: config.testedSha.slice(0, 12) });
      return { status: "skipped_stale" };
    }

    const nextBody = replacePerformanceReport(pull.body, block);
    const confirmed = await githubRequest(config, fetchImpl, "GET");
    if (!SHA_PATTERN.test(confirmed?.head?.sha ?? "")) {
      throw new PullRequestReportError("invalid_github_response");
    }
    if (confirmed.head.sha.toLowerCase() !== config.testedSha) {
      logger({ phase: "pr_report", status: "skipped_stale", commit: config.testedSha.slice(0, 12) });
      return { status: "skipped_stale" };
    }
    if (confirmed.body !== pull.body) {
      if (attempt < 3) continue;
      throw new PullRequestReportError("concurrent_pr_update");
    }

    const updated = await githubRequest(config, fetchImpl, "PATCH", { body: nextBody });
    if (updated?.body !== nextBody || updated?.head?.sha?.toLowerCase() !== config.testedSha) {
      throw new PullRequestReportError("concurrent_pr_update");
    }
    logger({
      phase: "pr_report",
      status: "updated",
      commit: config.testedSha.slice(0, 12),
      result: report.status,
    });
    return { status: "updated", report };
  }
  throw new PullRequestReportError("concurrent_pr_update");
}

async function main() {
  try {
    await updatePullRequestReport(loadPullRequestReportConfig());
  } catch (error) {
    const code = error instanceof PullRequestReportError ? error.code : "pr_report_failed";
    process.stdout.write(`${JSON.stringify({ phase: "pr_report", status: "failed", code })}\n`);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
