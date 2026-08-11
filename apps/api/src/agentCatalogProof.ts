import { createHmac, timingSafeEqual } from "node:crypto";

export interface AgentCatalogProofPayload {
  v: 1;
  snapshot_id: string;
  workspace_id: string;
  user_id: string;
  agent_id: string;
  skill_id: string;
  version_id: string;
  slug: string;
  version: string;
  checksum: string;
  size_bytes: number;
  root_ids: string[];
  exp: number;
}

const PREFIX = "cmp_catalog_v1";

function signingKey(): string {
  const key = process.env.COMPANION_CATALOG_SIGNING_KEY?.trim() || process.env.BETTER_AUTH_SECRET?.trim();
  if (!key) throw new Error("COMPANION_CATALOG_SIGNING_KEY or BETTER_AUTH_SECRET is required");
  return key;
}

function signature(encodedPayload: string): Buffer {
  return createHmac("sha256", signingKey()).update(`${PREFIX}.${encodedPayload}`).digest();
}

export function signAgentCatalogProof(payload: AgentCatalogProofPayload): string {
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${PREFIX}.${encoded}.${signature(encoded).toString("base64url")}`;
}

export function verifyAgentCatalogProof(proof: string, now = Date.now()): AgentCatalogProofPayload {
  const [prefix, encoded, encodedSignature, extra] = proof.split(".");
  if (prefix !== PREFIX || !encoded || !encodedSignature || extra !== undefined) {
    throw new Error("invalid agent catalog proof");
  }
  let supplied: Buffer;
  try {
    supplied = Buffer.from(encodedSignature, "base64url");
  } catch {
    throw new Error("invalid agent catalog proof");
  }
  const expected = signature(encoded);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    throw new Error("invalid agent catalog proof");
  }
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    throw new Error("invalid agent catalog proof");
  }
  if (
    !payload
    || typeof payload !== "object"
    || (payload as { v?: unknown }).v !== 1
    || typeof (payload as { snapshot_id?: unknown }).snapshot_id !== "string"
    || typeof (payload as { workspace_id?: unknown }).workspace_id !== "string"
    || typeof (payload as { user_id?: unknown }).user_id !== "string"
    || typeof (payload as { agent_id?: unknown }).agent_id !== "string"
    || typeof (payload as { skill_id?: unknown }).skill_id !== "string"
    || typeof (payload as { version_id?: unknown }).version_id !== "string"
    || typeof (payload as { slug?: unknown }).slug !== "string"
    || typeof (payload as { version?: unknown }).version !== "string"
    || !/^sha256:[0-9a-f]{64}$/.test(String((payload as { checksum?: unknown }).checksum ?? ""))
    || !Number.isSafeInteger((payload as { size_bytes?: unknown }).size_bytes)
    || !Array.isArray((payload as { root_ids?: unknown }).root_ids)
    || !(payload as { root_ids: unknown[] }).root_ids.every((id) => typeof id === "string")
    || !Number.isSafeInteger((payload as { exp?: unknown }).exp)
  ) {
    throw new Error("invalid agent catalog proof");
  }
  const parsed = payload as AgentCatalogProofPayload;
  if (parsed.exp * 1_000 <= now) throw new Error("agent catalog proof expired");
  return parsed;
}
