export {
  COMPANION_BOX_AGENT_AUTH_PATH,
  COMPANION_BOX_AGENT_AUTH_BAN_MS,
  COMPANION_BOX_AGENT_AUTH_FAILURE_LIMIT,
  COMPANION_BOX_AGENT_AUTH_FAILURE_WINDOW_MS,
  COMPANION_BOX_AGENT_BROKER_RPC_TIMEOUT_MS,
  COMPANION_BOX_AGENT_DEFAULT_PORT,
  COMPANION_BOX_AGENT_HOST_TITLE,
  COMPANION_BOX_AGENT_LONG_POLL_CAP_MS,
  COMPANION_BOX_AGENT_LONG_POLL_INTERVAL_MS,
  COMPANION_BOX_AGENT_MAX_BODY_BYTES,
  COMPANION_BOX_AGENT_SCRIPT_PATH,
  COMPANION_BOX_AGENT_UNIT_NAME,
  COMPANION_BOX_AGENT_VERSION,
  CompanionBoxAgentCore,
  bearerMatchesAuthFile,
  companionBoxAgentSeams,
  sanitizePiUnitState,
  startCompanionBoxAgentServer,
} from "./companionBoxAgentCore";
export type {
  CompanionBoxAgentHealth,
  CompanionBoxAgentRequest,
  CompanionBoxAgentResult,
  CompanionBoxAgentSeamPaths,
  CompanionBoxAgentSeams,
  StartCompanionBoxAgentServerOptions,
} from "./companionBoxAgentCore";

/**
 * Standalone ESM staged onto Boxes by the layout overlay. Kept in a separate generated module so
 * the control-plane adapter installs the exact agent tested in this package.
 */
export { COMPANION_BOX_AGENT_SOURCE } from "./companionBoxAgentSource";
