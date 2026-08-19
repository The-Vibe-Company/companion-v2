import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function config(name) {
  return JSON.parse(readFileSync(join(root, "deploy", "railway", `${name}.railway.json`), "utf8"));
}

test("the public API never runs owner migrations in its service lifecycle", () => {
  const api = config("api");
  const apiPackage = JSON.parse(readFileSync(join(root, "apps", "api", "package.json"), "utf8"));
  assert.equal(apiPackage.scripts.start, "node dist/index.js");
  assert.equal(apiPackage.scripts.migrate, "node dist/migrate.js");
  assert.equal(api.deploy.startCommand, "node dist/index.js");
  assert.equal(Object.hasOwn(api.deploy, "preDeployCommand"), false);
});

test("the Railway release unit is a one-shot migration job", () => {
  const release = config("release");
  assert.equal(release.build.dockerfilePath, "deploy/railway/Dockerfile.backend");
  assert.ok(release.build.watchPatterns.includes("/deploy/railway/release.railway.json"));
  assert.equal(release.deploy.startCommand, "node dist/migrate.js");
  assert.equal(release.deploy.restartPolicyType, "NEVER");
  assert.equal(Object.hasOwn(release.deploy, "preDeployCommand"), false);
  assert.equal(Object.hasOwn(release.deploy, "healthcheckPath"), false);
  assert.equal(Object.hasOwn(release.deploy, "cronSchedule"), false);
});

test("the shared backend image maps the release service to the API migration package", () => {
  const dockerfile = readFileSync(join(root, "deploy", "railway", "Dockerfile.backend"), "utf8");
  assert.match(dockerfile, /release\) package="api"/);
  assert.match(dockerfile, /turbo prune "@companion\/\$\{package\}" --docker/);
  assert.match(dockerfile, /pnpm --filter "@companion\/\$\{package\}" build/);
});

test("the web image inlines public PostHog and Sentry values at build time", () => {
  const dockerfile = readFileSync(join(root, "deploy", "railway", "Dockerfile.web"), "utf8");
  assert.match(dockerfile, /ARG NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN/);
  assert.match(dockerfile, /ENV NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN=\$\{NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN\}/);
  assert.match(dockerfile, /ARG NEXT_PUBLIC_SENTRY_DSN/);
  assert.match(dockerfile, /ARG NEXT_PUBLIC_SENTRY_ENVIRONMENT/);
  assert.match(dockerfile, /ENV NEXT_PUBLIC_SENTRY_DSN=\$\{NEXT_PUBLIC_SENTRY_DSN\}/);
  assert.match(dockerfile, /ENV NEXT_PUBLIC_SENTRY_ENVIRONMENT=\$\{NEXT_PUBLIC_SENTRY_ENVIRONMENT\}/);
});
