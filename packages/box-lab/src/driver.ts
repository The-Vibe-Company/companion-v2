import { posix } from "node:path";

import type { ProcessRunner } from "./process";

export interface DriverDoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface DriverCommandInput {
  resourceName: string;
  command: string;
  timeoutSeconds: number;
}

export interface DriverCommandResult {
  success: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * Signals that a lifecycle operation left the source Box unavailable.
 *
 * Drivers keep provider details inside their own boundary; the service only needs this stable
 * signal to stop advertising the Box as running.
 */
export class BoxLabSourceUnavailableError extends Error {
  readonly code = "box_source_unavailable";

  constructor() {
    super("Contained Box source could not be restarted after snapshot");
    this.name = "BoxLabSourceUnavailableError";
  }
}

export interface BoxLabDriver {
  readonly kind: "lima" | "oci-systemd";
  doctor(): Promise<DriverDoctorCheck[]>;
  prepare(): Promise<void>;
  create(resourceName: string, fromSnapshotResourceName?: string): Promise<void>;
  writeFile(resourceName: string, relativePath: string, content: Uint8Array): Promise<void>;
  execute(input: DriverCommandInput): Promise<DriverCommandResult>;
  stop(resourceName: string): Promise<void>;
  start(resourceName: string): Promise<void>;
  delete(resourceName: string): Promise<void>;
  saveSnapshot(resourceName: string, snapshotResourceName: string): Promise<void>;
  deleteSnapshot(snapshotResourceName: string): Promise<void>;
  interactiveShell(resourceName: string): Promise<number>;
  reset(): Promise<void>;
}

export interface DriverFactoryInput {
  runner: ProcessRunner;
  resourcePrefix: string;
  workspaceScope: string;
  stateDirectory: string;
}

export function assertResourceName(name: string, prefix: string): string {
  if (!name.startsWith(`${prefix}-`) || !/^[a-z0-9][a-z0-9_.-]{1,127}$/.test(name)) {
    throw new Error("Box Lab resource name is outside this workspace scope");
  }
  return name;
}

/** Resolve provider file paths under /home/user without following `..` outside the Box home. */
export function normalizeGuestFilePath(input: string): string {
  if (!input || input.includes("\0") || input.includes("\\")) {
    throw new Error("Box file path is invalid");
  }
  let relative = input;
  if (relative.startsWith("~/")) relative = relative.slice(2);
  else if (relative.startsWith("/home/user/")) relative = relative.slice("/home/user/".length);
  else if (relative.startsWith("/")) throw new Error("Box file path must be under /home/user");
  const normalized = posix.normalize(relative);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw new Error("Box file path escapes /home/user");
  }
  return normalized;
}
