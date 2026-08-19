import { describe, expect, it } from "vitest";
import { githubGitRuntimeMaterial } from "../src/companionGithubGit";

describe("GitHub MCP git runtime material", () => {
  it("exposes the OAuth token to git and gh without duplicating an existing binding", () => {
    expect(githubGitRuntimeMaterial({
      accessToken: "gho_secret",
      identity: { login: "stan", name: "Stan Girard", email: "stan@users.noreply.github.com" },
      occupiedEnvKeys: ["COMPANION_MCP_TOKEN"],
    })).toEqual({
      credentials: [
        { env_key: "GITHUB_TOKEN", value: "gho_secret" },
        { env_key: "GH_TOKEN", value: "gho_secret" },
      ],
      env: {
        GIT_TERMINAL_PROMPT: "0",
        GH_PROMPT_DISABLED: "1",
        GIT_AUTHOR_NAME: "Stan Girard",
        GIT_AUTHOR_EMAIL: "stan@users.noreply.github.com",
        GIT_COMMITTER_NAME: "Stan Girard",
        GIT_COMMITTER_EMAIL: "stan@users.noreply.github.com",
      },
    });

    expect(githubGitRuntimeMaterial({
      accessToken: "gho_secret",
      identity: { login: "stan", name: "Stan Girard", email: "stan@users.noreply.github.com" },
      occupiedEnvKeys: ["GITHUB_TOKEN"],
    })).toEqual({ credentials: [], env: {} });
  });

  it("still injects git/gh tokens when GitHub identity was not stored", () => {
    expect(githubGitRuntimeMaterial({
      accessToken: "gho_secret",
      identity: null,
      occupiedEnvKeys: [],
    })).toEqual({
      credentials: [
        { env_key: "GITHUB_TOKEN", value: "gho_secret" },
        { env_key: "GH_TOKEN", value: "gho_secret" },
      ],
      env: {
        GIT_TERMINAL_PROMPT: "0",
        GH_PROMPT_DISABLED: "1",
      },
    });
  });
});
