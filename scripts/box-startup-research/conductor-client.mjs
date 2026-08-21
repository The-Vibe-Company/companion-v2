import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f-]{27,35}$/i;

function asObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Conductor returned an invalid ${label}`);
  }
  return value;
}

function findObject(value, predicate) {
  if (!value || typeof value !== "object") return null;
  if (!Array.isArray(value) && predicate(value)) return value;
  for (const child of Object.values(value)) {
    const found = findObject(child, predicate);
    if (found) return found;
  }
  return null;
}

function idFrom(value, label) {
  const id = value?.id;
  if (typeof id !== "string" || !UUID_PATTERN.test(id)) {
    throw new Error(`Conductor returned an invalid ${label} id`);
  }
  return id;
}

function deterministicUuid(value) {
  const bytes = Buffer.from(createHash("sha256").update(value).digest().subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export class ConductorCloudClient {
  #run;

  constructor(options = {}) {
    this.#run = options.run ?? (async (args) => {
      const { stdout } = await execFile("conductor", ["--json", ...args], {
        cwd: options.cwd ?? process.cwd(),
        env: options.env ?? process.env,
        maxBuffer: 8 * 1024 * 1024,
      });
      try {
        return JSON.parse(stdout);
      } catch {
        throw new Error("Conductor returned invalid JSON");
      }
    });
  }

  async currentWorkspace() {
    const value = asObject(await this.#run(["workspace", "get"]), "workspace");
    return {
      id: idFrom(value, "workspace"),
      projectId: idFrom({ id: value.projectId }, "project"),
      name: typeof value.name === "string" ? value.name : "Conductor workspace",
      deepLink: typeof value.deepLink === "string" ? value.deepLink : null,
    };
  }

  async createWorkspace(input) {
    const recovered = await this.findWorkspaceByName(
      input.projectId,
      input.name,
      input.sessionName,
    );
    if (recovered) {
      if (input.message) {
        await this.sendMessage({
          sessionId: recovered.sessionId,
          messageId: input.messageId,
          message: input.message,
        });
      }
      return recovered;
    }
    const args = [
      "workspace", "create",
      "--project-id", input.projectId,
      "--branch", input.branch,
      "--name", input.name,
      "--session-name", input.sessionName,
      "--agent", "codex",
      "--model", input.model,
      "--effort", input.effort,
    ];
    for (const [key, value] of Object.entries(input.environment ?? {})) {
      args.push("--env", `${key}=${value}`);
    }
    const response = await this.#run(args);
    let created;
    if (typeof response?.workspaceId === "string" && typeof response?.sessionId === "string") {
      created = {
        workspaceId: idFrom({ id: response.workspaceId }, "workspace"),
        sessionId: idFrom({ id: response.sessionId }, "session"),
        deepLink: typeof response.deepLink === "string" ? response.deepLink : null,
      };
    } else {
      const workspace = findObject(response, (item) =>
        typeof item.id === "string"
        && ("projectId" in item || "deepLink" in item || "workspaceId" in item));
      const session = findObject(response, (item) =>
        typeof item.id === "string"
        && ("workspaceId" in item || "agent" in item || "model" in item)
        && item !== workspace);
      if (!workspace || !session) throw new Error("Conductor omitted the created workspace or session");
      created = {
        workspaceId: idFrom(workspace, "workspace"),
        sessionId: idFrom(session, "session"),
        deepLink: typeof workspace.deepLink === "string"
          ? workspace.deepLink
          : typeof response?.deepLink === "string" ? response.deepLink : null,
      };
    }
    if (input.message) {
      if (typeof input.messageId !== "string" || !UUID_PATTERN.test(input.messageId)) {
        throw new Error("a deterministic message id is required for workspace startup");
      }
      try {
        await this.sendMessage({
          sessionId: created.sessionId,
          messageId: input.messageId,
          message: input.message,
        });
      } catch (error) {
        await this.archiveWorkspace(created.workspaceId).catch(() => undefined);
        throw error;
      }
    }
    return created;
  }

  async findWorkspaceByName(projectId, name, sessionName) {
    const workspaces = [];
    for (let offset = 0;; offset += 100) {
      const page = asObject(await this.#run([
        "project", "workspace", projectId, "--limit", "100", "--offset", String(offset),
      ]), "workspace page");
      if (!Array.isArray(page.data) || typeof page.hasMore !== "boolean") {
        throw new Error("Conductor returned an invalid workspace page");
      }
      workspaces.push(...page.data.filter((workspace) => workspace?.name === name));
      if (!page.hasMore) break;
    }
    if (workspaces.length > 1) throw new Error(`Conductor has duplicate workspaces named ${name}`);
    if (workspaces.length === 0) return null;
    const workspace = workspaces[0];
    const response = asObject(await this.#run([
      "workspace", "session", workspace.id, "--limit", "100", "--offset", "0",
    ]), "session page");
    if (!Array.isArray(response.data) || response.hasMore === true) {
      throw new Error("Conductor returned an incomplete session page");
    }
    const matching = response.data.filter((session) => session?.name === sessionName);
    if (matching.length !== 1) {
      throw new Error(`Conductor workspace ${name} does not have one matching session`);
    }
    return {
      workspaceId: idFrom(workspace, "workspace"),
      sessionId: idFrom(matching[0], "session"),
      deepLink: typeof workspace.deepLink === "string" ? workspace.deepLink : null,
    };
  }

  async createSession(input) {
    const sessionId = input.sessionId
      ?? deterministicUuid(`${input.workspaceId}:${input.messageId}:session`);
    const response = await this.#run([
      "session", "create",
      "--workspace", input.workspaceId,
      "--agent", "codex",
      "--session-id", sessionId,
      "--model", input.model,
      "--effort", input.effort,
      "--name", input.name,
      "--message-id", input.messageId,
      "--message", input.message,
    ]);
    const session = findObject(response, (item) =>
      typeof item.id === "string" && ("workspaceId" in item || "agent" in item));
    if (session) return { sessionId: idFrom(session, "session") };
    if (typeof response?.sessionId === "string") {
      return { sessionId: idFrom({ id: response.sessionId }, "session") };
    }
    throw new Error("Conductor omitted the created session");
  }

  async sendMessage(input) {
    idFrom({ id: input.sessionId }, "session");
    idFrom({ id: input.messageId }, "message");
    if (typeof input.message !== "string" || input.message.length === 0) {
      throw new Error("Conductor message is empty");
    }
    return await this.#run([
      "message", "create",
      "--session", input.sessionId,
      "--message-id", input.messageId,
      "--message", input.message,
    ]);
  }

  async sessionStatus(sessionId) {
    const response = asObject(await this.#run(["session", "status", sessionId]), "session status");
    if (typeof response.status !== "string") throw new Error("Conductor omitted session status");
    return response.status;
  }

  async sessionMessages(sessionId, after) {
    const args = ["session", "message", sessionId, "--limit", "100"];
    if (after) args.push("--after", after);
    return await this.#run(args);
  }

  async cancelSession(sessionId) {
    return await this.#run(["session", "cancel", sessionId]);
  }

  async archiveSession(sessionId) {
    return await this.#run(["session", "archive", sessionId]);
  }

  async archiveWorkspace(workspaceId) {
    return await this.#run(["workspace", "archive", workspaceId]);
  }
}
