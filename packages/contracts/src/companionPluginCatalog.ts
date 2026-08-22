import { z } from "zod";

/**
 * Stable identifiers for the MCP plugins curated and shipped by Companion. These values remain
 * compatible with already-encrypted OAuth credentials created before the external registry was
 * removed.
 */
export const COMPANION_PLUGIN_OAUTH_SERVER_NAMES = [
  "app.linear/linear",
  "io.github.github/github-mcp-server",
  "com.notion/mcp",
  "build.conductor/mcp",
] as const;
export const companionPluginOAuthServerNameSchema = z.enum(
  COMPANION_PLUGIN_OAUTH_SERVER_NAMES,
);
export type CompanionPluginOAuthServerName = z.infer<
  typeof companionPluginOAuthServerNameSchema
>;

export interface CompanionPluginCatalogEntry {
  server_name: CompanionPluginOAuthServerName;
  provider: "linear" | "github" | "notion" | "conductor";
  title: string;
  description: string;
}

/** Product-owned MCP catalog. Adding or removing an entry requires a Companion release. */
export const COMPANION_PLUGIN_CATALOG = [
  {
    server_name: "app.linear/linear",
    provider: "linear",
    title: "Linear",
    description: "Linear project management and issue tracking.",
  },
  {
    server_name: "io.github.github/github-mcp-server",
    provider: "github",
    title: "GitHub",
    description: "Git clone, commit, and push, plus repositories, issues, and pull requests.",
  },
  {
    server_name: "com.notion/mcp",
    provider: "notion",
    title: "Notion",
    description: "Notion pages, databases, and search.",
  },
  {
    server_name: "build.conductor/mcp",
    provider: "conductor",
    title: "Conductor",
    description: "Conductor cloud workspaces, sessions, and coding agents.",
  },
] as const satisfies readonly CompanionPluginCatalogEntry[];

export const companionPluginOAuthStartInputSchema = z.object({
  server_name: companionPluginOAuthServerNameSchema,
  label: z.string().trim().min(1).max(40),
}).strict();
export type CompanionPluginOAuthStartInput = z.infer<
  typeof companionPluginOAuthStartInputSchema
>;

export const companionPluginOAuthStartResponseSchema = z.object({
  authorization_url: z.string().url(),
}).strict();
export type CompanionPluginOAuthStartResponse = z.infer<
  typeof companionPluginOAuthStartResponseSchema
>;
