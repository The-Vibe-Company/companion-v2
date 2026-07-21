import type { SkillIcon, SkillRequirement } from "@companion/contracts";

export interface SeedSkillFile {
  path: string;
  content: string;
}

export interface SeedSkillVersionSpec {
  version: string;
  description: string;
  body: string;
  tools?: string[];
  license?: string;
  dependencies?: string[];
  requirements?: SkillRequirement[];
  title?: string;
  icon?: SkillIcon;
  notes?: string;
  files?: SeedSkillFile[];
}

export interface SeedSkillSpec {
  slug: string;
  scope: "org" | "personal";
  labels?: string[];
  versions: SeedSkillVersionSpec[];
}

const singleVersion = (
  slug: string,
  version: SeedSkillVersionSpec,
  options: Pick<SeedSkillSpec, "scope" | "labels"> = { scope: "org" },
): SeedSkillSpec => ({ slug, ...options, versions: [version] });

export const DEMO_SKILL_CATALOG: SeedSkillSpec[] = [
  singleVersion(
    "markdown-report",
    {
      version: "2.1.0",
      description: "Render structured findings into a clean Markdown report.",
      body: "# markdown-report\n\nRenders structured findings into a clean Markdown report.",
      tools: ["read_file"],
      license: "MIT",
    },
    { scope: "org", labels: ["reporting", "engineering/tools"] },
  ),
  singleVersion(
    "log-parser",
    {
      version: "1.4.0",
      description: "Parse heterogeneous log formats into a normalized event stream.",
      body: "# log-parser\n\nParses heterogeneous log formats into a normalized event stream.",
      tools: ["read_file"],
      license: "MIT",
    },
    { scope: "org", labels: ["engineering/tools"] },
  ),
  singleVersion(
    "diff-tools",
    {
      version: "0.9.4",
      description: "Compute and present structured diffs across files and revisions.",
      body: "# diff-tools\n\nComputes and presents structured diffs across files and revisions.",
      tools: ["read_file"],
      license: "MIT",
    },
    { scope: "org", labels: ["engineering/tools"] },
  ),
  singleVersion(
    "slack-notify",
    {
      version: "1.2.0",
      description: "Post a formatted notification to a Slack channel.",
      body: "# slack-notify\n\nPosts a formatted notification to a Slack channel.",
      tools: ["run_python"],
      license: "MIT",
      title: "Slack notifications",
      icon: "message-square",
      notes: "## Setup\n\nConnect a Slack bot token, then optionally choose a default channel.",
      requirements: [
        {
          key: "SLACK_BOT_TOKEN",
          type: "secret",
          slot_id: "11111111-1111-4111-8111-111111111111",
          required: true,
          note: "Slack bot token (xoxb-…). Ask a workspace admin to install the Companion app, or create one at https://api.slack.com/apps → OAuth & Permissions.",
        },
        {
          key: "SLACK_DEFAULT_CHANNEL",
          type: "env",
          required: false,
          note: "Channel ID to post to when a message does not specify one. Defaults to #general.",
        },
      ],
    },
    { scope: "org", labels: ["notifications"] },
  ),
  singleVersion(
    "vault-index",
    {
      version: "1.3.0",
      description: "Maintain a searchable index over a Granite memory vault.",
      body: "# vault-index\n\nMaintains a searchable index over a Granite memory vault.",
      tools: ["read_file"],
      license: "MIT",
    },
    { scope: "org", labels: ["memory"] },
  ),
  singleVersion(
    "granite-recall",
    {
      version: "1.0.0",
      description: "Recall relevant memories from a Granite vault for a given query.",
      body: "# granite-recall\n\nRecalls relevant memories from a Granite vault for a query.",
      tools: ["read_file"],
      license: "MIT",
    },
    { scope: "org", labels: ["memory"] },
  ),
  singleVersion(
    "screenshot-grab",
    {
      version: "0.2.0",
      description: "Capture a rendered screenshot of a page region.",
      body: "# screenshot-grab\n\nCaptures a rendered screenshot of a page region.",
      tools: ["run_python"],
      license: "MIT",
    },
    { scope: "org" },
  ),
  singleVersion(
    "html-export",
    {
      version: "1.0.0",
      description: "Export a report to a standalone HTML file. Superseded by markdown-report.",
      body: "# html-export\n\nExports a report to a standalone HTML file.",
      tools: ["read_file"],
      license: "MIT",
    },
    { scope: "org", labels: ["reporting"] },
  ),
  singleVersion(
    "incident-summary",
    {
      version: "0.1.8",
      description: "Summarize an incident timeline from logs into a concise postmortem draft.",
      body: "# incident-summary\n\nReads a directory of log excerpts and produces a terse incident summary.",
      tools: ["read_file", "run_python"],
      license: "MIT",
      dependencies: ["log-parser", "markdown-report"],
    },
    { scope: "org", labels: ["reporting", "engineering/tools"] },
  ),
  singleVersion(
    "email-digest",
    {
      version: "1.2.0",
      description: "Compile a daily digest of activity into a short formatted email.",
      body: "# email-digest\n\nCompiles a daily digest of activity into a short formatted email.",
      tools: ["read_file"],
      license: "MIT",
      dependencies: ["markdown-report"],
    },
    { scope: "org", labels: ["notifications", "reporting"] },
  ),
  {
    slug: "release-notes",
    scope: "org",
    labels: ["engineering/releases"],
    versions: [
      {
        version: "1.0.0",
        description: "Turn merged changes into concise, audience-ready release notes.",
        body: "# release-notes\n\nBuilds release notes from a list of merged changes.",
        tools: ["read_file"],
        license: "MIT",
        title: "Release notes",
        icon: "megaphone",
        notes: "## Output\n\nProduces a Markdown announcement and a compact changelog.",
        files: [
          { path: "references/template.md", content: "# Release {{version}}\n\n## Highlights\n\n- {{change}}\n" },
          { path: "scripts/format.ts", content: "export const bullet = (change: string) => `- ${change}`;\n" },
        ],
      },
      {
        version: "1.1.0",
        description: "Turn merged changes into concise, audience-ready release notes.",
        body: "# release-notes\n\nBuilds release notes from merged changes, grouped by audience and impact.",
        tools: ["read_file"],
        license: "MIT",
        title: "Release notes",
        icon: "megaphone",
        notes: "## Output\n\nProduces a Markdown announcement, grouped highlights, and a compact changelog.",
        files: [
          { path: "references/template.md", content: "# Release {{version}}\n\n## Highlights\n\n- {{change}}\n" },
          { path: "scripts/format.ts", content: "export const bullet = (change: string) => `- ${change}`;\n" },
          { path: "examples/input.json", content: "{\n  \"changes\": [\"Add grouped highlights\"]\n}\n" },
        ],
      },
    ],
  },
  singleVersion(
    "postmortem-review",
    {
      version: "1.0.0",
      description: "Review a postmortem draft for evidence, clarity, and follow-up ownership.",
      body: "# postmortem-review\n\nReviews an incident summary and highlights gaps.",
      tools: ["read_file"],
      license: "MIT",
      dependencies: ["incident-summary"],
    },
    { scope: "org", labels: ["engineering/incidents"] },
  ),
  singleVersion(
    "browser-check",
    {
      version: "1.0.0",
      description: "Run a visual browser check and capture evidence for regressions.",
      body: "# browser-check\n\nChecks a browser flow and captures screenshots for failures.",
      tools: ["run_python"],
      license: "MIT",
    },
    { scope: "org", labels: ["qa/web"] },
  ),
  singleVersion(
    "legacy-import",
    {
      version: "1.0.0",
      description: "Import content from a legacy HTML knowledge base.",
      body: "# legacy-import\n\nImports and normalizes legacy HTML content.",
      tools: ["read_file"],
      license: "MIT",
    },
    { scope: "org", labels: ["migration"] },
  ),
  singleVersion(
    "manifest-invalid",
    {
      version: "1.0.0",
      description: "Demonstrate how an invalid published skill appears in the catalog.",
      body: "# manifest-invalid\n\nA deliberate validation-state fixture.",
      license: "MIT",
    },
    { scope: "org", labels: ["testing/fixtures"] },
  ),
  singleVersion(
    "private-source",
    {
      version: "1.0.0",
      description: "Collect private research sources before publication.",
      body: "# private-source\n\nCollects and annotates private research sources.",
      tools: ["read_file"],
      license: "MIT",
    },
    { scope: "personal", labels: ["research/sources"] },
  ),
  singleVersion(
    "private-brief",
    {
      version: "1.0.0",
      description: "Draft a private brief from collected research sources.",
      body: "# private-brief\n\nDrafts a private brief before it is shared with the organization.",
      tools: ["read_file"],
      license: "MIT",
      dependencies: ["private-source"],
    },
    { scope: "personal", labels: ["drafts/briefs"] },
  ),
  singleVersion(
    "research-draft",
    {
      version: "0.1.0",
      description: "Keep an unfiled personal research draft.",
      body: "# research-draft\n\nAn intentionally unfiled personal draft.",
      tools: ["read_file"],
      license: "MIT",
    },
    { scope: "personal" },
  ),
];

export const DEMO_EMPTY_ORG_LABELS = ["growth"] as const;
export const DEMO_EMPTY_PERSONAL_LABELS = ["ideas"] as const;

export const DEMO_INSTALLS = [
  { slug: "email-digest", version: "1.2.0", expectedStatus: "installed" },
  { slug: "release-notes", version: "1.0.0", expectedStatus: "update" },
  { slug: "slack-notify", version: null, expectedStatus: "installed" },
] as const;

export const DEMO_ARCHIVED_SLUGS = ["screenshot-grab", "html-export"] as const;

export const DEMO_FORCED_DEPENDENCIES = [
  { dependent: "vault-index", dependency: "granite-recall", state: "cycle" },
  { dependent: "granite-recall", dependency: "vault-index", state: "cycle" },
  { dependent: "legacy-import", dependency: "html-sanitize", state: "missing" },
  { dependent: "browser-check", dependency: "screenshot-grab", state: "archived" },
] as const;

export const DEMO_INVALID_SKILLS = [
  { slug: "manifest-invalid", error: "Seeded validation failure: manifest metadata is intentionally invalid." },
] as const;
