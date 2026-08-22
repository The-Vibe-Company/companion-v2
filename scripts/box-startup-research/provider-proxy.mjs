import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

const DEFAULT_BOX_API_BASE = "https://ascii.dev/api/box/v1";
const BOX_ID_PATTERN = /^bx_[23456789abcdefghjkmnpqrstuvwxyz]{8}$/;
const OPERATION_ID_PATTERN = /^bdop_[a-f0-9]{32}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SNAPSHOT_PATTERN = /^companion-l14-[a-f0-9]{12}$/;
const MAX_PROVIDER_TTL_SECONDS = 2_592_000;
const MAX_BODY_BYTES = 32 * 1024 * 1024;
const RUNTIME_ATTESTATION_DEADLINE_MS = 20_000;
const RUNTIME_ATTESTATION_POLL_MS = 250;
const RUNTIME_ATTESTATION_COMMAND_SECONDS = 5;

function jsonBody(buffer) {
  if (buffer.length === 0) return null;
  try {
    return JSON.parse(buffer.toString("utf8"));
  } catch {
    throw new Error("lease proxy received invalid JSON");
  }
}

async function requestBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error("lease proxy request exceeded its limit");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function boxName(companionId) {
  return `Companion ${companionId} g1`;
}

function stringValue(value) {
  if (value === null || value === undefined) return null;
  try {
    const candidate = String(value);
    return candidate === value ? candidate : null;
  } catch {
    return null;
  }
}

function optionalStringWithin(value, minimum, maximum) {
  if (value === undefined) return true;
  const string = stringValue(value);
  return string !== null && string.length >= minimum && string.length <= maximum;
}

function validBoxCreateEnvelope(status, body) {
  const responseStatus = stringValue(body?.status);
  const box = body?.box;
  const boxId = stringValue(box?.id);
  const boxObject = box !== null && box !== undefined && !Array.isArray(box);
  return status === 202
    && body?.ok === true
    && body?.type === "box.created"
    && responseStatus !== null
    && responseStatus.length >= 1
    && responseStatus.length <= 80
    && Number.isSafeInteger(body?.ttlSeconds)
    && body.ttlSeconds > 0
    && body.ttlSeconds <= MAX_PROVIDER_TTL_SECONDS
    && boxObject
    && boxId !== null
    && BOX_ID_PATTERN.test(boxId)
    && optionalStringWithin(box?.name, 0, Number.MAX_SAFE_INTEGER)
    && optionalStringWithin(box?.state, 1, 80);
}

function sanitizedHeaders(headers) {
  const result = {};
  for (const name of ["content-type", "x-ascii-confirm-delete"]) {
    const value = stringValue(headers[name]);
    if (value !== null) result[name] = value;
  }
  return result;
}

function brokerPrompt(command) {
  const commandValue = stringValue(command);
  if (commandValue === null) return null;
  const matched = /COMPANION_PI_BROKER_COMMAND='([A-Za-z0-9+/=_-]+)'/.exec(commandValue);
  if (!matched) return null;
  try {
    const value = JSON.parse(Buffer.from(matched[1], "base64").toString("utf8"));
    if (!value || value.type !== "prompt" || !UUID_PATTERN.test(value.attemptId ?? "")
      || value.clearOutbox !== true || !Array.isArray(value.requiredInput)
      || value.requiredInput.length !== 1 || value.requiredInput[0] !== "text") return null;
    return { attemptId: value.attemptId, requestId: value.id, command: value };
  } catch {
    return null;
  }
}

function canonicalBrokerPromptCommand(prompt, brokerSha256, runtimeHashes) {
  const encoded = Buffer.from(JSON.stringify(prompt.command), "utf8").toString("base64");
  return `set -euo pipefail
export PATH=/usr/bin:/bin
test "$(/usr/bin/id -u)" = '${runtimeHashes.uid}'
companion_runtime_dir="/run/user/$(/usr/bin/id -u)"
export XDG_RUNTIME_DIR="$companion_runtime_dir"
if [ -S "$XDG_RUNTIME_DIR/bus" ]; then
  export DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"
fi
broker_socket="$HOME/.companion/runtime/state/pi-broker.sock"
broker_script="$HOME/.companion/bin/companion-pi-broker.mjs"
companion_attest_broker() {
  /usr/bin/systemctl --user is-active --quiet companion-pi-daemon.service
  companion_main_pid="$(/usr/bin/systemctl --user show companion-pi-daemon.service -p MainPID --value)"
  companion_invocation="$(/usr/bin/systemctl --user show companion-pi-daemon.service -p InvocationID --value)"
  case "$companion_main_pid" in ''|*[!0-9]*|0) return 1 ;; esac
  test -n "$companion_invocation"
  test -r "/proc/$companion_main_pid/cmdline"
  test "$(/usr/bin/sha256sum "$broker_script" | /usr/bin/cut -d' ' -f1)" = '${brokerSha256}'
  mapfile -d '' companion_broker_argv < "/proc/$companion_main_pid/cmdline"
  [ "\${#companion_broker_argv[@]}" -eq 2 ]
  [ "\${companion_broker_argv[1]}" = "$broker_script" ]
  companion_node_bin="$(/usr/bin/readlink -f "/proc/$companion_main_pid/exe")"
  test "$companion_node_bin" = '${runtimeHashes.nodePath}'
  test "$(/usr/bin/basename "$companion_node_bin")" = node
  test "$(/usr/bin/stat -Lc '%u' "$companion_node_bin")" = 0
  test "$(/usr/bin/sha256sum "$companion_node_bin" | /usr/bin/cut -d' ' -f1)" = '${runtimeHashes.node}'
  companion_node_mode="$(/usr/bin/stat -Lc '%a' "$companion_node_bin")"
  test $((8#$companion_node_mode & 0022)) -eq 0
  companion_broker_environment="$(/usr/bin/tr '\0' '\n' < "/proc/$companion_main_pid/environ")"
  if printf '%s\n' "$companion_broker_environment" | /usr/bin/grep -Eq '^(NODE_|LD_|DYLD_|BASH_ENV=|ENV=|GCONV_PATH=|GLIBC_TUNABLES=|LOCPATH=|MALLOC_TRACE=|OPENSSL_CONF=|OPENSSL_MODULES=).+'; then
    return 1
  fi
  companion_pi_bin="$(printf '%s\n' "$companion_broker_environment" | /usr/bin/sed -n 's/^COMPANION_PI_BIN=//p')"
  companion_pi_path="$(printf '%s\n' "$companion_broker_environment" | /usr/bin/sed -n 's/^PATH=//p')"
  test -n "$companion_pi_bin"
  test -n "$companion_pi_path"
  test "$(/usr/bin/readlink -f "$companion_pi_bin")" = '${runtimeHashes.piPath}'
  test "$(/usr/bin/basename "$companion_pi_bin")" = pi
  test "$(/usr/bin/stat -Lc '%u' "$companion_pi_bin")" = '${runtimeHashes.piUid}'
  test "$(/usr/bin/sha256sum "$companion_pi_bin" | /usr/bin/cut -d' ' -f1)" = '${runtimeHashes.pi}'
  companion_pi_mode="$(/usr/bin/stat -Lc '%a' "$companion_pi_bin")"
  test "$companion_pi_mode" = '${runtimeHashes.piMode}'
  test $((8#$companion_pi_mode & 0022)) -eq 0
  companion_pi_child=false
  companion_node_search_safe=false
  IFS=: read -ra companion_path_entries <<< "$companion_pi_path"
  for companion_path_entry in "\${companion_path_entries[@]}"; do
    case "$companion_path_entry" in /*) ;; *) return 1 ;; esac
    companion_path_node="$(/usr/bin/readlink -f "$companion_path_entry/node" 2>/dev/null || true)"
    if [ "$companion_path_node" = '${runtimeHashes.nodePath}' ]; then
      companion_node_search_safe=true
      break
    fi
    test -z "$companion_path_node"
  done
  [ "$companion_node_search_safe" = true ]
  for companion_child in $(/usr/bin/cat "/proc/$companion_main_pid/task/$companion_main_pid/children"); do
    if /usr/bin/tr '\0' '\n' < "/proc/$companion_child/cmdline" | /usr/bin/grep -Fx -- "$companion_pi_bin" >/dev/null \
      && [ "$(/usr/bin/readlink -f "/proc/$companion_child/exe")" = '${runtimeHashes.nodePath}' ]; then
      companion_pi_child=true
    fi
  done
  [ "$companion_pi_child" = true ]
  test -S "$broker_socket"
  [ "$(/usr/bin/stat -c '%a' "$broker_socket")" = 600 ]
  companion_socket_inode="$(/usr/bin/awk -v socket_path="$broker_socket" '$8 == socket_path { print $7 }' /proc/net/unix | /usr/bin/tail -n 1)"
  test -n "$companion_socket_inode"
  companion_socket_owned=false
  for companion_fd in "/proc/$companion_main_pid/fd/"*; do
    if [ "$(/usr/bin/readlink "$companion_fd" 2>/dev/null || true)" = "socket:[$companion_socket_inode]" ]; then
      companion_socket_owned=true
    fi
  done
  [ "$companion_socket_owned" = true ]
}
companion_pi_child_ready=false
for companion_pi_probe in $(/usr/bin/seq 1 40); do
  companion_main_pid="$(/usr/bin/systemctl --user show companion-pi-daemon.service -p MainPID --value 2>/dev/null || true)"
  case "$companion_main_pid" in ''|*[!0-9]*|0) ;; *)
    companion_pi_bin="$( { /usr/bin/tr '\0' '\n' < "/proc/$companion_main_pid/environ" | /usr/bin/sed -n 's/^COMPANION_PI_BIN=//p'; } 2>/dev/null || true)"
    for companion_child in $(/usr/bin/cat "/proc/$companion_main_pid/task/$companion_main_pid/children" 2>/dev/null || true); do
      if /usr/bin/tr '\0' '\n' < "/proc/$companion_child/cmdline" 2>/dev/null | /usr/bin/grep -Fx -- "$companion_pi_bin" >/dev/null \
        && [ "$(/usr/bin/readlink -f "/proc/$companion_child/exe" 2>/dev/null || true)" = '${runtimeHashes.nodePath}' ]; then
        companion_pi_child_ready=true
      fi
    done
  esac
  if [ "$companion_pi_child_ready" = true ]; then break; fi
  if [ "$companion_pi_probe" -lt 40 ]; then /usr/bin/sleep 0.1; fi
done
[ "$companion_pi_child_ready" = true ]
companion_attest_broker
companion_invocation="$(/usr/bin/systemctl --user show companion-pi-daemon.service -p InvocationID --value)"
COMPANION_PI_BROKER_SOCKET="$broker_socket" \
COMPANION_PI_BROKER_COMMAND='${encoded}' \
COMPANION_PI_BROKER_INVOCATION="$companion_invocation" \
'${runtimeHashes.nodePath}' <<'COMPANION_RESEARCH_BROKER_CLIENT'
const net = require("node:net");
const request = Buffer.from(process.env.COMPANION_PI_BROKER_COMMAND || "", "base64").toString("utf8");
const expected = JSON.parse(request);
const invocation = process.env.COMPANION_PI_BROKER_INVOCATION || "";
const socket = net.createConnection({ path: process.env.COMPANION_PI_BROKER_SOCKET });
let buffer = "";
const timer = setTimeout(() => socket.destroy(new Error("timeout")), 8000);
socket.setEncoding("utf8");
socket.on("connect", () => socket.write(request + "\n"));
socket.on("data", (chunk) => {
  buffer += chunk;
  if (Buffer.byteLength(buffer, "utf8") > 262144) socket.destroy(new Error("oversize"));
  const newline = buffer.indexOf("\n");
  if (newline < 0) return;
  clearTimeout(timer);
  const response = JSON.parse(buffer.slice(0, newline));
  if (response?.type !== "response" || response.command !== "prompt"
    || response.id !== expected.id || response.success !== true
    || response.data?.piAcknowledged !== true
    || response.data?.attemptId !== expected.attemptId
    || response.data?.invocationId !== invocation
    || response.data?.clearOutbox !== true
    || !Number.isSafeInteger(response.data?.initialCursor)
    || response.data.initialCursor < 0) throw new Error("invalid acknowledgement");
  process.stdout.write(JSON.stringify(response) + "\n");
  socket.end();
});
socket.on("error", () => process.exit(1));
socket.on("end", () => {
  if (buffer.indexOf("\n") < 0) process.exit(1);
});
COMPANION_RESEARCH_BROKER_CLIENT
companion_attest_broker`;
}

function promptWasAcknowledged(body, prompt) {
  const stdout = stringValue(body?.stdout);
  if (body?.success !== true || stdout === null) return false;
  return stdout.split(/\r?\n/).some((line) => {
    try {
      const response = JSON.parse(line);
      return response?.type === "response"
        && response.command === "prompt"
        && response.id === prompt.requestId
        && response.success === true
        && response.data?.piAcknowledged === true
        && response.data?.attemptId === prompt.attemptId
        && response.data?.clearOutbox === true
        && Number.isSafeInteger(response.data?.initialCursor)
        && response.data.initialCursor >= 0;
    } catch {
      return false;
    }
  });
}

function distribution(samples) {
  const sorted = [...samples].sort((left, right) => left - right);
  const percentile = (value) => sorted[Math.max(0, Math.ceil(sorted.length * value) - 1)];
  return { samples: sorted.length, p50_ms: percentile(0.5), p95_ms: percentile(0.95) };
}

function selectTrustedParent(snapshots, targetName) {
  const eligible = [];
  for (const snapshot of snapshots) {
    const name = stringValue(snapshot?.name);
    const createdAt = stringValue(snapshot?.createdAt);
    if (snapshot?.status !== "ready" || name === null || name === targetName
      || !SNAPSHOT_PATTERN.test(name) || createdAt === null) continue;
    const createdAtMs = Date.parse(createdAt);
    if (!Number.isFinite(createdAtMs)) continue;
    eligible.push({ snapshot, name, createdAtMs });
  }
  eligible.sort((left, right) => {
    const createdAt = right.createdAtMs - left.createdAtMs;
    if (createdAt !== 0) return createdAt;
    return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
  });
  return eligible[0]?.snapshot ?? null;
}

export class BoxLeaseProxy {
  #apiKey;
  #upstreamBase;
  #token = randomBytes(32).toString("base64url");
  #server;
  #allowedNames;
  #snapshotName;
  #parentSnapshotName = null;
  #parentSnapshotResolved = false;
  #maximumCreates;
  #boxIds = new Set();
  #operationIds = new Set();
  #createdIds = new Set();
  #snapshotSaved = false;
  #resumes = 0;
  #archives = 0;
  #commands = 0;
  #createsIssued = 0;
  #createInFlight = null;
  #createsBlocked = false;
  #evidenceByBox = new Map();
  #assertLeaseOwner;
  #brokerSha256;
  #runtimeHashes = null;

  constructor(input) {
    const apiKey = stringValue(input?.apiKey);
    const companionIds = input?.companionIds;
    const snapshotName = stringValue(input?.snapshotName);
    const brokerSha256 = stringValue(input?.brokerSha256);
    if (apiKey === null || apiKey.length < 1
      || !Array.isArray(companionIds) || companionIds.length < 2
      || companionIds.some((id) => !UUID_PATTERN.test(id))
      || snapshotName === null || !SNAPSHOT_PATTERN.test(snapshotName)
      || brokerSha256 === null || !/^[a-f0-9]{64}$/.test(brokerSha256)) {
      throw new Error("lease proxy configuration is invalid");
    }
    this.#apiKey = apiKey;
    this.#upstreamBase = (input.upstreamBase || DEFAULT_BOX_API_BASE).replace(/\/+$/, "");
    this.#allowedNames = new Set(companionIds.map(boxName));
    this.#snapshotName = snapshotName;
    this.#maximumCreates = companionIds.length;
    this.#assertLeaseOwner = input.assertLeaseOwner ?? (async () => undefined);
    this.#brokerSha256 = brokerSha256;
  }

  async start() {
    this.#server = createServer((request, response) => {
      void this.#handle(request, response).catch(() => {
        if (!response.headersSent) response.writeHead(403, { "content-type": "application/json" });
        response.end(JSON.stringify({ code: "lease_proxy_rejected" }));
      });
    });
    await new Promise((resolveStart, rejectStart) => {
      this.#server.once("error", rejectStart);
      this.#server.listen(0, "127.0.0.1", resolveStart);
    });
    const address = this.#server.address();
    if (!address || !Object.hasOwn(address, "port")) throw new Error("lease proxy did not bind");
    return {
      baseUrl: `http://127.0.0.1:${address.port}`,
      apiKey: this.#token,
    };
  }

  async close() {
    if (!this.#server) return;
    await new Promise((resolveClose, rejectClose) => {
      this.#server.close((error) => error ? rejectClose(error) : resolveClose());
      this.#server.closeAllConnections?.();
    });
    this.#server = null;
  }

  async #handle(request, response) {
    await this.#assertLeaseOwner();
    if (request.headers.authorization !== `Bearer ${this.#token}`) {
      throw new Error("lease proxy authentication failed");
    }
    const method = request.method || "GET";
    const url = new URL(request.url || "/", "http://lease-proxy.invalid");
    const body = await requestBody(request);
    const authorization = await this.#authorize(method, url.pathname, body);
    const createAuthorization = authorization?.createOrdinal === undefined ? null : authorization;
    const forwardedBody = authorization?.providerBody === undefined
      ? body
      : Buffer.from(JSON.stringify(authorization.providerBody));
    const requestOptions = {
      method,
      headers: {
        ...sanitizedHeaders(request.headers),
        Authorization: `Bearer ${this.#apiKey}`,
      },
    };
    if (forwardedBody.length > 0) requestOptions.body = forwardedBody;
    let upstream;
    try {
      upstream = await fetch(`${this.#upstreamBase}${url.pathname}${url.search}`, requestOptions);
    } catch (error) {
      this.#blockCreate(createAuthorization);
      throw error;
    }
    const successful = upstream.status >= 200 && upstream.status < 300;
    if (createAuthorization && !successful) this.#clearCreateInFlight(createAuthorization);
    let raw;
    try {
      raw = Buffer.from(await upstream.arrayBuffer());
      await this.#assertLeaseOwner();
      if (raw.includes(Buffer.from(this.#apiKey))) {
        throw new Error("lease proxy rejected a credential-bearing provider response");
      }
    } catch (error) {
      if (successful) this.#blockCreate(createAuthorization);
      throw error;
    }
    let transformed;
    try {
      transformed = await this.#observe(
        method,
        url.pathname,
        upstream.status,
        raw,
        authorization,
      );
    } catch (error) {
      if (successful) this.#blockCreate(createAuthorization);
      throw error;
    }
    response.writeHead(upstream.status, { "content-type": "application/json" });
    response.end(transformed);
  }

  async #authorize(method, path, rawBody) {
    const body = jsonBody(rawBody);
    if (path === "/boxes" && method === "GET") return;
    if (path === "/boxes" && method === "POST") {
      if (this.#createsBlocked || this.#createInFlight !== null
        || this.#createsIssued >= this.#maximumCreates || !body || body.noEnv !== true
        || !Number.isSafeInteger(body.ttlSeconds) || body.ttlSeconds < 1 || body.ttlSeconds > 900
        || Object.keys(body).some((key) => !["ttlSeconds", "noEnv", "from"].includes(key))
        || (this.#createsIssued === 0 && this.#parentSnapshotName === null)
        || body.from !== (this.#createsIssued === 0
          ? this.#parentSnapshotName
          : this.#snapshotName)) {
        throw new Error("lease proxy rejected Box creation");
      }
      const createOrdinal = this.#createsIssued;
      const authorization = { createOrdinal, startedAt: Date.now() };
      this.#createInFlight = authorization;
      return authorization;
    }
    if (path === "/named-snapshots" && method === "GET") return;
    if (path === "/named-snapshots" && method === "POST") {
      const evidence = this.#evidenceByBox.get(body?.boxId);
      if (!body || body.name !== this.#snapshotName || !this.#boxIds.has(body.boxId)
        || evidence?.createOrdinal !== 0
        || Object.keys(body).some((key) => !["boxId", "name"].includes(key))) {
        throw new Error("lease proxy rejected snapshot creation");
      }
      return;
    }
    const snapshot = path.match(/^\/named-snapshots\/([^/]+)$/);
    if (snapshot) {
      if (decodeURIComponent(snapshot[1]) !== this.#snapshotName || !["GET", "DELETE"].includes(method)) {
        throw new Error("lease proxy rejected snapshot access");
      }
      return;
    }
    const operation = path.match(/^\/deletion-operations\/([^/]+)$/);
    if (operation) {
      if (method !== "GET" || !this.#operationIds.has(decodeURIComponent(operation[1]))) {
        throw new Error("lease proxy rejected deletion operation access");
      }
      return;
    }
    const box = path.match(/^\/boxes\/([^/]+)(?:\/(resume|commands|files|stop|desktop))?$/);
    if (!box || !this.#boxIds.has(decodeURIComponent(box[1]))) {
      throw new Error("lease proxy rejected Box access");
    }
    const suffix = box[2] || "";
    if (!suffix && method === "GET") return;
    if (!suffix && method === "DELETE") return;
    if (!suffix && method === "PATCH") {
      const keys = Object.keys(body ?? {});
      if (!body || keys.some((key) => !["name", "ttlSeconds"].includes(key))
        || (body.name !== undefined && !this.#allowedNames.has(body.name))
        || (body.ttlSeconds !== undefined && (!Number.isSafeInteger(body.ttlSeconds)
          || body.ttlSeconds < 1 || body.ttlSeconds > 21_600))) {
        throw new Error("lease proxy rejected Box settings");
      }
      return;
    }
    if (suffix === "resume" && method === "POST") {
      const evidence = this.#evidenceByBox.get(decodeURIComponent(box[1]));
      if (!body || body.noEnv !== true || !Number.isSafeInteger(body.ttlSeconds)
        || body.ttlSeconds < 1 || body.ttlSeconds > 21_600
        || Object.keys(body).some((key) => !["noEnv", "ttlSeconds"].includes(key))
        || evidence?.stoppedAt === undefined) {
        throw new Error("lease proxy rejected Box resume");
      }
      return { boxId: decodeURIComponent(box[1]), resumeStartedAt: Date.now() };
    }
    if (suffix === "commands" && method === "POST") {
      if (!this.#runtimeHashes) throw new Error("lease proxy runtime attestation is unavailable");
      const command = stringValue(body?.command);
      if (!body || command === null || command.length > MAX_BODY_BYTES
        || !Number.isSafeInteger(body.timeoutSeconds) || body.timeoutSeconds < 1
        || body.timeoutSeconds > 300
        || Object.keys(body).some((key) => !["command", "timeoutSeconds"].includes(key))) {
        throw new Error("lease proxy rejected Box command");
      }
      const prompt = brokerPrompt(command);
      const authorization = {
        boxId: decodeURIComponent(box[1]),
        brokerPrompt: prompt,
      };
      if (prompt) {
        authorization.providerBody = {
          command: canonicalBrokerPromptCommand(
            prompt,
            this.#brokerSha256,
            this.#runtimeHashes,
          ),
          timeoutSeconds: 18,
        };
      }
      return authorization;
    }
    if (suffix === "files" && method === "PUT") {
      if (!this.#runtimeHashes) throw new Error("lease proxy runtime attestation is unavailable");
      return;
    }
    if (suffix === "stop" && method === "POST") {
      const evidence = this.#evidenceByBox.get(decodeURIComponent(box[1]));
      if (!body || body.force !== false || Object.keys(body).some((key) => key !== "force")) {
        throw new Error("lease proxy rejected Box stop");
      }
      if (evidence?.createOrdinal > 0 && evidence.createPromptAckAt === undefined) {
        throw new Error("lease proxy rejected Box stop before prompt acknowledgement");
      }
      return { boxId: decodeURIComponent(box[1]) };
    }
    throw new Error("lease proxy rejected provider operation");
  }

  async #observe(method, path, status, raw, authorization) {
    let body;
    try {
      body = JSON.parse(raw.toString("utf8"));
    } catch {
      if (path === "/boxes" && method === "POST" && status >= 200 && status < 300) {
        throw new Error("lease proxy received invalid Box create response");
      }
      return raw;
    }
    if (path === "/boxes" && method === "GET" && Array.isArray(body.boxes)) {
      body.boxes = body.boxes.filter((box) =>
        this.#boxIds.has(box?.id) || this.#allowedNames.has(box?.name));
      for (const box of body.boxes) if (BOX_ID_PATTERN.test(box.id)) this.#boxIds.add(box.id);
      return Buffer.from(JSON.stringify(body));
    }
    if (path === "/boxes" && method === "POST" && status >= 200 && status < 300) {
      const id = stringValue(body?.box?.id);
      if (id !== null && BOX_ID_PATTERN.test(id)) {
        this.#boxIds.add(id);
        this.#createdIds.add(id);
      }
      if (!validBoxCreateEnvelope(status, body)) {
        throw new Error("lease proxy received invalid Box create response");
      }
      if (this.#createInFlight !== authorization) {
        throw new Error("lease proxy Box create state is inconsistent");
      }
      this.#boxIds.add(id);
      this.#evidenceByBox.set(id, {
        createOrdinal: authorization.createOrdinal,
        createStartedAt: authorization.startedAt,
      });
      this.#createsIssued += 1;
      this.#createInFlight = null;
    }
    const exactBox = path.match(/^\/boxes\/([^/]+)$/);
    if (exactBox && method === "GET" && status >= 200 && status < 300
      && ["ready", "idle", "running"].includes(body?.box?.state)) {
      const evidence = this.#evidenceByBox.get(decodeURIComponent(exactBox[1]));
      if (evidence) {
        if (evidence.createOrdinal === 0 && !this.#runtimeHashes) {
          this.#runtimeHashes = await this.#captureRuntimeHashes(decodeURIComponent(exactBox[1]));
        }
        if (evidence.resumeStartedAt !== undefined && evidence.resumeReadyAt === undefined) {
          evidence.resumeReadyAt = Date.now();
        } else if (evidence.createReadyAt === undefined) {
          evidence.createReadyAt = Date.now();
        }
      }
    }
    if (path === "/named-snapshots" && method === "GET") {
      if (!Array.isArray(body?.snapshots)) return raw;
      if (status === 200 && !this.#parentSnapshotResolved) {
        const parent = selectTrustedParent(body.snapshots, this.#snapshotName);
        this.#parentSnapshotName = parent?.name ?? null;
        this.#parentSnapshotResolved = true;
      }
      const target = body.snapshots.find((snapshot) => snapshot?.name === this.#snapshotName);
      const parent = this.#parentSnapshotName
        ? body.snapshots.find((snapshot) => snapshot?.name === this.#parentSnapshotName
          && snapshot?.status === "ready")
        : null;
      body.snapshots = [target, parent].filter(Boolean);
      return Buffer.from(JSON.stringify(body));
    }
    if (path === "/named-snapshots" && method === "POST" && status >= 200 && status < 300) {
      if (body?.snapshot?.name !== this.#snapshotName) {
        throw new Error("lease proxy received invalid snapshot identity");
      }
      this.#snapshotSaved = true;
    }
    const operation = body?.operation;
    if (OPERATION_ID_PATTERN.test(operation?.id ?? "") && this.#boxIds.has(operation?.targetId)) {
      this.#operationIds.add(operation.id);
    }
    if (/^\/boxes\/[^/]+\/resume$/.test(path) && method === "POST" && status < 300) {
      this.#resumes += 1;
      const evidence = this.#evidenceByBox.get(authorization.boxId);
      if (evidence) evidence.resumeStartedAt = authorization.resumeStartedAt;
    }
    if (/^\/boxes\/[^/]+\/stop$/.test(path) && method === "POST" && status < 300) {
      this.#archives += 1;
      const evidence = this.#evidenceByBox.get(authorization.boxId);
      if (evidence) evidence.stoppedAt = Date.now();
    }
    if (/^\/boxes\/[^/]+\/commands$/.test(path) && method === "POST" && status < 300) this.#commands += 1;
    if (authorization?.brokerPrompt && promptWasAcknowledged(body, authorization.brokerPrompt)) {
      const evidence = this.#evidenceByBox.get(authorization.boxId);
      if (evidence) {
        if (evidence.resumeStartedAt !== undefined) evidence.resumePromptAckAt = Date.now();
        else evidence.createPromptAckAt = Date.now();
      }
    }
    return raw;
  }

  #clearCreateInFlight(authorization) {
    if (authorization && this.#createInFlight === authorization) this.#createInFlight = null;
  }

  #blockCreate(authorization) {
    if (!authorization || this.#createInFlight !== authorization) return;
    this.#createInFlight = null;
    this.#createsBlocked = true;
  }

  async #captureRuntimeHashes(boxId) {
    const command = `set -euo pipefail
companion_pi_lookup="$(command -v pi)"
export PATH=/usr/local/bin:/usr/bin:/bin
companion_pi_bin="$(/usr/bin/readlink -f "$companion_pi_lookup")"
companion_node_bin="$(/usr/bin/readlink -f "$(command -v node)")"
test -n "$companion_pi_bin"
test -n "$companion_node_bin"
printf 'pi %s\\n' "$(/usr/bin/sha256sum "$companion_pi_bin" | /usr/bin/cut -d' ' -f1)"
printf 'node %s\\n' "$(/usr/bin/sha256sum "$companion_node_bin" | /usr/bin/cut -d' ' -f1)"
printf 'pi_path %s\\n' "$companion_pi_bin"
printf 'node_path %s\\n' "$companion_node_bin"
printf 'pi_uid %s\\n' "$(/usr/bin/stat -Lc '%u' "$companion_pi_bin")"
printf 'pi_mode %s\\n' "$(/usr/bin/stat -Lc '%a' "$companion_pi_bin")"
printf 'uid %s\\n' "$(/usr/bin/id -u)"`;
    const deadline = Date.now() + RUNTIME_ATTESTATION_DEADLINE_MS;
    for (;;) {
      await this.#assertLeaseOwner();
      let body = null;
      try {
        const response = await fetch(
          `${this.#upstreamBase}/boxes/${encodeURIComponent(boxId)}/commands`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${this.#apiKey}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              command,
              timeoutSeconds: RUNTIME_ATTESTATION_COMMAND_SECONDS,
            }),
            signal: AbortSignal.timeout(
              Math.max(1, Math.min(7_000, deadline - Date.now())),
            ),
          },
        );
        if (response.ok) body = await response.json().catch(() => null);
      } catch {
        body = null;
      }
      await this.#assertLeaseOwner();
      const lines = String(body?.stdout ?? "").split(/\r?\n/);
      const hashes = Object.fromEntries(lines
        .map((line) => /^(pi|node) ([a-f0-9]{64})$/.exec(line))
        .filter(Boolean)
        .map((match) => [match[1], match[2]]));
      const paths = Object.fromEntries(lines
        .map((line) => /^(pi_path|node_path) (\/[A-Za-z0-9._/@+-]{1,500})$/.exec(line))
        .filter(Boolean)
        .map((match) => [match[1], match[2]]));
      const ownership = Object.fromEntries(lines
        .map((line) => /^(pi_uid|pi_mode) ([0-9]{1,10})$/.exec(line))
        .filter(Boolean)
        .map((match) => [match[1], match[2]]));
      const uid = /(?:^|\n)uid ([1-9][0-9]{0,9})(?:\n|$)/
        .exec(String(body?.stdout ?? ""))?.[1];
      const piMode = ownership.pi_mode;
      const piUid = ownership.pi_uid;
      const safePiMode = /^[0-7]{3,4}$/.test(piMode ?? "")
        && (Number.parseInt(piMode, 8) & 0o022) === 0;
      if (body?.success === true && /^[a-f0-9]{64}$/.test(hashes.pi ?? "")
        && /^[a-f0-9]{64}$/.test(hashes.node ?? "")
        && paths.pi_path && paths.node_path && uid && safePiMode
        && (piUid === "0" || piUid === uid)) {
        return {
          ...hashes,
          piPath: paths.pi_path,
          nodePath: paths.node_path,
          piUid,
          piMode,
          uid,
        };
      }
      if (body?.success === true) {
        throw new Error("lease proxy received invalid runtime attestation");
      }
      if (Date.now() >= deadline) {
        throw new Error("lease proxy received invalid runtime attestation");
      }
      await new Promise((resolvePause) => setTimeout(resolvePause, RUNTIME_ATTESTATION_POLL_MS));
    }
  }

  async prove(input) {
    if (input.cycles !== this.#maximumCreates - 1
      || this.#createdIds.size !== this.#maximumCreates || !this.#snapshotSaved
      || this.#resumes < input.cycles || this.#archives < input.cycles
      || this.#commands < input.cycles * 2) {
      throw new Error("lease proxy provider evidence is incomplete");
    }
    for (const boxId of this.#createdIds) {
      const response = await fetch(`${this.#upstreamBase}/boxes/${encodeURIComponent(boxId)}`, {
        headers: { Authorization: `Bearer ${this.#apiKey}` },
      });
      if (response.status !== 404) throw new Error("lease proxy Box cleanup was not proven");
    }
    const snapshot = await fetch(
      `${this.#upstreamBase}/named-snapshots/${encodeURIComponent(this.#snapshotName)}`,
      { headers: { Authorization: `Bearer ${this.#apiKey}` } },
    );
    if (snapshot.status !== 404) throw new Error("lease proxy snapshot cleanup was not proven");
    const cycles = [...this.#evidenceByBox.values()]
      .filter((item) => item.createOrdinal > 0)
      .sort((left, right) => left.createOrdinal - right.createOrdinal);
    if (cycles.length !== input.cycles || cycles.some((item) =>
      !Number.isFinite(item.createStartedAt) || !Number.isFinite(item.createReadyAt)
      || !Number.isFinite(item.createPromptAckAt) || item.createPromptAckAt < item.createReadyAt
      || !Number.isFinite(item.stoppedAt) || item.stoppedAt < item.createPromptAckAt
      || !Number.isFinite(item.resumeStartedAt) || item.resumeStartedAt < item.stoppedAt
      || !Number.isFinite(item.resumeReadyAt)
      || !Number.isFinite(item.resumePromptAckAt) || item.resumePromptAckAt < item.resumeReadyAt)) {
      throw new Error("lease proxy prompt acknowledgement evidence is incomplete");
    }
    return {
      createdBoxes: this.#createdIds.size,
      resumedBoxes: this.#resumes,
      archivedBoxes: this.#archives,
      commandCalls: this.#commands,
      cleanupProven: true,
      metrics: {
        provider_start: distribution(cycles.map((item) => item.createReadyAt - item.createStartedAt)),
        ready_to_prompt_ack: distribution(cycles.map((item) =>
          item.createPromptAckAt - item.createReadyAt)),
        resume_provider_start: distribution(cycles.map((item) =>
          item.resumeReadyAt - item.resumeStartedAt)),
        resume_ready_to_prompt_ack: distribution(cycles.map((item) =>
          item.resumePromptAckAt - item.resumeReadyAt)),
      },
    };
  }
}

export async function createBoxLeaseProxy(input) {
  const proxy = new BoxLeaseProxy(input);
  const connection = await proxy.start();
  return { proxy, ...connection };
}
