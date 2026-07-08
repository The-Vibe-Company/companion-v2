import type { AgentHeartbeatOutput } from "@companion/contracts";

export interface UpdateStatus {
  available: boolean;
  latestVersion: string;
  mode: "notify";
}

export interface UpdateStrategy {
  canUpdate(): boolean;
  update(targetVersion: string): Promise<void>;
}

export const notifyOnlyUpdateStrategy: UpdateStrategy = {
  canUpdate: () => false,
  async update() {
    throw new Error("automatic agent self-update is not enabled in this build");
  },
};

export function updateStatusFromHeartbeat(response: AgentHeartbeatOutput): UpdateStatus {
  return {
    available: response.agent_update_available,
    latestVersion: response.latest_agent_version,
    mode: "notify",
  };
}
