/**
 * Product-shipped per-plugin skills, staged into the Box's skills tree when the matching plugin is
 * attached to the Companion. They document what the plugin actually provides — MCP tools, and for
 * triggers the on-demand registration capability — so Pi never reads a capability from a persona
 * line that this runtime does not stage.
 */

export interface CompanionPluginSkill {
  slug: string;
  name: string;
  description: string;
  content: string;
}

const COMMON_TRIGGER_RULES = [
  "## Triggers",
  "",
  "A trigger is a named prompt an external webhook fires into your thread. Creating one is always",
  "owner-approved: propose it with `propose_trigger` (name, prompt, provider, and — where",
  "supported — a target), never claim one is active before approval.",
  "",
  "After the trigger exists you may wire it at the provider yourself with the Companion workspace",
  "API (`POST /v1/companions/<id>/triggers/<triggerId>/registration`, same authority as your other",
  "workspace calls; `DELETE` unwires). Registration is on demand: approval alone never contacts the",
  "provider. A `failed` registration status means the provider refused — read",
  "`last_registration_error`, fix the cause (wrong repo, missing permission, unknown event), and",
  "retry; do not paste URLs by hand unless registration is unavailable for the provider.",
].join("\n");

export const COMPANION_PLUGIN_SKILLS: Array<CompanionPluginSkill & { provider: string }> = [
  {
    provider: "github",
    slug: "plugin-github",
    name: "GitHub plugin",
    description:
      "Use when working with GitHub through the attached GitHub plugin: repositories, issues, pull requests via MCP, committing from this box as the connected account, and registering repository webhook triggers.",
    content: [
      "---",
      "name: github-plugin",
      'description: "Use when working with GitHub through the attached GitHub plugin: browse repositories, issues, and pull requests over MCP tools, commit and push from this box as the connected account, and register repository webhook triggers after owner approval.",',
      'allowed-tools: mcp read_file write_file run_shell',
      "---",
      "",
      "# GitHub plugin",
      "",
      "The GitHub plugin is attached to this Companion. It gives you three things:",
      "",
      "## 1. MCP tools",
      "",
      "Your `mcp`-prefixed GitHub tools reach the connected account's repositories, issues, and pull",
      "requests. What the account can access is exactly what you can access; do not assume more.",
      "",
      "## 2. Commits from this box",
      "",
      "This box carries the connected account's git credentials, so `git clone`, `git commit`, and",
      '`git push` work as that account. Never print, copy, or store the credentials; use git normally',
      "and let the credential helper handle auth. Commit messages follow the repository's own style.",
      "",
      COMMON_TRIGGER_RULES,
      "",
      "For GitHub, a trigger names its target: a `repo` (`owner/repo`) plus the webhook `events` to",
      'watch — `push`, `pull_request`, `issues`, `workflow_run`, ... or `"*"` for every event. Propose',
      "the narrowest event set that answers the request; registration creates the repository hook and",
      "stores the remote hook id, so you can remove it again later instead of leaving it behind.",
      "",
      "Notion-style manual URL pasting is a last resort here: prefer registration, which is",
      "authenticated and reversible.",
    ].join("\n"),
  },
  {
    provider: "linear",
    slug: "plugin-linear",
    name: "Linear plugin",
    description:
      "Use when working with Linear through the attached Linear plugin: issues, projects, and cycles via MCP tools, and proposing issue webhook triggers for owner approval.",
    content: [
      "---",
      "name: linear-plugin",
      'description: "Use when working with Linear through the attached Linear plugin: read and update issues, projects, and cycles through MCP tools, and propose wake-on-issue triggers after owner approval.",',
      'allowed-tools: mcp read_file write_file run_shell',
      "---",
      "",
      "# Linear plugin",
      "",
      "The Linear plugin is attached to this Companion. It gives you:",
      "",
      "## MCP tools",
      "",
      "Your `mcp`-prefixed Linear tools read and write the issues, projects, and cycles the connected",
      "account can reach. Treat ticket writes like any consequential action: confirm scope when the",
      "request is ambiguous.",
      "",
      COMMON_TRIGGER_RULES,
      "",
      "Linear trigger targets are not supported yet, and registration needs a Linear API key stored",
      'with the plugin. If registration reports that key missing, say so plainly — the person pastes',
      "the webhook URL into Linear's webhook settings or stores the key first — and never claim the",
      "trigger will fire before the wiring actually exists.",
    ].join("\n"),
  },
];
