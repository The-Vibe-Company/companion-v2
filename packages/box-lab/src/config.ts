import { createHash, randomBytes } from "node:crypto";
import { basename, resolve } from "node:path";

export type BoxLabDriverKind = "lima" | "oci-systemd";

export interface BoxLabConfig {
  host: "127.0.0.1" | "::1";
  port: number;
  apiKey: string;
  workspaceId: string;
  workspaceScope: string;
  resourcePrefix: string;
  stateDirectory: string;
  diagnosticsDirectory: string;
  driver: BoxLabDriverKind;
  ociEngine: "docker" | "podman";
  ociImage: string;
  bodyLimitBytes: number;
}

function positivePort(value: string | undefined, fallback: number): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error("BOX_LAB_PORT must be an integer between 1 and 65535");
  }
  return parsed;
}

function conductorPort(env: NodeJS.ProcessEnv): number {
  const base = Number(env.CONDUCTOR_PORT ?? "3000");
  if (!Number.isSafeInteger(base) || base < 1 || base > 65_527) {
    throw new Error("CONDUCTOR_PORT must leave room for the Box Lab offset (+8)");
  }
  return base + 8;
}

export function workspaceScope(workspaceId: string): string {
  const slug = workspaceId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 20) || "workspace";
  const digest = createHash("sha256").update(workspaceId).digest("hex").slice(0, 12);
  return `${slug}-${digest}`;
}

function workspaceResourcePrefix(workspaceId: string): string {
  // Lima appends SSH/control socket names below ~/.lima/<instance>. Keep the provider resource
  // name deliberately short so a normal but long host home directory cannot cross UNIX_PATH_MAX.
  const digest = createHash("sha256").update(workspaceId).digest("hex").slice(0, 20);
  return `cbl-${digest}`;
}

export function resolveBoxLabConfig(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): BoxLabConfig {
  const requestedHost = env.BOX_LAB_HOST?.trim() || "127.0.0.1";
  if (requestedHost !== "127.0.0.1" && requestedHost !== "::1") {
    throw new Error("BOX_LAB_HOST must be loopback (127.0.0.1 or ::1)");
  }
  const apiKey = env.BOX_LAB_API_KEY?.trim() || randomBytes(32).toString("base64url");
  if (apiKey.length < 8 || apiKey.length > 256) {
    throw new Error("BOX_LAB_API_KEY must contain between 8 and 256 characters");
  }
  const workspaceId = env.BOX_LAB_WORKSPACE_ID?.trim()
    || env.CONDUCTOR_WORKSPACE_ID?.trim()
    || basename(cwd);
  if (!workspaceId || workspaceId.length > 200) {
    throw new Error("BOX_LAB_WORKSPACE_ID must contain between 1 and 200 characters");
  }
  const scope = workspaceScope(workspaceId);
  const requestedDriver = env.BOX_LAB_DRIVER?.trim()
    || (process.platform === "darwin" ? "lima" : "oci-systemd");
  if (requestedDriver !== "lima" && requestedDriver !== "oci-systemd") {
    throw new Error("BOX_LAB_DRIVER must be lima or oci-systemd");
  }
  const requestedEngine = env.BOX_LAB_OCI_ENGINE?.trim() || "docker";
  if (requestedEngine !== "docker" && requestedEngine !== "podman") {
    throw new Error("BOX_LAB_OCI_ENGINE must be docker or podman");
  }
  const stateRoot = resolve(env.BOX_LAB_STATE_DIR?.trim() || resolve(cwd, ".context", "box-lab"));
  const stateDirectory = resolve(stateRoot, scope);
  const port = env.BOX_LAB_PORT === undefined
    ? conductorPort(env)
    : positivePort(env.BOX_LAB_PORT, 0);
  return {
    host: requestedHost,
    port,
    apiKey,
    workspaceId,
    workspaceScope: scope,
    resourcePrefix: workspaceResourcePrefix(workspaceId),
    stateDirectory,
    diagnosticsDirectory: resolve(stateDirectory, "diagnostics"),
    driver: requestedDriver,
    ociEngine: requestedEngine,
    ociImage: env.BOX_LAB_OCI_IMAGE?.trim() || `companion-box-lab-systemd:${scope}`,
    bodyLimitBytes: 12 * 1024 * 1024,
  };
}
