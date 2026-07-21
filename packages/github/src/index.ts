import { createSign, createVerify } from "node:crypto";
import type { GitHubInstallation, GitHubRepositoryCandidate } from "@companion/contracts";
import { buildNormalizedSkillMd, extractArchiveEntryBuffers, parseFrontmatter, skillChecksum, toTar } from "@companion/skills";

const API = "https://api.github.com";
const WEB = "https://github.com";
const API_VERSION = "2022-11-28";
const LIST_PAGE_SIZE = 100;
const REPOSITORY_LIST_CONCURRENCY = 6;
const COMPANION_OWNERSHIP_KEY = "companion_ownership";

export interface GitHubOAuthConfig {
  slug: string;
  clientId: string;
  clientSecret: string;
  name: string;
  managed: boolean;
}

export interface GitHubAppConfig {
  appId: string;
  privateKey: string;
}

export function githubOAuthConfig(env: NodeJS.ProcessEnv = process.env): GitHubOAuthConfig | null {
  const slug = env.GITHUB_APP_SLUG?.trim();
  const clientId = env.GITHUB_APP_CLIENT_ID?.trim();
  const clientSecret = env.GITHUB_APP_CLIENT_SECRET?.trim();
  if (!slug || !clientId || !clientSecret) return null;
  const managed = env.COMPANION_GITHUB_APP_MANAGED?.trim().toLowerCase() === "true";
  return { slug, clientId, clientSecret, name: env.GITHUB_APP_NAME?.trim() || (managed ? "Companion" : slug), managed };
}

export function githubSyncEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.COMPANION_GITHUB_SYNC_ENABLED?.trim().toLowerCase() === "true";
}

export function githubAppConfig(env: NodeJS.ProcessEnv = process.env): GitHubAppConfig | null {
  const appId = env.GITHUB_APP_ID?.trim();
  const rawKey = env.GITHUB_APP_PRIVATE_KEY?.trim();
  if (!appId || !rawKey) return null;
  const privateKey = rawKey.includes("BEGIN") ? rawKey.replaceAll("\\n", "\n") : Buffer.from(rawKey, "base64").toString("utf8");
  if (!privateKey.includes("BEGIN") || !privateKey.includes("PRIVATE KEY")) return null;
  return { appId, privateKey };
}

function base64url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url");
}

function appJwt(config: GitHubAppConfig): string {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify({ iat: now - 30, exp: now + 9 * 60, iss: config.appId }));
  const unsigned = `${header}.${payload}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  return `${unsigned}.${signer.sign(config.privateKey).toString("base64url")}`;
}

function ownershipSignaturePayload(input: {
  appId: string;
  repositoryId: string;
  previousCommitSha: string | null;
  managedSlugs: string[];
}): string {
  return JSON.stringify({ schema: 1, ...input });
}

function signedOwnershipManifest(config: GitHubAppConfig, input: {
  repositoryId: string;
  previousCommitSha: string | null;
  managedSlugs: string[];
  manifest: Buffer;
}): Buffer {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(input.manifest.toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new Error("Companion sync manifest is not valid JSON");
  }
  const ownership = parseManagedSlugs(input.manifest);
  const managedSlugs = [...new Set(input.managedSlugs)].sort();
  if (!ownership.valid || ownership.slugs.size !== managedSlugs.length || managedSlugs.some((slug) => !ownership.slugs.has(slug))) {
    throw new Error("Companion sync manifest does not match the managed skill set");
  }
  const signer = createSign("RSA-SHA256");
  signer.update(ownershipSignaturePayload({
    appId: config.appId,
    repositoryId: input.repositoryId,
    previousCommitSha: input.previousCommitSha,
    managedSlugs,
  }));
  return Buffer.from(`${JSON.stringify({
    ...parsed,
    [COMPANION_OWNERSHIP_KEY]: {
      app_id: config.appId,
      previous_commit_sha: input.previousCommitSha,
      signature: signer.sign(config.privateKey).toString("base64url"),
    },
  }, null, 2)}\n`, "utf8");
}

function verifiedPendingOwnership(config: GitHubAppConfig, input: {
  repositoryId: string;
  expectedPreviousCommitSha?: string | null;
  manifest: Buffer | null;
}): Set<string> | null {
  if (!input.manifest) return null;
  try {
    const parsed = JSON.parse(input.manifest.toString("utf8")) as Record<string, unknown>;
    const raw = parsed[COMPANION_OWNERSHIP_KEY];
    if (!raw || typeof raw !== "object") return null;
    const proof = raw as Record<string, unknown>;
    if (proof.app_id !== config.appId || typeof proof.signature !== "string") return null;
    if (proof.previous_commit_sha !== null && typeof proof.previous_commit_sha !== "string") return null;
    if (input.expectedPreviousCommitSha !== undefined && proof.previous_commit_sha !== input.expectedPreviousCommitSha) return null;
    const ownership = parseManagedSlugs(input.manifest);
    if (!ownership.valid) return null;
    const managedSlugs = [...ownership.slugs].sort();
    const verifier = createVerify("RSA-SHA256");
    verifier.update(ownershipSignaturePayload({
      appId: config.appId,
      repositoryId: input.repositoryId,
      previousCommitSha: proof.previous_commit_sha,
      managedSlugs,
    }));
    return verifier.verify(config.privateKey, Buffer.from(proof.signature, "base64url")) ? ownership.slugs : null;
  } catch {
    return null;
  }
}

function manifestProjectionMatches(current: Buffer | null, desired: Buffer): boolean {
  if (!current) return false;
  try {
    const currentValue = JSON.parse(current.toString("utf8")) as Record<string, unknown>;
    const desiredValue = JSON.parse(desired.toString("utf8")) as Record<string, unknown>;
    delete currentValue[COMPANION_OWNERSHIP_KEY];
    delete desiredValue[COMPANION_OWNERSHIP_KEY];
    return JSON.stringify(currentValue) === JSON.stringify(desiredValue);
  } catch {
    return false;
  }
}

export class GitHubApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "GitHubApiError";
  }
}

class GitHubEmptyRepositoryBootstrapped extends Error {
  constructor() {
    super("GitHub empty repository initialized; retrying the managed commit");
    this.name = "GitHubEmptyRepositoryBootstrapped";
  }
}

async function githubFetch<T>(path: string, input: {
  token?: string;
  basic?: { username: string; password: string };
  method?: string;
  body?: unknown;
  fetch?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
} = {}): Promise<T> {
  const execute = input.fetch ?? globalThis.fetch;
  const controller = new AbortController();
  let timedOut = false;
  const relayAbort = () => controller.abort(input.signal?.reason);
  if (input.signal?.aborted) relayAbort();
  else input.signal?.addEventListener("abort", relayAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, input.timeoutMs ?? 30_000);
  try {
    const response = await execute(path.startsWith("http") ? path : `${API}${path}`, {
      method: input.method ?? (input.body === undefined ? "GET" : "POST"),
      headers: {
        accept: "application/vnd.github+json",
        "x-github-api-version": API_VERSION,
        "user-agent": "companion-github-sync",
        ...(input.token ? { authorization: `Bearer ${input.token}` } : {}),
        ...(input.basic ? { authorization: `Basic ${Buffer.from(`${input.basic.username}:${input.basic.password}`).toString("base64")}` } : {}),
        ...(input.body === undefined ? {} : { "content-type": "application/json" }),
      },
      signal: controller.signal,
      ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
    });
    const body = await response.json().catch(() => ({})) as { message?: string };
    if (!response.ok) throw new GitHubApiError(response.status, body.message || `GitHub request failed (${response.status})`);
    return body as T;
  } catch (error) {
    if (timedOut) throw new Error("GitHub request timed out");
    throw error;
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", relayAbort);
  }
}

export interface GitHubOAuthTokens {
  accessToken: string;
  refreshToken: string | null;
  accessExpiresAt: Date | null;
  refreshExpiresAt: Date | null;
}

function oauthTokens(raw: Record<string, unknown>): GitHubOAuthTokens {
  if (typeof raw.access_token !== "string" || !raw.access_token) throw new Error("GitHub did not return an access token");
  const expiresIn = typeof raw.expires_in === "number" ? raw.expires_in : null;
  const refreshExpiresIn = typeof raw.refresh_token_expires_in === "number" ? raw.refresh_token_expires_in : null;
  return {
    accessToken: raw.access_token,
    refreshToken: typeof raw.refresh_token === "string" ? raw.refresh_token : null,
    accessExpiresAt: expiresIn ? new Date(Date.now() + expiresIn * 1000) : null,
    refreshExpiresAt: refreshExpiresIn ? new Date(Date.now() + refreshExpiresIn * 1000) : null,
  };
}

async function collectGitHubPages<T>(
  fetchPage: (page: number) => Promise<{ items: T[]; totalCount: number | null }>,
): Promise<T[]> {
  const items: T[] = [];
  for (let page = 1; ; page += 1) {
    const result = await fetchPage(page);
    items.push(...result.items);
    if (
      result.items.length < LIST_PAGE_SIZE
      || (result.totalCount !== null && items.length >= result.totalCount)
    ) return items;
  }
}

export class GitHubOAuthClient {
  constructor(public readonly config: GitHubOAuthConfig, protected readonly execute: typeof fetch = globalThis.fetch) {}

  authorizationUrl(input: { state: string; redirectUri: string }): string {
    const query = new URLSearchParams({ client_id: this.config.clientId, state: input.state, redirect_uri: input.redirectUri });
    return `${WEB}/login/oauth/authorize?${query}`;
  }

  installationUrl(state?: string): string {
    const suffix = state ? `?state=${encodeURIComponent(state)}` : "";
    return `${WEB}/apps/${encodeURIComponent(this.config.slug)}/installations/new${suffix}`;
  }

  async exchangeCode(code: string, redirectUri: string): Promise<GitHubOAuthTokens> {
    const raw = await githubFetch<Record<string, unknown>>(`${WEB}/login/oauth/access_token`, {
      fetch: this.execute,
      body: { client_id: this.config.clientId, client_secret: this.config.clientSecret, code, redirect_uri: redirectUri },
    });
    return oauthTokens(raw);
  }

  async refreshUserToken(refreshToken: string): Promise<GitHubOAuthTokens> {
    const raw = await githubFetch<Record<string, unknown>>(`${WEB}/login/oauth/access_token`, {
      fetch: this.execute,
      body: { client_id: this.config.clientId, client_secret: this.config.clientSecret, grant_type: "refresh_token", refresh_token: refreshToken },
    });
    return oauthTokens(raw);
  }

  async revokeUserToken(accessToken: string): Promise<void> {
    try {
      await githubFetch(`/applications/${encodeURIComponent(this.config.clientId)}/token`, {
        fetch: this.execute,
        method: "DELETE",
        basic: { username: this.config.clientId, password: this.config.clientSecret },
        body: { access_token: accessToken },
      });
    } catch (error) {
      if (error instanceof GitHubApiError && error.status === 404) return;
      throw error;
    }
  }

  async user(accessToken: string): Promise<{ id: number; login: string; avatar_url: string | null }> {
    return githubFetch("/user", { token: accessToken, fetch: this.execute });
  }

  async repositories(accessToken: string): Promise<GitHubRepositoryCandidate[]> {
    const installations = await collectGitHubPages(async (page) => {
      const response = await githubFetch<{ total_count?: number; installations: Array<{ id: number }> }>(
        `/user/installations?per_page=${LIST_PAGE_SIZE}&page=${page}`,
        { token: accessToken, fetch: this.execute },
      );
      return {
        items: response.installations,
        totalCount: typeof response.total_count === "number" ? response.total_count : null,
      };
    });
    const pages = await mapWithConcurrency(installations, REPOSITORY_LIST_CONCURRENCY, async (installation, _index, signal) => ({
      installationId: String(installation.id),
      repositories: await collectGitHubPages(async (page) => {
        const response = await githubFetch<{ total_count?: number; repositories: Array<{
          id: number; name: string; full_name: string; html_url: string; private: boolean;
          default_branch: string | null; size: number; owner: { login: string };
        }> }>(`/user/installations/${installation.id}/repositories?per_page=${LIST_PAGE_SIZE}&page=${page}`, {
          token: accessToken,
          fetch: this.execute,
          signal,
        });
        return {
          items: response.repositories,
          totalCount: typeof response.total_count === "number" ? response.total_count : null,
        };
      }),
    }));
    const listed = pages.flatMap(({ installationId, repositories }) =>
      repositories.map((repository) => ({ installationId, repository })),
    );
    const candidates = await mapWithConcurrency(
      listed,
      REPOSITORY_LIST_CONCURRENCY,
      async ({ installationId, repository }, _index, signal) => {
        // GitHub reports size in rounded KB, so size=0 can mean either truly empty or a small commit.
        // Only that ambiguous subset needs a branch probe; larger repositories are certainly non-empty.
        const branches = repository.size === 0
          ? await githubFetch<Array<{ name: string }>>(
            `/repos/${encodeURIComponent(repository.owner.login)}/${encodeURIComponent(repository.name)}/branches?per_page=1`,
            { token: accessToken, fetch: this.execute, signal },
          )
          : null;
        return {
          installation_id: installationId,
          repository_id: String(repository.id),
          owner: repository.owner.login,
          name: repository.name,
          full_name: repository.full_name,
          html_url: repository.html_url,
          default_branch: repository.default_branch || null,
          private: repository.private,
          empty: branches?.length === 0,
        };
      },
    );
    return candidates.sort((a, b) => a.full_name.localeCompare(b.full_name));
  }

  async installations(accessToken: string): Promise<GitHubInstallation[]> {
    const installations = await collectGitHubPages(async (page) => {
      const response = await githubFetch<{ total_count?: number; installations: Array<{
        id: number;
        account: { login: string; type: "User" | "Organization"; avatar_url: string | null };
      }> }>(`/user/installations?per_page=${LIST_PAGE_SIZE}&page=${page}`, { token: accessToken, fetch: this.execute });
      return {
        items: response.installations,
        totalCount: typeof response.total_count === "number" ? response.total_count : null,
      };
    });
    return installations.map((installation) => ({
      installation_id: String(installation.id),
      owner: installation.account.login,
      owner_type: installation.account.type,
      avatar_url: installation.account.avatar_url,
    })).sort((a, b) => a.owner.localeCompare(b.owner));
  }

  async createRepository(input: { accessToken: string; installationId: string; owner: string; userLogin: string; name: string; private: boolean }): Promise<GitHubRepositoryCandidate> {
    const path = input.owner.toLowerCase() === input.userLogin.toLowerCase() ? "/user/repos" : `/orgs/${encodeURIComponent(input.owner)}/repos`;
    const repo = await githubFetch<{
      id: number; name: string; full_name: string; html_url: string; private: boolean; default_branch: string | null; owner: { login: string };
    }>(path, { token: input.accessToken, fetch: this.execute, body: {
      name: input.name, private: input.private, auto_init: false,
      description: "Agent skills mirrored from Companion",
    } });
    return {
      installation_id: input.installationId, repository_id: String(repo.id), owner: repo.owner.login,
      name: repo.name, full_name: repo.full_name, html_url: repo.html_url,
      default_branch: repo.default_branch || null, private: repo.private, empty: true,
    };
  }
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number, signal: AbortSignal) => Promise<R>,
): Promise<R[]> {
  const output = new Array<R>(items.length);
  let cursor = 0;
  let failed = false;
  let failure: unknown;
  const controller = new AbortController();
  const workers = Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, async () => {
    while (!failed && cursor < items.length) {
      const index = cursor;
      cursor += 1;
      try {
        output[index] = await fn(items[index]!, index, controller.signal);
      } catch (error) {
        if (!failed) {
          failed = true;
          failure = error;
          controller.abort(error);
        }
      }
    }
  });
  await Promise.allSettled(workers);
  if (failed) throw failure;
  return output;
}

export const COMPANION_README_START = "<!-- COMPANION:START -->";
export const COMPANION_README_END = "<!-- COMPANION:END -->";

const MAX_README_BYTES = 1024 * 1024;
const MANIFEST_PATH = ".companion-sync.json";
const SKILL_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

interface GitHubTreeEntry {
  path: string;
  mode: "100644" | "100755" | "040000" | "160000" | "120000";
  type: "blob" | "tree" | "commit";
  sha: string;
  size?: number;
}

interface GitHubTreeResponse {
  sha: string;
  tree: GitHubTreeEntry[];
  truncated?: boolean;
}

interface TrustedRepositoryState {
  managedSlugs: Set<string>;
  ownershipKnown: boolean;
  readme: Buffer | null;
}

function countOccurrences(value: Buffer, needle: Buffer): number {
  let count = 0;
  let cursor = 0;
  while (cursor <= value.length - needle.length) {
    const index = value.indexOf(needle, cursor);
    if (index < 0) break;
    count += 1;
    cursor = index + needle.length;
  }
  return count;
}

function assertReadableMarkdown(value: Buffer): void {
  if (value.byteLength > MAX_README_BYTES) throw new Error("GitHub README exceeds the 1 MB safety limit");
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch {
    throw new Error("GitHub README is not valid UTF-8");
  }
}

/** Replace the sole managed block while preserving every byte outside it. */
export function mergeCompanionReadme(input: {
  current: Buffer | null;
  managedBlock: Buffer;
  trustedPrevious?: Buffer | null;
}): Buffer {
  const current = input.current ?? Buffer.alloc(0);
  assertReadableMarkdown(current);
  const start = Buffer.from(COMPANION_README_START);
  const end = Buffer.from(COMPANION_README_END);
  const starts = countOccurrences(current, start);
  const ends = countOccurrences(current, end);
  const startIndex = current.indexOf(start);
  const endIndex = current.indexOf(end);

  if (starts !== ends || starts > 1 || (starts === 1 && startIndex > endIndex)) {
    throw new Error("GitHub README has invalid Companion markers; keep exactly one ordered START/END pair");
  }
  let merged: Buffer;
  if (starts === 1) {
    merged = Buffer.concat([
      current.subarray(0, startIndex),
      input.managedBlock,
      current.subarray(endIndex + end.length),
    ]);
  } else if (!current.toString("utf8").trim() || (input.trustedPrevious && current.equals(input.trustedPrevious))) {
    merged = Buffer.concat([input.managedBlock, Buffer.from("\n")]);
  } else {
    const separator = current.subarray(Math.max(0, current.length - 2)).equals(Buffer.from("\n\n"))
      ? ""
      : current.subarray(Math.max(0, current.length - 1)).equals(Buffer.from("\n")) ? "\n" : "\n\n";
    merged = Buffer.concat([current, Buffer.from(separator), input.managedBlock, Buffer.from("\n")]);
  }
  assertReadableMarkdown(merged);
  return merged;
}

function readmeEntry(entries: GitHubTreeEntry[]): GitHubTreeEntry | null {
  const matches = entries.filter((entry) => entry.path.toLowerCase() === "readme.md");
  if (matches.length > 1) throw new Error("GitHub repository contains multiple README.md case variants");
  const entry = matches[0];
  if (!entry) return null;
  if (entry.type !== "blob" || entry.mode === "120000") {
    throw new Error("GitHub README.md must be a regular file, not a symlink, tree, or submodule");
  }
  return entry;
}

function parseManagedSlugs(value: Buffer | null): { slugs: Set<string>; valid: boolean } {
  if (!value || value.byteLength > MAX_README_BYTES) return { slugs: new Set(), valid: false };
  try {
    const parsed = JSON.parse(value.toString("utf8")) as { schema?: unknown; skills?: unknown };
    if (parsed.schema !== 1 || !Array.isArray(parsed.skills)) return { slugs: new Set(), valid: false };
    const slugs = new Set<string>();
    for (const item of parsed.skills) {
      const slug = item && typeof item === "object" && "slug" in item ? (item as { slug?: unknown }).slug : null;
      if (typeof slug !== "string" || !SKILL_SLUG.test(slug) || slugs.has(slug)) {
        return { slugs: new Set(), valid: false };
      }
      slugs.add(slug);
    }
    return { slugs, valid: true };
  } catch {
    return { slugs: new Set(), valid: false };
  }
}

export class GitHubAppClient {
  constructor(public readonly config: GitHubAppConfig, private readonly execute: typeof fetch = globalThis.fetch) {}

  async installationToken(installationId: string, signal?: AbortSignal): Promise<string> {
    const response = await githubFetch<{ token: string }>(`/app/installations/${encodeURIComponent(installationId)}/access_tokens`, {
      token: appJwt(this.config), fetch: this.execute, signal, body: {},
    });
    return response.token;
  }

  async writeRepository(input: {
    installationId: string;
    repositoryId: string;
    owner: string;
    repo: string;
    branch: string;
    files: GitHubTreeFile[];
    manifest?: Buffer;
    readmeBlock?: Buffer;
    managedSlugs?: string[];
    previousCommitSha?: string | null;
    message: string;
    signal?: AbortSignal;
    assertFence?: () => Promise<void>;
    finalize?: (publication: {
      commitSha: string | null;
      branch: string;
      publish: (signal?: AbortSignal) => Promise<void>;
    }) => Promise<void>;
  }): Promise<{ commitSha: string | null; branch: string }> {
    await input.assertFence?.();
    const token = await this.installationToken(input.installationId, input.signal);
    const getTree = async (sha: string): Promise<GitHubTreeResponse> => {
      const result = await githubFetch<GitHubTreeResponse>(
        `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/git/trees/${encodeURIComponent(sha)}`,
        { token, fetch: this.execute, signal: input.signal },
      );
      if (result.truncated) throw new Error("GitHub managed tree is too large to synchronize safely");
      return result;
    };
    const getBlob = async (sha: string, maximumBytes = MAX_README_BYTES): Promise<Buffer> => {
      const blob = await githubFetch<{ content: string; encoding: string; size?: number }>(
        `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/git/blobs/${encodeURIComponent(sha)}`,
        { token, fetch: this.execute, signal: input.signal },
      );
      if (blob.encoding !== "base64" || (blob.size ?? 0) > maximumBytes) {
        throw new Error("GitHub managed file exceeds its safety limit or has an unsupported encoding");
      }
      const encoded = blob.content.replaceAll("\n", "");
      if (encoded.length > Math.ceil(maximumBytes / 3) * 4 + 4) {
        throw new Error("GitHub managed file exceeds its safety limit");
      }
      const value = Buffer.from(encoded, "base64");
      if (value.byteLength > maximumBytes) throw new Error("GitHub managed file exceeds its safety limit");
      return value;
    };
    const loadTrustedState = async (headSha: string): Promise<TrustedRepositoryState> => {
      if (!input.previousCommitSha) return { managedSlugs: new Set(), ownershipKnown: true, readme: null };
      try {
        if (input.previousCommitSha !== headSha) {
          const comparison = await githubFetch<{ status: string }>(
            `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/compare/${encodeURIComponent(input.previousCommitSha)}...${encodeURIComponent(headSha)}`,
            { token, fetch: this.execute, signal: input.signal },
          );
          if (!new Set(["ahead", "identical"]).has(comparison.status)) {
            return { managedSlugs: new Set(), ownershipKnown: false, readme: null };
          }
        }
        const commit = await githubFetch<{ tree: { sha: string } }>(
          `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/git/commits/${encodeURIComponent(input.previousCommitSha)}`,
          { token, fetch: this.execute, signal: input.signal },
        );
        const root = await getTree(commit.tree.sha);
        const manifestEntry = root.tree.find((entry) => entry.path === MANIFEST_PATH && entry.type === "blob");
        const previousReadmeEntry = readmeEntry(root.tree);
        const [manifest, previousReadme] = await Promise.all([
          manifestEntry ? getBlob(manifestEntry.sha) : Promise.resolve(null),
          previousReadmeEntry ? getBlob(previousReadmeEntry.sha) : Promise.resolve(null),
        ]);
        const ownership = parseManagedSlugs(manifest);
        return { managedSlugs: ownership.slugs, ownershipKnown: ownership.valid, readme: previousReadme };
      } catch (error) {
        if (error instanceof GitHubApiError && [404, 409].includes(error.status)) {
          return { managedSlugs: new Set(), ownershipKnown: false, readme: null };
        }
        throw error;
      }
    };
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await input.assertFence?.();
      const repo = await githubFetch<{ id: number; default_branch: string | null }>(`/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}`, {
        token, fetch: this.execute, signal: input.signal,
      });
      if (String(repo.id) !== input.repositoryId) {
        throw new Error("GitHub repository identity changed; reconnect this mirror to the intended repository");
      }
      const branch = repo.default_branch || input.branch || "main";
      let parent: string | null = null;
      let currentTree: string | null = null;
      let currentRoot: GitHubTreeResponse | null = null;
      let repositoryEmpty = false;
      try {
        const ref = await githubFetch<{ object: { sha: string } }>(`/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/git/ref/heads/${encodeURIComponent(branch)}`, { token, fetch: this.execute, signal: input.signal });
        parent = ref.object.sha;
        const commit = await githubFetch<{ tree: { sha: string } }>(`/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/git/commits/${parent}`, { token, fetch: this.execute, signal: input.signal });
        currentTree = commit.tree.sha;
        if (input.readmeBlock || input.managedSlugs) currentRoot = await getTree(currentTree);
      } catch (error) {
        if (!(error instanceof GitHubApiError) || ![404, 409].includes(error.status)) throw error;
        const branches = await githubFetch<Array<{ name: string }>>(
          `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/branches?per_page=1`,
          { token, fetch: this.execute, signal: input.signal },
        );
        repositoryEmpty = branches.length === 0;
      }
      if (repositoryEmpty) {
        await input.assertFence?.();
        const bootstrap = async (signal: AbortSignal | undefined): Promise<void> => {
          const bootstrapManifest = signedOwnershipManifest(this.config, {
            repositoryId: input.repositoryId,
            previousCommitSha: input.previousCommitSha ?? null,
            managedSlugs: [],
            manifest: Buffer.from('{"schema":1,"skills":[]}\n'),
          });
          await githubFetch(`/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/contents/${MANIFEST_PATH}`, {
            token,
            fetch: this.execute,
            signal,
            method: "PUT",
            body: {
              message: "chore(companion): initialize managed mirror",
              content: bootstrapManifest.toString("base64"),
            },
          });
          // GitHub refuses Create Reference while a repository has no branches. The Contents API
          // creates the first branch; retry so the final root-tree commit is its fast-forward child.
          throw new GitHubEmptyRepositoryBootstrapped();
        };
        try {
          if (input.finalize) await input.finalize({ commitSha: null, branch, publish: bootstrap });
          else await bootstrap(input.signal);
        } catch (error) {
          if (attempt < 2 && (
            error instanceof GitHubEmptyRepositoryBootstrapped
            || (error instanceof GitHubApiError && [409, 422].includes(error.status))
          )) continue;
          if (error instanceof GitHubEmptyRepositoryBootstrapped) {
            throw new Error("GitHub empty repository initialization is not yet visible; synchronization will retry");
          }
          throw error;
        }
        throw new Error("GitHub empty repository initialization did not request a retry");
      }
      await input.assertFence?.();
      const managedSlugs = new Set(input.managedSlugs ?? []);
      const trusted = input.readmeBlock || input.managedSlugs
        ? await loadTrustedState(parent!)
        : { managedSlugs: new Set<string>(), ownershipKnown: true, readme: null };
      const rootEntries = currentRoot?.tree ?? [];
      const currentManifestEntry = rootEntries.find((entry) => entry.path === MANIFEST_PATH && entry.type === "blob");
      const currentManifest = currentManifestEntry ? await getBlob(currentManifestEntry.sha) : null;
      const pendingOwnership = verifiedPendingOwnership(this.config, {
        repositoryId: input.repositoryId,
        expectedPreviousCommitSha: input.previousCommitSha ?? null,
        manifest: currentManifest,
      });
      if (pendingOwnership) {
        for (const slug of pendingOwnership) trusted.managedSlugs.add(slug);
      }
      const currentReadmeEntry = input.readmeBlock ? readmeEntry(rootEntries) : null;
      const currentReadme = currentReadmeEntry ? await getBlob(currentReadmeEntry.sha) : null;
      const readme = input.readmeBlock ? mergeCompanionReadme({
        current: currentReadme,
        managedBlock: input.readmeBlock,
        trustedPrevious: trusted.readme,
      }) : null;
      const skillsRoot = rootEntries.find((entry) => entry.path === "skills");
      let currentSkillEntries: GitHubTreeEntry[] = [];
      if (skillsRoot) {
        if (skillsRoot.type !== "tree") {
          if (managedSlugs.size) throw new Error("GitHub path skills conflicts with the Companion skill directory");
        } else {
          currentSkillEntries = (await getTree(skillsRoot.sha)).tree;
        }
      }
      const currentSkillNames = new Set(currentSkillEntries.map((entry) => entry.path));
      const collisions = [...managedSlugs].filter((slug) => currentSkillNames.has(slug) && !trusted.managedSlugs.has(slug));
      if (collisions.length > 0) {
        const suffix = trusted.ownershipKnown ? "is not owned by this mirror" : "has no trusted ownership history";
        throw new Error(`GitHub path skills/${collisions[0]} ${suffix}; move or remove it before synchronizing`);
      }

      const reusableManifest = input.manifest && manifestProjectionMatches(currentManifest, input.manifest)
        && verifiedPendingOwnership(this.config, { repositoryId: input.repositoryId, manifest: currentManifest });
      let projectedManifest = input.manifest
        ? reusableManifest ? currentManifest! : signedOwnershipManifest(this.config, {
          repositoryId: input.repositoryId,
          previousCommitSha: input.previousCommitSha ?? null,
          managedSlugs: input.managedSlugs ?? [],
          manifest: input.manifest,
        })
        : null;

      const extraFiles: GitHubTreeFile[] = [
        ...(projectedManifest ? [{ path: MANIFEST_PATH, data: projectedManifest, executable: false }] : []),
        ...(readme ? [{ path: currentReadmeEntry?.path ?? "README.md", data: readme, executable: false }] : []),
      ];
      const blobs = await mapWithConcurrency([...input.files, ...extraFiles], 6, async (file, _index, signal) => ({
        file,
        blob: await githubFetch<{ sha: string }>(`/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/git/blobs`, {
          token, fetch: this.execute,
          signal: input.signal ? AbortSignal.any([input.signal, signal]) : signal,
          body: { content: file.data.toString("base64"), encoding: "base64" },
        }),
      }));
      await input.assertFence?.();
      const blobByPath = new Map(blobs.map(({ file, blob }) => [file.path, blob.sha]));
      const skillTrees = managedSlugs.size ? await mapWithConcurrency([...managedSlugs], 6, async (slug, _index, signal) => {
        const prefix = `skills/${slug}/`;
        const skillFiles = input.files.filter((file) => file.path.startsWith(prefix));
        const result = await githubFetch<{ sha: string }>(`/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/git/trees`, {
          token,
          fetch: this.execute,
          signal: input.signal ? AbortSignal.any([input.signal, signal]) : signal,
          body: { tree: skillFiles.map((file) => ({
            path: file.path.slice(prefix.length), mode: file.executable ? "100755" : "100644", type: "blob", sha: blobByPath.get(file.path),
          })) },
        });
        return { slug, sha: result.sha };
      }) : [];
      const directFiles = managedSlugs.size
        ? extraFiles
        : [...input.files, ...extraFiles];
      const deletes = [...trusted.managedSlugs]
        .filter((slug) => !managedSlugs.has(slug) && currentSkillNames.has(slug))
        .map((slug) => {
          const existing = currentSkillEntries.find((entry) => entry.path === slug)!;
          return { path: `skills/${slug}`, mode: existing.mode, type: existing.type, sha: null };
        });
      const createRootTree = async (): Promise<{ sha: string }> => githubFetch<{ sha: string }>(`/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/git/trees`, {
        token, fetch: this.execute, signal: input.signal, body: {
          ...(currentTree ? { base_tree: currentTree } : {}),
          tree: [
            ...directFiles.map((file) => ({
              path: file.path, mode: file.executable ? "100755" : "100644", type: "blob", sha: blobByPath.get(file.path),
            })),
            ...skillTrees.map(({ slug, sha }) => ({ path: `skills/${slug}`, mode: "040000", type: "tree", sha })),
            ...deletes,
          ],
        },
      });
      let tree = await createRootTree();
      if (currentTree !== tree.sha && input.manifest && projectedManifest === currentManifest && !pendingOwnership) {
        projectedManifest = signedOwnershipManifest(this.config, {
          repositoryId: input.repositoryId,
          previousCommitSha: input.previousCommitSha ?? null,
          managedSlugs: input.managedSlugs ?? [],
          manifest: input.manifest,
        });
        const refreshedManifestBlob = await githubFetch<{ sha: string }>(`/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/git/blobs`, {
          token, fetch: this.execute, signal: input.signal,
          body: { content: projectedManifest.toString("base64"), encoding: "base64" },
        });
        blobByPath.set(MANIFEST_PATH, refreshedManifestBlob.sha);
        tree = await createRootTree();
      }
      if (currentTree === tree.sha) {
        await input.finalize?.({ commitSha: parent, branch, publish: async () => undefined });
        return { commitSha: parent, branch };
      }
      await input.assertFence?.();
      const commit = await githubFetch<{ sha: string }>(`/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/git/commits`, {
        token, fetch: this.execute, signal: input.signal,
        body: {
          message: input.message,
          tree: tree.sha,
          parents: parent ? [parent] : [],
        },
      });
      try {
        await input.assertFence?.();
        const advanceRef = async (signal: AbortSignal | undefined): Promise<void> => {
          await (parent
            ? githubFetch(`/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/git/refs/heads/${encodeURIComponent(branch)}`, {
            token, fetch: this.execute, signal, method: "PATCH", body: { sha: commit.sha, force: false },
          })
            : githubFetch(`/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/git/refs`, {
            token, fetch: this.execute, signal, body: { ref: `refs/heads/${branch}`, sha: commit.sha },
          }));
        };
        if (input.finalize) await input.finalize({ commitSha: commit.sha, branch, publish: advanceRef });
        else await advanceRef(input.signal);
        return { commitSha: commit.sha, branch };
      } catch (error) {
        if (attempt < 2 && error instanceof GitHubApiError && [409, 422].includes(error.status)) continue;
        throw error;
      }
    }
    throw new Error("GitHub branch changed repeatedly; synchronization will retry");
  }
}

export interface GitHubTreeFile { path: string; data: Buffer; executable: boolean }

export interface RenderedSkillRepository {
  files: GitHubTreeFile[];
  manifest: Buffer;
  readmeBlock: Buffer;
  managedSlugs: string[];
}

const MAX_RENDERED_FILES = 10_000;
const MAX_RENDERED_BYTES = 128 * 1024 * 1024;

export async function renderSkillRepository(input: {
  owner: string; repo: string;
  companionWebUrl: string;
  skills: Array<{
    slug: string; title: string; description: string; shareToken: string;
    version: string; checksum: string; archive: Buffer;
  }>;
  signal?: AbortSignal;
}): Promise<RenderedSkillRepository> {
  const bytewise = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
  const files: GitHubTreeFile[] = [];
  const manifestSkills: Array<{ slug: string; version: string; checksum: string }> = [];
  let renderedBytes = 0;
  for (const skill of [...input.skills].sort((a, b) => bytewise(a.slug, b.slug))) {
    input.signal?.throwIfAborted();
    const canonicalTar = toTar(skill.archive);
    if (skillChecksum(canonicalTar) !== skill.checksum) throw new Error(`skill ${skill.slug} archive checksum does not match its published version`);
    const extracted = await extractArchiveEntryBuffers(canonicalTar);
    if (extracted.oversize || extracted.violations.length) throw new Error(`skill ${skill.slug} archive is unsafe: ${extracted.violations[0] || "oversize"}`);
    const skillMd = extracted.files.map((file) => file.path).filter((path) => path === "SKILL.md" || path.endsWith("/SKILL.md")).sort((a, b) => a.split("/").length - b.split("/").length)[0];
    if (!skillMd) throw new Error(`skill ${skill.slug} has no SKILL.md`);
    const prefix = skillMd === "SKILL.md" ? "" : skillMd.slice(0, -"SKILL.md".length);
    for (const file of extracted.files) {
      input.signal?.throwIfAborted();
      if (prefix && !file.path.startsWith(prefix)) continue;
      const relative = prefix ? file.path.slice(prefix.length) : file.path;
      if (!relative) continue;
      let data = file.data;
      if (relative === "SKILL.md") {
        const parsed = parseFrontmatter(file.data.toString("utf8"));
        if (!parsed.ok) throw new Error(`skill ${skill.slug} has invalid SKILL.md: ${parsed.error}`);
        data = Buffer.from(buildNormalizedSkillMd({ ...parsed.data, name: skill.slug }, parsed.body), "utf8");
      }
      renderedBytes += data.byteLength;
      if (files.length + 1 > MAX_RENDERED_FILES || renderedBytes > MAX_RENDERED_BYTES) {
        throw new Error("GitHub mirror exceeds the rendered repository safety limit");
      }
      files.push({ path: `skills/${skill.slug}/${relative}`, data, executable: file.executable });
    }
    manifestSkills.push({ slug: skill.slug, version: skill.version, checksum: skill.checksum });
  }
  let web: URL;
  try {
    web = new URL(input.companionWebUrl);
  } catch {
    throw new Error("COMPANION_WEB_URL must be an absolute HTTP(S) URL without credentials");
  }
  if (!["http:", "https:"].includes(web.protocol) || web.username || web.password) {
    throw new Error("COMPANION_WEB_URL must be an absolute HTTP(S) URL without credentials");
  }
  const origin = web.origin;
  const escapeHtml = (value: string): string => value
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#39;");
  const summary = (value: string): string => {
    const normalized = value.replace(/\s+/g, " ").trim();
    return normalized.length <= 220 ? normalized : `${normalized.slice(0, 217).trimEnd()}…`;
  };
  const rows = [...input.skills]
    .sort((a, b) => bytewise(a.slug, b.slug))
    .map((skill) => {
      const href = `${origin}/s/${encodeURIComponent(skill.shareToken)}`;
      return `<tr>\n<td><strong><a href="${escapeHtml(href)}">${escapeHtml(skill.title || skill.slug)}</a></strong><br><sub>${escapeHtml(summary(skill.description))}</sub></td>\n<td><code>${escapeHtml(skill.version)}</code></td>\n</tr>`;
    }).join("\n");
  const readme = `${COMPANION_README_START}\n<p align="center">\n  <a href="${escapeHtml(origin)}">\n    <picture>\n      <source media="(prefers-color-scheme: dark)" srcset="${escapeHtml(`${origin}/brand/companion-wordmark-dark.png`)}">\n      <img src="${escapeHtml(`${origin}/brand/companion-wordmark.png`)}" alt="Companion" width="420">\n    </picture>\n  </a>\n</p>\n\n# ${escapeHtml(input.repo)}\n\nA curated library of agent skills, published and kept up to date by [Companion](${escapeHtml(origin)}).\n\n## Install\n\n\`\`\`bash\nnpx skills add ${input.owner}/${input.repo}\n\`\`\`\n\n## Skills\n\n${rows ? `<table>\n<thead><tr><th>Skill</th><th>Version</th></tr></thead>\n<tbody>\n${rows}\n</tbody>\n</table>` : "No skills are currently mirrored."}\n\n---\n\n<sub>Companion manages only the content between the COMPANION markers. Content outside them is preserved.</sub>\n${COMPANION_README_END}`;
  return {
    files: files.sort((a, b) => bytewise(a.path, b.path)),
    manifest: Buffer.from(`${JSON.stringify({ schema: 1, skills: manifestSkills }, null, 2)}\n`, "utf8"),
    readmeBlock: Buffer.from(readme, "utf8"),
    managedSlugs: manifestSkills.map((skill) => skill.slug),
  };
}
