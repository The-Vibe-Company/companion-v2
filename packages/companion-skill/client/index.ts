#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, closeSync, fstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawn } from "node:child_process";

import {
  AgentAuthClient,
  type ApprovalInfo,
  type CapabilityConstraints,
} from "@auth/agent";

import { approvalBrowserCommand } from "./approval.js";
import {
  loadCredentialsV3,
  PrivateFileStorage,
  saveAgentCredentialReference,
  type WorkspaceCredentialV3,
} from "./storage.js";
import { selectWorkspaceAuthentication, type WorkspaceAuthentication } from "./auth-mode.js";
import {
  installPublicSkillZip,
  type PublicInstallScope,
  type PublicInstallTool,
} from "./safe-install.js";
import {
  resolveOperation,
  resolveTicketedDownloadTarget,
  type CompanionCapability,
  type CompanionHttpMethod,
} from "./operations.js";

type JsonObject = Record<string, unknown>;

type ClientInput =
  | {
      action: "connect";
      apiUrl: string;
      workspaceId: string;
      name?: string;
    }
  | {
      action: "api";
      workspaceId?: string;
      method: CompanionHttpMethod;
      path: string;
      body?: unknown;
    }
  | {
      action: "upload";
      workspaceId?: string;
      method: "POST" | "PUT";
      path: string;
      inputPath: string;
      contentType?: string;
    }
  | {
      action: "download";
      workspaceId?: string;
      path: string;
      outputPath: string;
      checksum?: string;
      sizeBytes?: number;
    }
  | {
      action: "public-install";
      workspaceId?: string;
      token: string;
      version: string;
      checksum: string;
      sizeBytes: number;
      tool: PublicInstallTool;
      scope: PublicInstallScope;
      projectRoot?: string;
      confirmInstall: boolean;
      confirmReplace?: boolean;
    }
  | {
      action: "secret-redeem";
      workspaceId?: string;
      planId: string;
      /** Inherited anonymous pipe descriptor. stdout/stderr and regular files are refused. */
      outputFd: number;
    }
  | {
      action: "status";
      workspaceId?: string;
    };

interface WorkspaceContext {
  workspaceId: string;
  workspace: WorkspaceCredentialV3;
  authentication: WorkspaceAuthentication;
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readInput(): ClientInput {
  const raw = readFileSync(0, "utf8");
  const value = JSON.parse(raw) as unknown;
  if (!isRecord(value) || typeof value.action !== "string") {
    throw new Error("expected one JSON request on stdin");
  }
  return value as ClientInput;
}

function redact(value: string): string {
  return value
    .replace(/cmp_(?:pat|grant|xfer)_[A-Za-z0-9._-]+/g, "cmp_[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, "Bearer [redacted]");
}

function writeResult(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function writeStatus(value: unknown): void {
  process.stderr.write(`${JSON.stringify(value)}\n`);
}

function openApproval(info: ApprovalInfo): void {
  writeStatus({
    event: "approval_required",
    verification_uri: info.verification_uri,
    verification_uri_complete: info.verification_uri_complete,
    user_code: info.user_code,
    expires_in: info.expires_in,
  });
  const launch = approvalBrowserCommand(info);
  if (!launch) return;
  const child = spawn(launch.command, launch.args, {
    detached: true,
    shell: false,
    stdio: "ignore",
  });
  child.unref();
}

function createClient(storage = new PrivateFileStorage()): AgentAuthClient {
  return new AgentAuthClient({
    storage,
    allowDirectDiscovery: true,
    jwtExpirySeconds: 60,
    approvalTimeoutMs: 5 * 60_000,
    onApprovalRequired: openApproval,
    onApprovalStatusChange(status) {
      writeStatus({ event: "approval_status", status });
    },
  });
}

function workspaceContext(requested?: string): WorkspaceContext {
  const credentials = loadCredentialsV3();
  const workspaceId = requested || process.env.COMPANION_WORKSPACE_ID || credentials.activeWorkspaceId;
  const workspace = credentials.workspaces[workspaceId];
  if (!workspace) throw new Error(`credentials.json has no workspace entry for ${workspaceId}`);
  const authentication = selectWorkspaceAuthentication(workspace);
  return { workspaceId, workspace, authentication };
}

function agentReference(context: WorkspaceContext) {
  if (context.authentication.kind !== "agent") {
    throw new Error("this operation requires delegated Agent Auth; explicit legacy PAT mode is not supported here");
  }
  return context.authentication.reference;
}

function workspaceConstraint(workspaceId: string): CapabilityConstraints {
  return { workspaceId: { eq: workspaceId } };
}

function constraintMatches(value: CapabilityConstraints | null | undefined, workspaceId: string): boolean {
  const workspace = value?.workspaceId;
  if (typeof workspace === "string") return workspace === workspaceId;
  return isRecord(workspace) && workspace.eq === workspaceId;
}

async function ensureCapability(
  client: AgentAuthClient,
  context: WorkspaceContext,
  capability: CompanionCapability,
): Promise<void> {
  const agentId = agentReference(context).agentId;
  const status = await client.agentStatus(agentId);
  const existing = status.agent_capability_grants.find(
    (grant) =>
      grant.capability === capability &&
      grant.status === "active" &&
      (capability === "public-skills:install" || constraintMatches(grant.constraints, context.workspaceId)),
  );
  if (existing) return;

  const requested =
    capability === "public-skills:install"
      ? capability
      : { name: capability, constraints: workspaceConstraint(context.workspaceId) };
  const result = await client.requestCapability({
    agentId,
    capabilities: [requested],
    reason:
      capability === "public-skills:install"
        ? "Install public Companion skills from this instance"
        : `Use ${capability} in Companion workspace ${context.workspaceId}`,
    preferredMethod: "device_authorization",
  });
  if (!result.granted.includes(capability)) {
    throw new Error(`capability ${capability} was not approved`);
  }
}

async function agentFetch(input: {
  client: AgentAuthClient;
  context: WorkspaceContext;
  capability: Exclude<CompanionCapability, "public-skills:install">;
  method: CompanionHttpMethod;
  path: string;
  body?: Uint8Array | string;
  contentType?: string;
}): Promise<Response> {
  await ensureCapability(input.client, input.context, input.capability);
  const url = `${input.context.workspace.apiUrl.replace(/\/$/, "")}${input.path}`;
  const signed = await input.client.signJwt({
    agentId: agentReference(input.context).agentId,
    capabilities: [input.capability],
    audience: agentReference(input.context).issuer,
  });
  return fetch(url, {
    method: input.method,
    headers: {
      Authorization: `Bearer ${signed.token}`,
      "X-Companion-Workspace-Id": input.context.workspaceId,
      ...(input.contentType ? { "Content-Type": input.contentType } : {}),
    },
    ...(input.body !== undefined ? { body: input.body } : {}),
    redirect: "error",
  });
}

async function authenticatedRestFetch(input: {
  client: AgentAuthClient;
  context: WorkspaceContext;
  capability: Exclude<CompanionCapability, "public-skills:install">;
  method: CompanionHttpMethod;
  path: string;
  body?: Uint8Array | string;
  contentType?: string;
}): Promise<Response> {
  if (input.context.authentication.kind === "agent") return agentFetch(input);
  const url = `${input.context.workspace.apiUrl.replace(/\/$/, "")}${input.path}`;
  return fetch(url, {
    method: input.method,
    headers: {
      Authorization: `Bearer ${input.context.authentication.token}`,
      "X-Companion-Workspace-Id": input.context.workspaceId,
      ...(input.contentType ? { "Content-Type": input.contentType } : {}),
    },
    ...(input.body !== undefined ? { body: input.body } : {}),
    redirect: "error",
  });
}

async function responseError(response: Response, sensitive: boolean): Promise<never> {
  const detail = sensitive ? "response body withheld" : redact((await response.text()).slice(0, 2_000));
  throw new Error(`Companion API returned HTTP ${response.status}: ${detail}`);
}

function capabilityExecutionData(execution: unknown): JsonObject {
  if (!isRecord(execution)) throw new Error("capability execution returned an invalid response");
  const data = isRecord(execution.data) ? execution.data : isRecord(execution.result) ? execution.result : null;
  if (!data) throw new Error("capability execution returned no transfer binding");
  return data;
}

async function requestTransferTicket(input: {
  client: AgentAuthClient;
  context: WorkspaceContext;
  capability: "skills:read" | "skills:write" | "public-skills:install";
  arguments: JsonObject;
}): Promise<JsonObject> {
  await ensureCapability(input.client, input.context, input.capability);
  const execution = await input.client.executeCapability({
    agentId: input.context.workspace.agentAuth!.agentId,
    capability: input.capability,
    arguments: input.arguments,
  });
  const data = capabilityExecutionData(execution);
  if (typeof data.ticket !== "string") throw new Error("capability execution did not return a transfer ticket");
  return data;
}

function validateChecksum(bytes: Uint8Array, expected: string): void {
  const actual = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  if (actual !== expected) throw new Error(`download checksum mismatch: expected ${expected}, received ${actual}`);
}

function atomicWrite(path: string, bytes: Uint8Array): void {
  const destination = resolve(path);
  mkdirSync(dirname(destination), { recursive: true });
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, bytes, { mode: 0o600, flag: "wx" });
    chmodSync(temporary, 0o600);
    renameSync(temporary, destination);
  } finally {
    rmSync(temporary, { force: true });
  }
}

async function connect(input: Extract<ClientInput, { action: "connect" }>): Promise<unknown> {
  const client = createClient();
  const provider = new URL(input.apiUrl).origin;
  const result = await client.connectAgent({
    provider,
    mode: "delegated",
    preferredMethod: "device_authorization",
    name: input.name || process.env.COMPANION_AGENT || "Companion agent",
    capabilities: [{ name: "skills:read", constraints: workspaceConstraint(input.workspaceId) }],
    reason: `Read skills in Companion workspace ${input.workspaceId}`,
  });
  const config = await client.getProviderConfig(provider);
  saveAgentCredentialReference({
    workspaceId: input.workspaceId,
    apiUrl: input.apiUrl,
    issuer: config.issuer,
    agentId: result.agentId,
  });
  return {
    ok: true,
    workspaceId: input.workspaceId,
    issuer: config.issuer,
    agentId: result.agentId,
    status: result.status,
    capabilities: result.capabilityGrants.map((grant) => grant.capability),
  };
}

async function apiRequest(input: Extract<ClientInput, { action: "api" }>): Promise<unknown> {
  const context = workspaceContext(input.workspaceId);
  const operation = resolveOperation(input.method, input.path);
  if (operation.binary) throw new Error(`use the ${operation.binary} action for binary operations`);
  const pathname = new URL(input.path, "https://companion.invalid").pathname;
  if (pathname === "/secret-grants/redeem" || /^\/secret-retrievals\/[^/]+\/grant$/.test(pathname)) {
    throw new Error("secret grants and redeemed values must use the private secret-redeem pipe action");
  }
  const client = createClient();
  const response = await authenticatedRestFetch({
    client,
    context,
    capability: operation.capability,
    method: input.method,
    path: input.path,
    ...(input.body !== undefined ? { body: JSON.stringify(input.body), contentType: "application/json" } : {}),
  });
  if (!response.ok) return responseError(response, operation.sensitive);
  if (response.status === 204) return { ok: true };
  return (await response.json()) as unknown;
}

async function upload(input: Extract<ClientInput, { action: "upload" }>): Promise<unknown> {
  const context = workspaceContext(input.workspaceId);
  const operation = resolveOperation(input.method, input.path);
  if (operation.binary !== "upload") throw new Error("operation is not a registered binary upload");
  if (operation.capability !== "skills:write") throw new Error("binary upload requires skills:write");
  const target = new URL(input.path, "https://companion.invalid");
  const publishAction = target.searchParams.get("action");
  const slug = target.searchParams.get("expect_slug")?.trim();
  const version = target.searchParams.get("version")?.trim();
  if (target.pathname !== "/skills" || !["publish", "validate"].includes(publishAction ?? "") || !slug || !version) {
    throw new Error("Agent Auth upload path requires /skills?action=publish|validate&expect_slug=<slug>&version=<version>");
  }
  const bytes = new Uint8Array(readFileSync(resolve(input.inputPath)));
  const checksum = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  if (context.authentication.kind === "legacy-pat") {
    const response = await authenticatedRestFetch({
      client: createClient(),
      context,
      capability: "skills:write",
      method: input.method,
      path: input.path,
      body: bytes,
      contentType: input.contentType || "application/zip",
    });
    if (!response.ok) return responseError(response, operation.sensitive);
    return (await response.json()) as unknown;
  }
  const client = createClient();
  const transfer = await requestTransferTicket({
    client,
    context,
    capability: "skills:write",
    arguments: {
      workspaceId: context.workspaceId,
      transfer: { action: "upload", slug, version, checksum, sizeBytes: bytes.byteLength },
    },
  });
  if (transfer.checksum !== checksum || transfer.size_bytes !== bytes.byteLength) {
    throw new Error("upload transfer binding does not match the local package");
  }
  const response = await fetch(`${context.workspace.apiUrl.replace(/\/$/, "")}${input.path}`, {
    method: input.method,
    headers: {
      "X-Companion-Transfer-Ticket": transfer.ticket as string,
      "Content-Type": input.contentType || "application/zip",
    },
    body: bytes,
    redirect: "error",
  });
  if (!response.ok) return responseError(response, operation.sensitive);
  return (await response.json()) as unknown;
}

async function download(input: Extract<ClientInput, { action: "download" }>): Promise<unknown> {
  const context = workspaceContext(input.workspaceId);
  const operation = resolveOperation("GET", input.path);
  if (operation.binary !== "download") throw new Error("operation is not a registered binary download");
  if (operation.capability !== "skills:read") throw new Error("binary download requires skills:read");
  const client = createClient();
  if (context.authentication.kind === "legacy-pat") {
    const response = await authenticatedRestFetch({
      client,
      context,
      capability: "skills:read",
      method: "GET",
      path: input.path,
    });
    if (!response.ok) return responseError(response, operation.sensitive);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const headerSize = Number.parseInt(
      response.headers.get("x-companion-package-size") ?? response.headers.get("x-companion-file-size") ?? "",
      10,
    );
    const expectedSize = input.sizeBytes ?? (Number.isSafeInteger(headerSize) ? headerSize : undefined);
    const expectedChecksum = input.checksum
      ?? response.headers.get("x-companion-package-checksum")
      ?? response.headers.get("x-companion-file-checksum")
      ?? undefined;
    if (expectedSize !== undefined && bytes.byteLength !== expectedSize) {
      throw new Error(`download size mismatch: expected ${expectedSize}, received ${bytes.byteLength}`);
    }
    if (expectedChecksum) validateChecksum(bytes, expectedChecksum);
    atomicWrite(input.outputPath, bytes);
    return { ok: true, outputPath: resolve(input.outputPath), sizeBytes: bytes.byteLength, checksum: expectedChecksum ?? null };
  }
  const ticketed = resolveTicketedDownloadTarget(input.path);
  const slug = ticketed.slug;
  let version: string;
  let transferAction: "download" | "download-file" | "download-local";
  let filePath: string | undefined;
  if (ticketed.kind === "skill-package") {
    version = ticketed.version;
    transferAction = "download";
  } else if (ticketed.kind === "skill-file") {
    version = ticketed.version;
    filePath = ticketed.filePath;
    transferAction = "download-file";
  } else {
    const metadata = await agentFetch({
      client,
      context,
      capability: "skills:read",
      method: "GET",
      path: `/local-skills/${encodeURIComponent(slug)}`,
    });
    if (!metadata.ok) return responseError(metadata, false);
    const row = (await metadata.json()) as unknown;
    if (!isRecord(row) || typeof row.availableVersion !== "string") {
      throw new Error("local skill metadata did not include an available version");
    }
    version = row.availableVersion;
    transferAction = "download-local";
  }
  const transfer = await requestTransferTicket({
    client,
    context,
    capability: "skills:read",
    arguments: {
      workspaceId: context.workspaceId,
      transfer: { action: transferAction, slug, version, ...(filePath ? { path: filePath } : {}) },
    },
  });
  const response = await fetch(`${context.workspace.apiUrl.replace(/\/$/, "")}${input.path}`, {
    headers: { "X-Companion-Transfer-Ticket": transfer.ticket as string },
    redirect: "error",
  });
  if (!response.ok) return responseError(response, operation.sensitive);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const expectedSize = input.sizeBytes ?? (typeof transfer.size_bytes === "number" ? transfer.size_bytes : undefined);
  const expectedChecksum = input.checksum ?? (typeof transfer.checksum === "string" ? transfer.checksum : undefined);
  if (expectedSize !== undefined && bytes.byteLength !== expectedSize) {
    throw new Error(`download size mismatch: expected ${expectedSize}, received ${bytes.byteLength}`);
  }
  if (expectedChecksum) validateChecksum(bytes, expectedChecksum);
  atomicWrite(input.outputPath, bytes);
  return { ok: true, outputPath: resolve(input.outputPath), sizeBytes: bytes.byteLength, checksum: expectedChecksum ?? null };
}

async function publicInstall(input: Extract<ClientInput, { action: "public-install" }>): Promise<unknown> {
  const context = workspaceContext(input.workspaceId);
  agentReference(context);
  const client = createClient();
  const previewUrl = `${context.workspace.apiUrl.replace(/\/$/, "")}/public/skills/${encodeURIComponent(input.token)}`;
  const previewResponse = await fetch(previewUrl, { redirect: "error" });
  if (!previewResponse.ok) return responseError(previewResponse, false);
  const preview = (await previewResponse.json()) as unknown;
  if (!isRecord(preview) || typeof preview.slug !== "string" || !isRecord(preview.public_release)) {
    throw new Error("public skill preview has no installable release");
  }
  const release = preview.public_release;
  if (
    release.version !== input.version
    || release.checksum !== input.checksum
    || release.size_bytes !== input.sizeBytes
  ) {
    throw new Error("public release metadata changed; review the public page before installing");
  }
  const transfer = await requestTransferTicket({
    client,
    context,
    capability: "public-skills:install",
    arguments: { token: input.token, version: input.version },
  });
  if (transfer.version !== input.version || transfer.checksum !== input.checksum || transfer.size_bytes !== input.sizeBytes) {
    throw new Error("public install transfer binding does not match the reviewed release");
  }
  const path = `/public/skills/${encodeURIComponent(input.token)}/versions/${encodeURIComponent(input.version)}/package`;
  const url = `${context.workspace.apiUrl.replace(/\/$/, "")}${path}`;
  const response = await fetch(url, {
    headers: { "X-Companion-Transfer-Ticket": transfer.ticket as string },
    redirect: "error",
  });
  if (!response.ok) return responseError(response, true);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength !== input.sizeBytes) {
    throw new Error(`download size mismatch: expected ${input.sizeBytes}, received ${bytes.byteLength}`);
  }
  validateChecksum(bytes, input.checksum);
  const installed = installPublicSkillZip({
    bytes,
    slug: preview.slug,
    tool: input.tool,
    scope: input.scope,
    ...(input.projectRoot ? { projectRoot: input.projectRoot } : {}),
    confirmInstall: input.confirmInstall,
    ...(input.confirmReplace !== undefined ? { confirmReplace: input.confirmReplace } : {}),
  });
  return {
    ok: true,
    destination: installed.destination,
    replaced: installed.replaced,
    prerequisites: installed.prerequisites,
    slug: preview.slug,
    version: input.version,
    checksum: input.checksum,
    sizeBytes: bytes.byteLength,
  };
}

async function secretRedeem(input: Extract<ClientInput, { action: "secret-redeem" }>): Promise<unknown> {
  const context = workspaceContext(input.workspaceId);
  if (!Number.isSafeInteger(input.outputFd) || input.outputFd < 3) {
    throw new Error("secret-redeem requires an inherited private pipe descriptor");
  }
  const descriptor = fstatSync(input.outputFd);
  if (!descriptor.isFIFO() && !descriptor.isSocket()) {
    throw new Error("secret-redeem refuses stdout, stderr, and regular-file output");
  }
  const planId = input.planId.trim();
  if (!planId || planId.includes("/") || planId.includes("\\")) throw new Error("invalid secret retrieval plan id");
  const client = createClient();
  const grantResponse = await authenticatedRestFetch({
    client,
    context,
    capability: "secrets:read",
    method: "POST",
    path: `/secret-retrievals/${encodeURIComponent(planId)}/grant`,
    body: "{}",
    contentType: "application/json",
  });
  if (!grantResponse.ok) return responseError(grantResponse, true);
  const grantPayload = (await grantResponse.json()) as unknown;
  if (!isRecord(grantPayload) || typeof grantPayload.grant !== "string") {
    throw new Error("Companion did not return a secret retrieval grant");
  }
  const redeemResponse = await authenticatedRestFetch({
    client,
    context,
    capability: "secrets:read",
    method: "POST",
    path: "/secret-grants/redeem",
    body: JSON.stringify({ grant: grantPayload.grant }),
    contentType: "application/json",
  });
  if (!redeemResponse.ok) return responseError(redeemResponse, true);
  const redeemed = (await redeemResponse.json()) as unknown;
  if (!isRecord(redeemed)) throw new Error("Companion returned an invalid secret redemption");
  try {
    writeFileSync(input.outputFd, JSON.stringify(redeemed), { encoding: "utf8" });
  } finally {
    closeSync(input.outputFd);
  }
  return {
    ok: true,
    items: Array.isArray(redeemed.items) ? redeemed.items.length : 0,
    tombstones: Array.isArray(redeemed.tombstones) ? redeemed.tombstones.length : 0,
  };
}

async function status(input: Extract<ClientInput, { action: "status" }>): Promise<unknown> {
  const context = workspaceContext(input.workspaceId);
  if (context.authentication.kind === "legacy-pat") {
    const response = await authenticatedRestFetch({
      client: createClient(),
      context,
      capability: "skills:read",
      method: "GET",
      path: "/skills?limit=1",
    });
    if (!response.ok) return responseError(response, false);
    return { mode: "legacy-pat", status: "active", workspaceId: context.workspaceId };
  }
  const result = await createClient().agentStatus(context.authentication.reference.agentId);
  return {
    agentId: result.agent_id,
    status: result.status,
    capabilities: result.agent_capability_grants.map((grant) => ({
      name: grant.capability,
      status: grant.status,
      constraints: grant.constraints ?? null,
    })),
  };
}

async function main(): Promise<void> {
  const input = readInput();
  const result =
    input.action === "connect"
      ? await connect(input)
      : input.action === "api"
        ? await apiRequest(input)
        : input.action === "upload"
          ? await upload(input)
          : input.action === "download"
            ? await download(input)
            : input.action === "public-install"
              ? await publicInstall(input)
              : input.action === "secret-redeem"
                ? await secretRedeem(input)
                : await status(input);
  writeResult({ ok: true, data: result });
}

main().catch((error: unknown) => {
  const message = redact(error instanceof Error ? error.message : String(error));
  writeResult({ ok: false, error: message });
  process.exitCode = 1;
});
