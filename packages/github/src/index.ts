import { createSign } from "node:crypto";
import type { GitHubInstallation, GitHubRepositoryCandidate } from "@companion/contracts";
import { buildNormalizedSkillMd, extractArchiveEntryBuffers, parseFrontmatter, skillChecksum, toTar } from "@companion/skills";

const API = "https://api.github.com";
const WEB = "https://github.com";
const API_VERSION = "2022-11-28";
const LIST_PAGE_SIZE = 100;
const REPOSITORY_LIST_CONCURRENCY = 6;

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
      let repositoryEmpty = false;
      try {
        const ref = await githubFetch<{ object: { sha: string } }>(`/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/git/ref/heads/${encodeURIComponent(branch)}`, { token, fetch: this.execute, signal: input.signal });
        parent = ref.object.sha;
        const commit = await githubFetch<{ tree: { sha: string } }>(`/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/git/commits/${parent}`, { token, fetch: this.execute, signal: input.signal });
        currentTree = commit.tree.sha;
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
          await githubFetch(`/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/contents/.companion-bootstrap`, {
            token,
            fetch: this.execute,
            signal,
            method: "PUT",
            body: {
              message: "chore(companion): initialize managed mirror",
              content: Buffer.from("Managed by Companion\n", "utf8").toString("base64"),
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
      const blobs = await mapWithConcurrency(input.files, 6, async (file, _index, signal) => ({
        file,
        blob: await githubFetch<{ sha: string }>(`/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/git/blobs`, {
          token, fetch: this.execute,
          signal: input.signal ? AbortSignal.any([input.signal, signal]) : signal,
          body: { content: file.data.toString("base64"), encoding: "base64" },
        }),
      }));
      await input.assertFence?.();
      const tree = await githubFetch<{ sha: string }>(`/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/git/trees`, {
        token, fetch: this.execute, signal: input.signal, body: { tree: blobs.map(({ file, blob }) => ({
          path: file.path, mode: file.executable ? "100755" : "100644", type: "blob", sha: blob.sha,
        })) },
      });
      if (currentTree === tree.sha) {
        await input.finalize?.({ commitSha: parent, branch, publish: async () => undefined });
        return { commitSha: parent, branch };
      }
      await input.assertFence?.();
      const commit = await githubFetch<{ sha: string }>(`/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/git/commits`, {
        token, fetch: this.execute, signal: input.signal,
        body: { message: input.message, tree: tree.sha, parents: parent ? [parent] : [] },
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

const MAX_RENDERED_FILES = 10_000;
const MAX_RENDERED_BYTES = 128 * 1024 * 1024;

export async function renderSkillRepository(input: {
  owner: string; repo: string;
  skills: Array<{ slug: string; version: string; checksum: string; archive: Buffer }>;
  signal?: AbortSignal;
}): Promise<GitHubTreeFile[]> {
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
  const install = `npx skills add ${input.owner}/${input.repo}`;
  const readme = `# ${input.repo}\n\n> Managed by Companion. Changes pushed directly to GitHub are overwritten.\n\nInstall these skills with:\n\n\`\`\`bash\n${install}\n\`\`\`\n\n## Skills\n\n${manifestSkills.map((skill) => `- **${skill.slug}** — \`${skill.version}\``).join("\n") || "No skills are currently mirrored."}\n`;
  files.unshift(
    { path: "README.md", data: Buffer.from(readme, "utf8"), executable: false },
    { path: ".companion-sync.json", data: Buffer.from(`${JSON.stringify({ schema: 1, skills: manifestSkills }, null, 2)}\n`, "utf8"), executable: false },
  );
  return files.sort((a, b) => bytewise(a.path, b.path));
}
