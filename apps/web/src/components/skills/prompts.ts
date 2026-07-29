import type { LocalSkillRow } from "@companion/contracts";

export function promptFor(skill: LocalSkillRow): string {
  if (skill.status === "update") return skill.prompts.update;
  if (skill.status === "installed") return skill.prompts.use;
  return skill.prompts.install;
}

/**
 * Fill non-secret prompt placeholders. A mixed-version API may still return an old PAT template;
 * the web client deliberately substitutes an instruction instead of minting or injecting a token.
 */
export function fillPrompt(
  template: string,
  base: string,
  workspaceId: string,
  agent = "<your assistant>",
  tool = agent,
): string {
  return template
    .split("{base}")
    .join(base)
    .split("{workspaceId}")
    .join(workspaceId)
    .split("{tool}")
    .join(tool)
    .split("{token}")
    .join("[PAT intentionally omitted; use Agent Auth]")
    .split("<your assistant>")
    .join(agent);
}
