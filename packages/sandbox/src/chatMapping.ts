/**
 * Pure, version-independent helpers for translating OpenCode tool runs into our normalized chat
 * vocabulary. Kept out of `opencodeChat.ts` so they can be unit-tested without the SDK.
 */

const SKILL_PATH_RE = /\.claude\/skills\/([a-z0-9][a-z0-9-]*)\//;

/**
 * Best-effort skill slug from a tool's input: skill scripts run from `.claude/skills/<slug>/…`, so
 * a bash command / file path that references that directory tells us which skill is executing.
 * `input` is the JSON-stringified tool args (e.g. `{"command":"python3 .claude/skills/x/run.py"}`).
 */
export function skillFromToolInput(input: string | null | undefined): string | null {
  if (!input) return null;
  const match = SKILL_PATH_RE.exec(input);
  return match ? (match[1] ?? null) : null;
}

/**
 * The human title + resolved skill for a tool run. `state.title` is OpenCode's summary (e.g.
 * "Read SKILL.md"); we fall back to a compact title derived from the tool + input when it is absent.
 */
export function toolTitleAndSkill(input: {
  tool: string;
  title: string | null | undefined;
  inputJson: string | null | undefined;
}): { title: string | null; skill: string | null } {
  const skill = skillFromToolInput(input.inputJson);
  const title = input.title?.trim() ? input.title.trim() : null;
  return { title, skill };
}
