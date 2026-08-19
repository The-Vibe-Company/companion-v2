import type { CompanionToolRunKind } from "./companions";

/** Canonical, serializable Pi tool-name catalog shared by projection and the in-Box timer. */
export const COMPANION_TOOL_KIND_NAME_TABLE: ReadonlyArray<
  readonly [CompanionToolRunKind, readonly string[]]
> = [
  // First on purpose. A name like `run_subagent` matches `run` in the shell row too, and word
  // matching takes the first row that claims any word: what a reader needs told is that a delegated
  // agent ran, not that something was run.
  ["subagent", ["subagent", "subagents"]],
  ["computer", [
    "computer", "computeruse", "desktop", "lux", "screenshot", "screencapture", "screen",
    "click", "doubleclick", "rightclick", "type", "key", "press", "scroll", "drag", "mouse",
    "cursor", "hover", "wait",
  ]],
  ["browse", [
    "browse", "browser", "web", "websearch", "webfetch", "fetch", "search", "navigate", "goto",
    "openurl", "url", "http", "https", "request", "curl", "crawl", "page",
  ]],
  ["shell", [
    "bash", "sh", "zsh", "shell", "terminal", "exec", "execute", "run", "command", "cmd",
    "process", "script", "python", "node", "npm", "pnpm", "git",
  ]],
  ["file", [
    "file", "files", "read", "write", "edit", "editor", "patch", "apply", "applypatch", "create",
    "delete", "remove", "move", "copy", "ls", "list", "dir", "glob", "grep", "find", "rg", "view",
    "notebook", "strreplace", "replace", "insert", "open",
  ]],
];

const TOOL_KIND_NAMES: ReadonlyArray<
  readonly [CompanionToolRunKind, ReadonlySet<string>]
> = COMPANION_TOOL_KIND_NAME_TABLE.map(([kind, names]) => [kind, new Set(names)] as const);

function toolNameWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

export function companionToolRunKind(name: string): CompanionToolRunKind {
  const collapsed = name.toLowerCase().replace(/[^a-z0-9]/g, "");
  for (const [kind, names] of TOOL_KIND_NAMES) {
    if (names.has(collapsed)) return kind;
  }
  const words = toolNameWords(name);
  for (const [kind, names] of TOOL_KIND_NAMES) {
    if (words.some((word) => names.has(word))) return kind;
  }
  return "tool";
}
