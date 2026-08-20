import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const RUNTIME_PREFIXES = [
  "packages/box-runtime/src/",
  "packages/companion-runtime/src/",
  "apps/runtime/src/",
];
const INTEGRATION_DOCS = new Set([
  "docs/design.md",
  "docs/companions-runtime.md",
  "docs/testing.md",
]);
const TEST_PATTERN = /(?:^|\/)(?:test|tests|__tests__)(?:\/|$)|\.(?:test|spec)\.[cm]?[jt]sx?$/;
const PROTECTED_PREFIX = "scripts/box-startup-research/";
const CREDENTIAL_SHAPE = /(?:box_[A-Za-z0-9_-]{24,}|(?:api[_-]?key|token|secret)\s*[:=]\s*["'][^"']{16,})/i;

export function assertNoCredentialMaterial(value, env = process.env) {
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  const secretValues = [env?.BOX_API_KEY, env?.COMPANION_BOX_API_KEY, env?.ZAI_API_KEY,
    env?.COMPANION_BOX_E2E_ZAI_API_KEY]
    .filter((secret) => typeof secret === "string" && secret.length > 0);
  if (secretValues.some((secret) => serialized.includes(secret)) || CREDENTIAL_SHAPE.test(serialized)) {
    throw new Error("structured research output contains credential material");
  }
}

async function defaultGit(args, cwd) {
  const { stdout } = await execFile("git", args, { cwd, maxBuffer: 32 * 1024 * 1024 });
  return stdout;
}

function candidatePathAllowed(path) {
  return RUNTIME_PREFIXES.some((prefix) => path.startsWith(prefix))
    && !TEST_PATTERN.test(path);
}

function integrationPathAllowed(path) {
  return RUNTIME_PREFIXES.some((prefix) => path.startsWith(prefix)) || INTEGRATION_DOCS.has(path);
}

export async function validateCandidateDiff(input) {
  const git = input.git ?? defaultGit;
  const count = Number((await git(["rev-list", "--count", `${input.baseSha}..${input.commitSha}`], input.cwd)).trim());
  const maximumCommits = input.integration ? 8 : 1;
  if (!Number.isSafeInteger(count) || count < 1 || count > maximumCommits) {
    throw new Error(input.integration
      ? "integration must contain between one and eight commits"
      : "candidate must contain exactly one commit");
  }

  const mergeBase = (await git(["merge-base", input.baseSha, input.commitSha], input.cwd)).trim();
  if (mergeBase !== input.baseSha) throw new Error("candidate is not based on the granted SHA");

  const statusOutput = await git([
    "diff", "--name-status", "--find-renames", input.baseSha, input.commitSha, "--",
  ], input.cwd);
  const changed = [];
  for (const line of statusOutput.split(/\r?\n/).filter(Boolean)) {
    const [status, ...paths] = line.split("\t");
    for (const path of paths) {
      if (!path) continue;
      if (status === "D" && TEST_PATTERN.test(path)) throw new Error("candidate deleted a protected test");
      if (path.startsWith(PROTECTED_PREFIX)) throw new Error("candidate modified the research evaluator");
      const allowed = input.integration ? integrationPathAllowed(path) : candidatePathAllowed(path);
      if (!allowed) throw new Error(`candidate changed protected path: ${path}`);
      changed.push(path);
    }
  }
  if (changed.length === 0) throw new Error("candidate did not change a runtime path");

  const patch = await git([
    "diff", "--no-ext-diff", "--unified=0", input.baseSha, input.commitSha, "--", ...changed,
  ], input.cwd);
  const additions = patch.split(/\r?\n/)
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .join("\n");
  try {
    assertNoCredentialMaterial(additions, input.env);
  } catch {
    throw new Error("candidate added a configured credential value");
  }

  return { changed: [...new Set(changed)].sort(), commitCount: count };
}

export function protectedResearchPaths() {
  return {
    evaluator: PROTECTED_PREFIX,
    runtimePrefixes: [...RUNTIME_PREFIXES],
    integrationDocs: [...INTEGRATION_DOCS],
  };
}
