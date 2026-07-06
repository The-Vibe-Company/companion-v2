import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ToolSpec {
  key: string;
  displayName: string;
  detect: string[];
  skillsDir: { user: string; project: string };
}

export const TOOL_REGISTRY: Record<string, ToolSpec> = {
  "claude-code": {
    key: "claude-code",
    displayName: "Claude Code",
    detect: ["~/.claude"],
    skillsDir: { user: "~/.claude/skills", project: ".claude/skills" },
  },
  codex: {
    key: "codex",
    displayName: "Codex",
    detect: ["~/.codex"],
    skillsDir: { user: "~/.codex/skills", project: ".codex/skills" },
  },
  opencode: {
    key: "opencode",
    displayName: "OpenCode",
    detect: ["~/.config/opencode"],
    skillsDir: { user: "~/.agents/skills", project: ".agents/skills" },
  },
};

function expandHome(path: string): string {
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

export function knownToolKeys(): string[] {
  return Object.keys(TOOL_REGISTRY);
}

export function detectInstalledTools(): string[] {
  return knownToolKeys().filter((key) => TOOL_REGISTRY[key]!.detect.some((path) => existsSync(expandHome(path))));
}
