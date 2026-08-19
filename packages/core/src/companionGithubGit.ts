import {
  companionMcpCredentialSchema,
  type CompanionMcpCredential,
} from "@companion/contracts";
import type { CompanionPluginGithubIdentity } from "./companionPluginOAuth";

/**
 * Extra Box environment for a selected GitHub MCP OAuth account. The raw token is for git/gh;
 * MCP keeps using the existing Authorization Bearer binding. Identity values are not secrets.
 */
export function githubGitRuntimeMaterial(input: {
  accessToken: string;
  identity: CompanionPluginGithubIdentity | null | undefined;
  occupiedEnvKeys: Iterable<string>;
}): {
  credentials: CompanionMcpCredential[];
  env: Record<string, string>;
} {
  const occupied = new Set(input.occupiedEnvKeys);
  if (occupied.has("GITHUB_TOKEN") || occupied.has("GH_TOKEN")) {
    return { credentials: [], env: {} };
  }
  const credentials = [
    companionMcpCredentialSchema.parse({ env_key: "GITHUB_TOKEN", value: input.accessToken }),
    companionMcpCredentialSchema.parse({ env_key: "GH_TOKEN", value: input.accessToken }),
  ];
  const env: Record<string, string> = {
    GIT_TERMINAL_PROMPT: "0",
    GH_PROMPT_DISABLED: "1",
  };
  if (input.identity) {
    env.GIT_AUTHOR_NAME = input.identity.name;
    env.GIT_AUTHOR_EMAIL = input.identity.email;
    env.GIT_COMMITTER_NAME = input.identity.name;
    env.GIT_COMMITTER_EMAIL = input.identity.email;
  }
  return { credentials, env };
}
