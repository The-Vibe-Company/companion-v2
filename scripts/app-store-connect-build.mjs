#!/usr/bin/env node

import { createPrivateKey, sign } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const APP_STORE_CONNECT_API = "https://api.appstoreconnect.apple.com";
const TOKEN_AUDIENCE = "appstoreconnect-v1";
const TOKEN_LIFETIME_SECONDS = 10 * 60;
const BUILD_ATTEMPT_MULTIPLIER = 1_000n;
const MAX_BUILD_NUMBER_DIGITS = 18;
const RETRYABLE_PROCESSING_STATES = new Set(["FAILED", "INVALID"]);

function encodeBase64URL(value) {
  return Buffer.from(value).toString("base64url");
}

function requiredValue(value, name) {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function createBuildNumber(workflowRunID, workflowRunAttempt) {
  const runID = BigInt(requiredValue(workflowRunID, "workflow run ID"));
  const runAttempt = BigInt(requiredValue(workflowRunAttempt, "workflow run attempt"));
  if (runID <= 0n) throw new Error("workflow run ID must be positive");
  if (runAttempt <= 0n || runAttempt >= BUILD_ATTEMPT_MULTIPLIER) {
    throw new Error("workflow run attempt must be between 1 and 999");
  }
  const buildNumber = (runID * BUILD_ATTEMPT_MULTIPLIER + runAttempt).toString();
  if (buildNumber.length > MAX_BUILD_NUMBER_DIGITS) {
    throw new Error(`build number exceeds ${MAX_BUILD_NUMBER_DIGITS} digits`);
  }
  return buildNumber;
}

export function createAppStoreConnectToken(issuerID, keyID, privateKeyPEM, nowSeconds = Math.floor(Date.now() / 1000)) {
  const header = encodeBase64URL(JSON.stringify({ alg: "ES256", kid: keyID, typ: "JWT" }));
  const payload = encodeBase64URL(
    JSON.stringify({
      iss: issuerID,
      iat: nowSeconds,
      exp: nowSeconds + TOKEN_LIFETIME_SECONDS,
      aud: TOKEN_AUDIENCE,
    }),
  );
  const signingInput = `${header}.${payload}`;
  const signature = sign("sha256", Buffer.from(signingInput), {
    key: createPrivateKey(privateKeyPEM),
    dsaEncoding: "ieee-p1363",
  });
  return `${signingInput}.${encodeBase64URL(signature)}`;
}

export async function findAppStoreConnectBuild(appID, buildNumber, token, request = fetch) {
  const url = new URL("/v1/builds", APP_STORE_CONNECT_API);
  url.searchParams.set("filter[app]", appID);
  url.searchParams.set("filter[version]", buildNumber);
  url.searchParams.set("fields[builds]", "version,uploadedDate,processingState");
  url.searchParams.set("limit", "1");
  const response = await request(url, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
    },
  });
  if (!response.ok) throw new Error(`App Store Connect build lookup failed with HTTP ${response.status}`);
  const payload = await response.json();
  const build = payload.data?.[0];
  if (!build) return null;
  return {
    id: build.id,
    version: build.attributes?.version ?? buildNumber,
    uploadedDate: build.attributes?.uploadedDate ?? "",
    processingState: build.attributes?.processingState ?? "",
  };
}

export async function findReusableAppStoreConnectBuild(
  appID,
  workflowRunID,
  workflowRunAttempt,
  token,
  request = fetch,
) {
  const attempt = Number.parseInt(requiredValue(workflowRunAttempt, "workflow run attempt"), 10);
  createBuildNumber(workflowRunID, workflowRunAttempt);
  for (let candidateAttempt = 1; candidateAttempt <= attempt; candidateAttempt += 1) {
    const candidateNumber = createBuildNumber(workflowRunID, String(candidateAttempt));
    const build = await findAppStoreConnectBuild(appID, candidateNumber, token, request);
    if (!build) continue;
    const state = build.processingState.toUpperCase();
    if (RETRYABLE_PROCESSING_STATES.has(state)) {
      if (candidateAttempt === attempt) {
        throw new Error(`App Store Connect build ${candidateNumber} is ${state}; rerun this workflow to allocate a new build number`);
      }
      continue;
    }
    return build;
  }
  return null;
}

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) throw new Error(`unexpected argument: ${argument}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`);
    values.set(argument.slice(2), value);
    index += 1;
  }
  return values;
}

function writeOutput(outputPath, name, value) {
  if (outputPath) appendFileSync(outputPath, `${name}=${value}\n`);
}

async function main(argv = process.argv.slice(2), environment = process.env) {
  const [command, ...rest] = argv;
  const argumentsByName = parseArguments(rest);
  if (command === "number") {
    console.log(createBuildNumber(argumentsByName.get("run-id"), argumentsByName.get("run-attempt")));
    return;
  }
  if (command !== "exists") throw new Error("command must be number or exists");

  const appID = requiredValue(argumentsByName.get("app-id"), "--app-id");
  const workflowRunID = requiredValue(argumentsByName.get("run-id"), "--run-id");
  const workflowRunAttempt = requiredValue(argumentsByName.get("run-attempt"), "--run-attempt");
  const buildNumber = createBuildNumber(workflowRunID, workflowRunAttempt);
  const issuerID = requiredValue(environment.ASC_ISSUER_ID, "ASC_ISSUER_ID");
  const keyID = requiredValue(environment.ASC_KEY_ID, "ASC_KEY_ID");
  const keyPath = requiredValue(environment.ASC_KEY_PATH, "ASC_KEY_PATH");
  const token = createAppStoreConnectToken(issuerID, keyID, readFileSync(keyPath, "utf8"));
  const build = await findReusableAppStoreConnectBuild(appID, workflowRunID, workflowRunAttempt, token);
  const outputPath = argumentsByName.get("github-output");
  writeOutput(outputPath, "exists", build ? "true" : "false");
  if (build) {
    writeOutput(outputPath, "build-id", build.id);
    writeOutput(outputPath, "processing-state", build.processingState);
    console.log(`Build ${build.version} already exists in App Store Connect (${build.processingState || "state pending"}).`);
  } else {
    console.log(`Build ${buildNumber} is not present in App Store Connect.`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
