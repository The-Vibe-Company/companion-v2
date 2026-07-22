import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type {
  AgentConnection,
  HostIdentity,
  ProviderConfig,
  Storage,
} from "@auth/agent";

export interface AgentCredentialReference {
  issuer: string;
  agentId: string;
}

export interface LegacyPatReference {
  token: string;
  updatedAt?: string;
}

export interface WorkspaceCredentialV3 {
  apiUrl: string;
  agentAuth?: AgentCredentialReference;
  legacyPat?: LegacyPatReference;
  updatedAt?: string;
}

export interface CredentialsV3 {
  schemaVersion: 3;
  activeWorkspaceId: string;
  workspaces: Record<string, WorkspaceCredentialV3>;
}

interface CredentialsV2 {
  schemaVersion: 2;
  activeWorkspaceId: string;
  workspaces: Record<
    string,
    {
      apiUrl?: unknown;
      token?: unknown;
      updatedAt?: unknown;
      agentAuth?: unknown;
      legacyPat?: unknown;
    }
  >;
}

const CREDENTIALS_LOCK_TIMEOUT_MS = 10_000;
const CREDENTIALS_LOCK_STALE_MS = 300_000;
const CREDENTIALS_LOCK_POLL_MS = 50;
const credentialsLockWaiter = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

function companionHome(): string {
  return process.env.COMPANION_HOME || join(homedir(), ".companion");
}

export function credentialsPath(): string {
  return join(companionHome(), "credentials.json");
}

function rejectSymlink(path: string): void {
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
    throw new Error(`refusing symbolic-link state path: ${path}`);
  }
}

function ensurePrivateDirectory(path: string): void {
  rejectSymlink(path);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

function atomicPrivateJsonWrite(path: string, value: unknown): void {
  const parent = dirname(path);
  ensurePrivateDirectory(parent);
  rejectSymlink(path);
  const temporary = join(parent, `.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function readJson(path: string): unknown {
  rejectSymlink(path);
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

/** Match the Python Companion runtime's cross-process `.credentials.lock` directory protocol. */
function withCredentialsWriteLock<T>(operation: () => T): T {
  const directory = companionHome();
  ensurePrivateDirectory(directory);
  const lockPath = join(directory, ".credentials.lock");
  const deadline = Date.now() + CREDENTIALS_LOCK_TIMEOUT_MS;

  while (true) {
    try {
      mkdirSync(lockPath, { mode: 0o700 });
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
      rejectSymlink(lockPath);
      const lock = lstatSync(lockPath);
      if (!lock.isDirectory()) throw new Error(`credential lock is not a directory: ${lockPath}`);
      if (Date.now() - lock.mtimeMs > CREDENTIALS_LOCK_STALE_MS) {
        try {
          rmdirSync(lockPath);
          continue;
        } catch (staleError) {
          if ((staleError as NodeJS.ErrnoException).code === "ENOENT") continue;
        }
      }
      if (Date.now() >= deadline) throw new Error("timed out waiting to update credentials.json");
      Atomics.wait(credentialsLockWaiter, 0, 0, CREDENTIALS_LOCK_POLL_MS);
    }
  }

  try {
    return operation();
  } finally {
    try {
      rmdirSync(lockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeAgentReference(value: unknown): AgentCredentialReference | undefined {
  if (!isRecord(value) || typeof value.issuer !== "string" || typeof value.agentId !== "string") {
    return undefined;
  }
  return { issuer: value.issuer, agentId: value.agentId };
}

function normalizeLegacyPat(value: unknown): LegacyPatReference | undefined {
  if (!isRecord(value) || typeof value.token !== "string") return undefined;
  return {
    token: value.token,
    ...(typeof value.updatedAt === "string" ? { updatedAt: value.updatedAt } : {}),
  };
}

/**
 * Upgrade the credentials index without placing an agent private key in it. Existing PATs are
 * retained under `legacyPat`, but callers must explicitly select legacy mode before they are used.
 */
export function migrateCredentialsV2ToV3(value: CredentialsV2): CredentialsV3 {
  if (!value.activeWorkspaceId || !isRecord(value.workspaces)) {
    throw new Error("credentials v2 is missing its active workspace");
  }

  const workspaces: Record<string, WorkspaceCredentialV3> = {};
  for (const [workspaceId, rawEntry] of Object.entries(value.workspaces)) {
    if (!isRecord(rawEntry) || typeof rawEntry.apiUrl !== "string") continue;
    const updatedAt = typeof rawEntry.updatedAt === "string" ? rawEntry.updatedAt : undefined;
    const legacyPat =
      normalizeLegacyPat(rawEntry.legacyPat) ??
      (typeof rawEntry.token === "string"
        ? { token: rawEntry.token, ...(updatedAt ? { updatedAt } : {}) }
        : undefined);
    workspaces[workspaceId] = {
      apiUrl: rawEntry.apiUrl,
      ...(normalizeAgentReference(rawEntry.agentAuth)
        ? { agentAuth: normalizeAgentReference(rawEntry.agentAuth) }
        : {}),
      ...(legacyPat ? { legacyPat } : {}),
      ...(updatedAt ? { updatedAt } : {}),
    };
  }

  return {
    schemaVersion: 3,
    activeWorkspaceId: value.activeWorkspaceId,
    workspaces,
  };
}

function parseCredentials(raw: unknown): { credentials: CredentialsV3; needsMigration: boolean } {
  if (!isRecord(raw)) throw new Error("credentials.json must contain a JSON object");

  if (raw.schemaVersion === 2) {
    return {
      credentials: migrateCredentialsV2ToV3(raw as unknown as CredentialsV2),
      needsMigration: true,
    };
  }

  if (raw.schemaVersion !== 3 || typeof raw.activeWorkspaceId !== "string" || !isRecord(raw.workspaces)) {
    throw new Error("credentials.json must use schemaVersion 3");
  }

  const workspaces: Record<string, WorkspaceCredentialV3> = {};
  for (const [workspaceId, value] of Object.entries(raw.workspaces)) {
    if (!isRecord(value) || typeof value.apiUrl !== "string") continue;
    workspaces[workspaceId] = {
      apiUrl: value.apiUrl,
      ...(normalizeAgentReference(value.agentAuth)
        ? { agentAuth: normalizeAgentReference(value.agentAuth) }
        : {}),
      ...(normalizeLegacyPat(value.legacyPat)
        ? { legacyPat: normalizeLegacyPat(value.legacyPat) }
        : {}),
      ...(typeof value.updatedAt === "string" ? { updatedAt: value.updatedAt } : {}),
    };
  }
  return {
    credentials: { schemaVersion: 3, activeWorkspaceId: raw.activeWorkspaceId, workspaces },
    needsMigration: false,
  };
}

export function loadCredentialsV3(options: { migrate?: boolean } = {}): CredentialsV3 {
  const path = credentialsPath();
  const parsed = parseCredentials(readJson(path));
  if (!parsed.needsMigration || options.migrate === false) return parsed.credentials;

  // Re-read only after taking the shared Python/TypeScript lock: another process may already have
  // migrated or updated this workspace while this process was waiting.
  return withCredentialsWriteLock(() => {
    const locked = parseCredentials(readJson(path));
    if (locked.needsMigration) atomicPrivateJsonWrite(path, locked.credentials);
    return locked.credentials;
  });
}

export function saveAgentCredentialReference(input: {
  workspaceId: string;
  apiUrl: string;
  issuer: string;
  agentId: string;
}): CredentialsV3 {
  return withCredentialsWriteLock(() => {
    const path = credentialsPath();
    const credentials = existsSync(path)
      ? parseCredentials(readJson(path)).credentials
      : {
          schemaVersion: 3 as const,
          activeWorkspaceId: input.workspaceId,
          workspaces: {},
        };
    const previous = credentials.workspaces[input.workspaceId];
    const next: CredentialsV3 = {
      ...credentials,
      activeWorkspaceId: input.workspaceId,
      workspaces: {
        ...credentials.workspaces,
        [input.workspaceId]: {
          ...previous,
          apiUrl: input.apiUrl,
          agentAuth: { issuer: input.issuer, agentId: input.agentId },
          updatedAt: new Date().toISOString(),
        },
      },
    };
    atomicPrivateJsonWrite(path, next);
    return next;
  });
}

function stateRoot(): string {
  return join(companionHome(), "agent-auth");
}

function providerFilename(issuer: string): string {
  // Match @auth/agent-cli@0.5.1 FileStorage so the pinned bootstrap CLI and the bundled client can
  // reuse the same approved connection without copying any private key material.
  return `${encodeURIComponent(issuer).replace(/%/g, "_")}.json`;
}

/** File-backed SDK storage. Key-bearing files live outside credentials.json and are always 0600. */
export class PrivateFileStorage implements Storage {
  readonly root: string;

  constructor(root = stateRoot()) {
    this.root = root;
    ensurePrivateDirectory(this.root);
    ensurePrivateDirectory(join(this.root, "agents"));
    ensurePrivateDirectory(join(this.root, "providers"));
  }

  private read<T>(path: string): T | null {
    if (!existsSync(path)) return null;
    return readJson(path) as T;
  }

  private write(path: string, value: unknown): void {
    atomicPrivateJsonWrite(path, value);
  }

  async getHostIdentity(): Promise<HostIdentity | null> {
    return this.read<HostIdentity>(join(this.root, "host.json"));
  }

  async setHostIdentity(host: HostIdentity): Promise<void> {
    this.write(join(this.root, "host.json"), host);
  }

  async deleteHostIdentity(): Promise<void> {
    rmSync(join(this.root, "host.json"), { force: true });
  }

  async getAgentConnection(agentId: string): Promise<AgentConnection | null> {
    return this.read<AgentConnection>(join(this.root, "agents", `${agentId}.json`));
  }

  async setAgentConnection(agentId: string, connection: AgentConnection): Promise<void> {
    if (agentId !== connection.agentId || !/^[A-Za-z0-9._-]+$/.test(agentId)) {
      throw new Error("invalid agent id for private storage");
    }
    this.write(join(this.root, "agents", `${agentId}.json`), connection);
  }

  async deleteAgentConnection(agentId: string): Promise<void> {
    if (!/^[A-Za-z0-9._-]+$/.test(agentId)) throw new Error("invalid agent id");
    rmSync(join(this.root, "agents", `${agentId}.json`), { force: true });
  }

  async listAgentConnections(): Promise<AgentConnection[]> {
    const credentials = existsSync(credentialsPath()) ? loadCredentialsV3() : null;
    const ids = new Set(
      Object.values(credentials?.workspaces ?? {})
        .map((entry) => entry.agentAuth?.agentId)
        .filter((value): value is string => Boolean(value)),
    );
    const connections = await Promise.all([...ids].map((id) => this.getAgentConnection(id)));
    return connections.filter((value): value is AgentConnection => value !== null);
  }

  async getProviderConfig(issuer: string): Promise<ProviderConfig | null> {
    return this.read<ProviderConfig>(join(this.root, "providers", providerFilename(issuer)));
  }

  async setProviderConfig(issuer: string, config: ProviderConfig): Promise<void> {
    this.write(join(this.root, "providers", providerFilename(issuer)), config);
  }

  async listProviderConfigs(): Promise<ProviderConfig[]> {
    const connections = await this.listAgentConnections();
    const issuers = [...new Set(connections.map((connection) => connection.issuer))];
    const providers = await Promise.all(issuers.map((issuer) => this.getProviderConfig(issuer)));
    return providers.filter((value): value is ProviderConfig => value !== null);
  }
}
