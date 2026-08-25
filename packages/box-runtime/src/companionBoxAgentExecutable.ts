import { join, resolve } from "node:path";

import {
  COMPANION_BOX_AGENT_AUTH_PATH,
  COMPANION_BOX_AGENT_DEFAULT_PORT,
  CompanionBoxAgentCore,
  companionBoxAgentSeams,
  startCompanionBoxAgentServer,
} from "./companionBoxAgentCore";

const PI_LAYOUT_MARKER_PATH = ".companion/runtime/state/pi-layout.version";
const PI_BROKER_SOCKET_PATH = ".companion/runtime/state/pi-broker.sock";
const ATTACHMENT_UPLOADS_PATH = ".companion/runtime/tmp/agent-attachments";

const home = requiredAbsolutePath("HOME");
const port = optionalPort("COMPANION_AGENT_PORT") ?? COMPANION_BOX_AGENT_DEFAULT_PORT;
const brokerSocketPath = optionalAbsolutePath("COMPANION_PI_SOCKET_PATH")
  ?? join(home, PI_BROKER_SOCKET_PATH);
const authFilePath = optionalAbsolutePath("COMPANION_AGENT_AUTH_PATH")
  ?? join(home, COMPANION_BOX_AGENT_AUTH_PATH);
const layoutMarkerPath = join(home, PI_LAYOUT_MARKER_PATH);

async function main(): Promise<void> {
  const core = new CompanionBoxAgentCore(
    companionBoxAgentSeams({
      brokerSocketPath,
      authFilePath,
      layoutMarkerPath,
      attachmentsPath: join(home, "attachments"),
      attachmentUploadsPath: join(home, ATTACHMENT_UPLOADS_PATH),
      outboxPath: join(home, "outbox"),
    }),
  );
  // The hosted proxy is the only inbound channel and reaches the box on 0.0.0.0 exclusively.
  const server = await startCompanionBoxAgentServer({ core, port, host: "0.0.0.0" });
  const stop = (): void => {
    server.close();
    server.closeAllConnections();
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}

function requiredAbsolutePath(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  const absolute = resolve(value);
  if (absolute !== value) throw new Error(`${name} must be absolute`);
  return absolute;
}

function optionalAbsolutePath(name: string): string | null {
  const value = process.env[name]?.trim();
  if (!value) return null;
  const absolute = resolve(value);
  if (absolute !== value) throw new Error(`${name} must be absolute`);
  return absolute;
}

function optionalPort(name: string): number | undefined {
  const text = process.env[name]?.trim();
  if (!text) return undefined;
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value <= 0 || value > 65_535) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

void main().catch((error) => {
  // Never log the raw error: it may contain a Box path. A stable name is enough for the journal.
  const reason = error instanceof Error && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(error.name)
    ? error.name
    : "Error";
  process.stderr.write(`companion-box-agent: startup failed (${reason})\n`);
  process.exitCode = 1;
});
