import type { AgentCredentialReference, WorkspaceCredentialV3 } from "./storage.js";

export type WorkspaceAuthentication =
  | { kind: "agent"; reference: AgentCredentialReference }
  | { kind: "legacy-pat"; token: string };

/**
 * Authentication selection is explicit and happens before any network call.
 * An Agent Auth error can therefore never cause an implicit PAT retry.
 */
export function selectWorkspaceAuthentication(
  workspace: WorkspaceCredentialV3,
  requestedMode = process.env.COMPANION_AUTH_MODE,
): WorkspaceAuthentication {
  if (requestedMode?.trim().toLowerCase() === "legacy-pat") {
    const token = workspace.legacyPat?.token;
    if (!token) throw new Error("explicit legacy-pat mode was selected, but this workspace has no preserved PAT");
    return { kind: "legacy-pat", token };
  }
  if (!workspace.agentAuth) {
    throw new Error(
      "workspace is not connected with Agent Auth; run the Companion connect flow (legacy PAT use requires COMPANION_AUTH_MODE=legacy-pat)",
    );
  }
  return { kind: "agent", reference: workspace.agentAuth };
}
