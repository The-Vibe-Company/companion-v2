import { generateKeyPairSync } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { chmod, mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { packDir, parseFrontmatter } from "@companion/skills";
import {
  GitHubApiError,
  GitHubAppClient,
  GitHubOAuthClient,
  githubAppConfig,
  githubOAuthConfig,
  githubSyncEnabled,
  renderSkillRepository,
  type GitHubAppConfig,
  type GitHubOAuthConfig,
} from "./index";

const tempDirs: string[] = [];
const execFile = promisify(execFileCallback);

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function appConfig(privateKey: string): GitHubAppConfig {
  return { appId: "123", privateKey };
}

function oauthConfig(): GitHubOAuthConfig {
  return { slug: "companion", clientId: "client", clientSecret: "secret", name: "Companion", managed: true };
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("GitHub App configuration", () => {
  it("keeps API OAuth and worker App credentials independently fail-closed", () => {
    expect(githubOAuthConfig({ GITHUB_APP_SLUG: "companion" })).toBeNull();
    expect(githubAppConfig({ GITHUB_APP_ID: "1" })).toBeNull();
    expect(githubSyncEnabled({ COMPANION_GITHUB_SYNC_ENABLED: "false" })).toBe(false);
    expect(githubSyncEnabled({ COMPANION_GITHUB_SYNC_ENABLED: "true" })).toBe(true);
  });

  it("accepts operator-owned OAuth metadata without exposing the worker private key to the API", () => {
    const { privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    expect(githubOAuthConfig({
      GITHUB_APP_SLUG: "acme-app", GITHUB_APP_CLIENT_ID: "client", GITHUB_APP_CLIENT_SECRET: "secret",
      GITHUB_APP_NAME: "Acme Skills",
    }))?.toMatchObject({ slug: "acme-app", name: "Acme Skills", managed: false });
    expect(githubAppConfig({
      GITHUB_APP_ID: "1",
      GITHUB_APP_PRIVATE_KEY: privateKey,
    }))?.toMatchObject({ appId: "1" });
  });
});

describe("GitHub App user-to-server calls", () => {
  it("exchanges the App OAuth code and keeps refresh-token expiry metadata", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-20T10:00:00Z"));
    const execute = vi.fn<typeof fetch>().mockResolvedValue(response({
      access_token: "user-token", refresh_token: "refresh-token", expires_in: 28_800, refresh_token_expires_in: 15_552_000,
    }));
    const tokens = await new GitHubOAuthClient(oauthConfig(), execute).exchangeCode("code", "https://companion.test/callback");
    expect(tokens.accessToken).toBe("user-token");
    expect(tokens.refreshToken).toBe("refresh-token");
    expect(tokens.accessExpiresAt?.toISOString()).toBe("2026-07-20T18:00:00.000Z");
    expect(JSON.parse(String(execute.mock.calls[0]?.[1]?.body))).toMatchObject({ client_id: "client", code: "code" });
    vi.useRealTimers();
  });

  it("lists installations even when they contain no repositories", async () => {
    const execute = vi.fn<typeof fetch>().mockResolvedValue(response({ installations: [{
      id: 91, account: { login: "acme", type: "Organization", avatar_url: "https://avatars.test/acme" },
    }] }));
    await expect(new GitHubOAuthClient(oauthConfig(), execute).installations("user-token")).resolves.toEqual([{
      installation_id: "91", owner: "acme", owner_type: "Organization", avatar_url: "https://avatars.test/acme",
    }]);
  });

  it("paginates beyond 100 GitHub App installations", async () => {
    const installations = Array.from({ length: 101 }, (_, index) => ({
      id: index + 1,
      account: {
        login: `owner-${String(index + 1).padStart(3, "0")}`,
        type: "Organization" as const,
        avatar_url: null,
      },
    }));
    const execute = vi.fn<typeof fetch>(async (request) => {
      const page = Number(new URL(String(request)).searchParams.get("page"));
      const start = (page - 1) * 100;
      return response({ total_count: installations.length, installations: installations.slice(start, start + 100) });
    });

    const result = await new GitHubOAuthClient(oauthConfig(), execute).installations("user-token");

    expect(result).toHaveLength(101);
    expect(result.at(-1)).toMatchObject({ installation_id: "101", owner: "owner-101" });
    expect(execute.mock.calls.map(([request]) => String(request))).toEqual([
      "https://api.github.com/user/installations?per_page=100&page=1",
      "https://api.github.com/user/installations?per_page=100&page=2",
    ]);
  });

  it("paginates beyond 100 repositories in one installation", async () => {
    const repositories = Array.from({ length: 101 }, (_, index) => ({
      id: index + 1,
      name: `skill-${String(index + 1).padStart(3, "0")}`,
      full_name: `acme/skill-${String(index + 1).padStart(3, "0")}`,
      html_url: `https://github.com/acme/skill-${String(index + 1).padStart(3, "0")}`,
      private: true,
      default_branch: "main",
      owner: { login: "acme" },
    }));
    const execute = vi.fn<typeof fetch>(async (request) => {
      const url = new URL(String(request));
      if (url.pathname === "/user/installations") {
        return response({ total_count: 1, installations: [{ id: 91 }] });
      }
      const page = Number(url.searchParams.get("page"));
      const start = (page - 1) * 100;
      return response({ total_count: repositories.length, repositories: repositories.slice(start, start + 100) });
    });

    const result = await new GitHubOAuthClient(oauthConfig(), execute).repositories("user-token");

    expect(result).toHaveLength(101);
    expect(result.at(-1)).toMatchObject({ repository_id: "101", full_name: "acme/skill-101" });
    expect(execute.mock.calls.map(([request]) => String(request))).toContain(
      "https://api.github.com/user/installations/91/repositories?per_page=100&page=2",
    );
  });

  it("paginates installations during repository discovery and bounds its concurrency", async () => {
    let active = 0;
    let maxActive = 0;
    const installations = Array.from({ length: 101 }, (_, index) => ({ id: index + 1 }));
    const execute = vi.fn<typeof fetch>(async (request) => {
      const url = new URL(String(request));
      if (url.pathname === "/user/installations") {
        const page = Number(url.searchParams.get("page"));
        const start = (page - 1) * 100;
        return response({ total_count: installations.length, installations: installations.slice(start, start + 100) });
      }
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active -= 1;
      if (url.pathname === "/user/installations/101/repositories") {
        return response({ total_count: 1, repositories: [{
          id: 700,
          name: "skills",
          full_name: "last-owner/skills",
          html_url: "https://github.com/last-owner/skills",
          private: true,
          default_branch: "main",
          owner: { login: "last-owner" },
        }] });
      }
      return response({ total_count: 0, repositories: [] });
    });

    const result = await new GitHubOAuthClient(oauthConfig(), execute).repositories("user-token");

    expect(result).toEqual([expect.objectContaining({ installation_id: "101", repository_id: "700" })]);
    expect(maxActive).toBeGreaterThan(1);
    expect(maxActive).toBeLessThanOrEqual(6);
  });

  it("requires overwrite confirmation for a repository with a default branch even when GitHub rounds its size to zero", async () => {
    const execute = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response({ installations: [{ id: 91 }] }))
      .mockResolvedValueOnce(response({ repositories: [{
        id: 7,
        name: "skills",
        full_name: "acme/skills",
        html_url: "https://github.com/acme/skills",
        private: true,
        default_branch: "main",
        size: 0,
        owner: { login: "acme" },
      }] }))
      .mockResolvedValueOnce(response([{ name: "main" }]));

    await expect(new GitHubOAuthClient(oauthConfig(), execute).repositories("user-token")).resolves.toEqual([
      expect.objectContaining({ full_name: "acme/skills", empty: false }),
    ]);
  });

  it("recognizes a truly empty repository even when GitHub reports a default branch name", async () => {
    const execute = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response({ installations: [{ id: 91 }] }))
      .mockResolvedValueOnce(response({ repositories: [{
        id: 7,
        name: "skills",
        full_name: "acme/skills",
        html_url: "https://github.com/acme/skills",
        private: true,
        default_branch: "main",
        size: 0,
        owner: { login: "acme" },
      }] }))
      .mockResolvedValueOnce(response([]));

    await expect(new GitHubOAuthClient(oauthConfig(), execute).repositories("user-token")).resolves.toEqual([
      expect.objectContaining({ full_name: "acme/skills", default_branch: "main", empty: true }),
    ]);
    expect(execute.mock.calls[2]?.[0]).toBe("https://api.github.com/repos/acme/skills/branches?per_page=1");
  });

  it("creates private repositories with the authenticated App user token", async () => {
    const execute = vi.fn<typeof fetch>().mockResolvedValue(response({
      id: 7, name: "skills", full_name: "acme/skills", html_url: "https://github.com/acme/skills",
      private: true, default_branch: null, owner: { login: "acme" },
    }));
    const repository = await new GitHubOAuthClient(oauthConfig(), execute).createRepository({
      accessToken: "user-token", installationId: "91", owner: "acme", userLogin: "stan", name: "skills", private: true,
    });
    expect(repository).toMatchObject({ full_name: "acme/skills", private: true, empty: true });
    expect(execute.mock.calls[0]?.[0]).toBe("https://api.github.com/orgs/acme/repos");
    expect(JSON.parse(String(execute.mock.calls[0]?.[1]?.body))).toMatchObject({ private: true, auto_init: false });
  });

  it("surfaces rate-limit and branch-protection errors without hiding GitHub's action", async () => {
    const execute = vi.fn<typeof fetch>().mockResolvedValue(response({ message: "API rate limit exceeded" }, 403));
    await expect(new GitHubOAuthClient(oauthConfig(), execute).user("token")).rejects.toEqual(
      expect.objectContaining<Partial<GitHubApiError>>({ status: 403, message: "API rate limit exceeded" }),
    );
  });

  it("revokes only the stored user access token with API-side OAuth credentials", async () => {
    const execute = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    await new GitHubOAuthClient(oauthConfig(), execute).revokeUserToken("user-token");
    expect(execute.mock.calls[0]?.[0]).toBe("https://api.github.com/applications/client/token");
    expect(execute.mock.calls[0]?.[1]).toMatchObject({ method: "DELETE" });
    expect(new Headers(execute.mock.calls[0]?.[1]?.headers).get("authorization")).toMatch(/^Basic /);
    expect(JSON.parse(String(execute.mock.calls[0]?.[1]?.body))).toEqual({ access_token: "user-token" });
  });
});

describe("deterministic repository renderer", () => {
  it("normalizes wrapper archives, preserves binaries and executable permissions, and is deterministic", async () => {
    const root = await mkdtemp(join(tmpdir(), "companion-github-render-"));
    tempDirs.push(root);
    const wrapped = join(root, "wrapper");
    await mkdir(join(wrapped, "scripts"), { recursive: true });
    await writeFile(join(wrapped, "SKILL.md"), "---\nname: pre-rename\ndescription: Test\n---\n# Wrapped\n");
    await writeFile(join(wrapped, "scripts", "run.sh"), "#!/bin/sh\necho ok\n");
    await chmod(join(wrapped, "scripts", "run.sh"), 0o755);
    await writeFile(join(wrapped, "asset.bin"), Buffer.from([0, 255, 17, 42]));
    const packed = await packDir(root);
    const input = { owner: "acme", repo: "skills", skills: [{ slug: "wrapped", version: "1.2.3", checksum: packed.checksum, archive: packed.archive }] };
    const first = await renderSkillRepository(input);
    const second = await renderSkillRepository(input);
    expect(first).toEqual(second);
    expect(first.map((file) => file.path)).toEqual([
      ".companion-sync.json", "README.md", "skills/wrapped/SKILL.md", "skills/wrapped/asset.bin", "skills/wrapped/scripts/run.sh",
    ]);
    expect(first.find((file) => file.path.endsWith("run.sh"))?.executable).toBe(true);
    expect(first.find((file) => file.path.endsWith("asset.bin"))?.data).toEqual(Buffer.from([0, 255, 17, 42]));
    const renderedFrontmatter = parseFrontmatter(first.find((file) => file.path.endsWith("SKILL.md"))!.data.toString());
    expect(renderedFrontmatter).toMatchObject({ ok: true, data: { name: "wrapped" } });
    expect(first.find((file) => file.path === "README.md")?.data.toString()).toContain("Managed by Companion");
    expect(JSON.parse(first.find((file) => file.path === ".companion-sync.json")!.data.toString())).toEqual({
      schema: 1, skills: [{ slug: "wrapped", version: "1.2.3", checksum: packed.checksum }],
    });
  });

  it("is discovered and installed by the pinned skills@1.5.9 CLI", async () => {
    const root = await mkdtemp(join(tmpdir(), "companion-skills-cli-"));
    tempDirs.push(root);
    const source = join(root, "source");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "SKILL.md"), "---\nname: compatible\ndescription: CLI compatibility test\n---\n# Compatible\n");
    const packed = await packDir(source);
    const repository = join(root, "repository");
    const files = await renderSkillRepository({
      owner: "acme", repo: "skills", skills: [{ slug: "compatible", version: "1.0.0", checksum: packed.checksum, archive: packed.archive }],
    });
    for (const file of files) {
      const path = join(repository, file.path);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, file.data);
      if (file.executable) await chmod(path, 0o755);
    }
    const binary = join(process.cwd(), "node_modules", ".bin", "skills");
    const listed = await execFile(binary, ["add", repository, "--list"], { env: { ...process.env, NO_COLOR: "1" } });
    expect(listed.stdout).toContain("compatible");

    const project = join(root, "consumer");
    await mkdir(project);
    await writeFile(join(project, "package.json"), "{\"private\":true}\n");
    await execFile(binary, ["add", repository, "--skill", "compatible", "--agent", "codex", "--copy", "-y"], {
      cwd: project, env: { ...process.env, NO_COLOR: "1" },
    });
    const installed = await readdir(project, { recursive: true });
    expect(installed.some((path) => path.endsWith("compatible/SKILL.md"))).toBe(true);
  });

  it("rejects an archive whose bytes do not match the persisted checksum", async () => {
    const root = await mkdtemp(join(tmpdir(), "companion-github-checksum-"));
    tempDirs.push(root);
    const original = join(root, "original");
    const altered = join(root, "altered");
    await mkdir(original);
    await mkdir(altered);
    await writeFile(join(original, "SKILL.md"), "---\nname: original\ndescription: Original\n---\n# Original\n");
    await writeFile(join(altered, "SKILL.md"), "---\nname: altered\ndescription: Altered\n---\n# Altered\n");
    const expected = await packDir(original);
    const replacement = await packDir(altered);
    await expect(renderSkillRepository({
      owner: "acme",
      repo: "skills",
      skills: [{ slug: "original", version: "1.0.0", checksum: expected.checksum, archive: replacement.archive }],
    })).rejects.toThrow("archive checksum does not match");
  });
});

describe("atomic Git writes", () => {
  it("creates a root tree and returns a no-op when GitHub already has that exact tree", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
    const bodies = [
      { token: "installation-token" }, { id: 700, default_branch: "main" }, { object: { sha: "old-commit" } },
      { tree: { sha: "same-tree" } }, { sha: "blob" }, { sha: "same-tree" },
    ];
    const execute = vi.fn<typeof fetch>().mockImplementation(async () => response(bodies.shift()));
    const result = await new GitHubAppClient(appConfig(privateKey), execute).writeRepository({
      installationId: "91", repositoryId: "700", owner: "acme", repo: "skills", branch: "main",
      files: [{ path: "README.md", data: Buffer.from("managed"), executable: false }], message: "Sync skills",
    });
    expect(result).toEqual({ commitSha: "old-commit", branch: "main" });
    const treeBody = JSON.parse(String(execute.mock.calls[5]?.[1]?.body));
    expect(treeBody).not.toHaveProperty("base_tree");
    expect(execute).toHaveBeenCalledTimes(6);
  });

  it("refuses a replacement repository at the same owner/name before creating Git objects", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
    const execute = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response({ token: "installation-token" }))
      .mockResolvedValueOnce(response({ id: 701, default_branch: "main" }));
    await expect(new GitHubAppClient(appConfig(privateKey), execute).writeRepository({
      installationId: "91", repositoryId: "700", owner: "acme", repo: "skills", branch: "main",
      files: [{ path: "README.md", data: Buffer.from("managed"), executable: false }], message: "Sync skills",
    })).rejects.toThrow("repository identity changed");
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("bootstraps a truly empty repository before publishing the managed tree as a fast-forward", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
    let refReads = 0;
    const commitParents: string[][] = [];
    const finalizedCommits: Array<string | null> = [];
    const execute = vi.fn<typeof fetch>(async (request, init) => {
      const url = String(request);
      const method = init?.method ?? (init?.body ? "POST" : "GET");
      if (url.endsWith("/access_tokens")) return response({ token: "installation-token" });
      if (url === "https://api.github.com/repos/acme/skills") return response({ id: 700, default_branch: "main" });
      if (url.includes("/git/ref/heads/") && method === "GET") {
        refReads += 1;
        return refReads === 1
          ? response({ message: "Git Repository is empty" }, 409)
          : response({ object: { sha: "bootstrap-commit" } });
      }
      if (url.endsWith("/branches?per_page=1")) return response([]);
      if (url.endsWith("/contents/.companion-bootstrap") && method === "PUT") {
        return response({ commit: { sha: "bootstrap-commit" } }, 201);
      }
      if (url.endsWith("/git/commits/bootstrap-commit") && method === "GET") {
        return response({ tree: { sha: "bootstrap-tree" } });
      }
      if (url.endsWith("/git/blobs")) return response({ sha: "managed-blob" });
      if (url.endsWith("/git/trees")) return response({ sha: "managed-tree" });
      if (url.endsWith("/git/commits") && method === "POST") {
        const body = JSON.parse(String(init?.body)) as { parents: string[] };
        commitParents.push(body.parents);
        return response({ sha: "managed-commit" });
      }
      if (url.includes("/git/refs/heads/") && method === "PATCH") return response({});
      throw new Error(`unexpected GitHub request: ${method} ${url}`);
    });

    const result = await new GitHubAppClient(appConfig(privateKey), execute).writeRepository({
      installationId: "91",
      repositoryId: "700",
      owner: "acme",
      repo: "skills",
      branch: "main",
      files: [{ path: "README.md", data: Buffer.from("managed"), executable: false }],
      message: "Sync skills",
      finalize: async (publication) => {
        finalizedCommits.push(publication.commitSha);
        await publication.publish();
      },
    });

    expect(result).toEqual({ commitSha: "managed-commit", branch: "main" });
    expect(finalizedCommits).toEqual([null, "managed-commit"]);
    expect(commitParents).toEqual([["bootstrap-commit"]]);
    const bootstrapCall = execute.mock.calls.find(([request]) => String(request).endsWith("/contents/.companion-bootstrap"));
    expect(JSON.parse(String(bootstrapCall?.[1]?.body))).toEqual({
      message: "chore(companion): initialize managed mirror",
      content: Buffer.from("Managed by Companion\n").toString("base64"),
    });
    const refUpdate = execute.mock.calls.find(([request, init]) =>
      String(request).includes("/git/refs/heads/") && init?.method === "PATCH",
    );
    expect(JSON.parse(String(refUpdate?.[1]?.body))).toEqual({ sha: "managed-commit", force: false });
    expect(execute.mock.calls.some(([request]) => String(request).endsWith("/git/refs"))).toBe(false);
  });

  it("aborts and settles active blob uploads before a failed pool returns", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
    let blobStarts = 0;
    const execute = vi.fn<typeof fetch>(async (request, init) => {
      const url = String(request);
      if (url.endsWith("/access_tokens")) return response({ token: "installation-token" });
      if (url === "https://api.github.com/repos/acme/skills") return response({ id: 700, default_branch: "main" });
      if (url.includes("/git/ref/heads/")) return response({ message: "Not Found" }, 404);
      if (url.endsWith("/branches?per_page=1")) return response([{ name: "other" }]);
      if (url.endsWith("/git/blobs")) {
        blobStarts += 1;
        if (blobStarts === 1) return response({ message: "blob failed" }, 500);
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason ?? new Error("aborted")), { once: true });
        });
      }
      throw new Error(`unexpected GitHub request: ${url}`);
    });
    const files = Array.from({ length: 20 }, (_, index) => ({
      path: `skills/test/file-${index}.txt`, data: Buffer.from(String(index)), executable: false,
    }));
    await expect(new GitHubAppClient(appConfig(privateKey), execute).writeRepository({
      installationId: "91", repositoryId: "700", owner: "acme", repo: "skills", branch: "main",
      files, message: "Sync skills",
    })).rejects.toThrow("blob failed");
    const startsWhenRejected = blobStarts;
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(blobStarts).toBe(startsWhenRejected);
    expect(blobStarts).toBeLessThanOrEqual(6);
  });

  it("rebuilds from the new branch head after a fast-forward race before retrying the publication fence", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
    let observedHead = 0;
    let refUpdates = 0;
    const commitParents: string[][] = [];
    const execute = vi.fn<typeof fetch>(async (request, init) => {
      const url = String(request);
      const method = init?.method ?? (init?.body ? "POST" : "GET");
      if (url.endsWith("/access_tokens")) return response({ token: "installation-token" });
      if (url === "https://api.github.com/repos/acme/skills") return response({ id: 700, default_branch: "main" });
      if (url.includes("/git/ref/heads/") && method === "GET") {
        observedHead += 1;
        return response({ object: { sha: `head-${observedHead}` } });
      }
      if (url.includes("/git/commits/head-") && method === "GET") return response({ tree: { sha: `old-tree-${observedHead}` } });
      if (url.endsWith("/git/blobs")) return response({ sha: `blob-${observedHead}` });
      if (url.endsWith("/git/trees")) return response({ sha: `tree-${observedHead}` });
      if (url.endsWith("/git/commits") && method === "POST") {
        const body = JSON.parse(String(init?.body)) as { parents: string[] };
        commitParents.push(body.parents);
        return response({ sha: `commit-${observedHead}` });
      }
      if (url.includes("/git/refs/heads/") && method === "PATCH") {
        refUpdates += 1;
        return refUpdates === 1 ? response({ message: "Reference update failed" }, 409) : response({});
      }
      throw new Error(`unexpected GitHub request: ${method} ${url}`);
    });
    const assertFence = vi.fn(async () => undefined);

    const result = await new GitHubAppClient(appConfig(privateKey), execute).writeRepository({
      installationId: "91",
      repositoryId: "700",
      owner: "acme",
      repo: "skills",
      branch: "main",
      files: [{ path: "README.md", data: Buffer.from("managed"), executable: false }],
      message: "Sync skills",
      assertFence,
    });

    expect(result).toEqual({ commitSha: "commit-2", branch: "main" });
    expect(commitParents).toEqual([["head-1"], ["head-2"]]);
    expect(refUpdates).toBe(2);
    expect(assertFence.mock.calls.length).toBeGreaterThanOrEqual(6);
    const refBodies = execute.mock.calls
      .filter(([request, init]) => String(request).includes("/git/refs/heads/") && init?.method === "PATCH")
      .map(([, init]) => JSON.parse(String(init?.body)) as { force: boolean });
    expect(refBodies).toEqual([{ sha: "commit-1", force: false }, { sha: "commit-2", force: false }]);
  });
});
