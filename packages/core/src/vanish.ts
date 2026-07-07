/**
 * Minimal Vanish (vanish.sh) upload client for run artifacts. Framework-free; the ONLY place that
 * talks to the Vanish API, so any contract drift is isolated here. Uploads happen in the API
 * process with the launcher's decrypted key — the key never enters a sandbox.
 *
 * Contract (vanish-cli 0.1.22 / vanish.sh): `POST ${apiUrl}/upload` with `Authorization: Bearer`,
 * raw bytes as the body, `X-Filename` for the name, optional `Idempotency-Key`; JSON response with
 * the public url/id/expiry, or `{code, message, hint, upgradeRequired}` on error.
 */

const DEFAULT_API_URL = "https://vanish.sh";

/** Extensions Vanish rejects (executables/scripts) — filtered before upload, never sent. */
export const VANISH_BLOCKED_EXTENSIONS = [
  ".exe",
  ".bat",
  ".cmd",
  ".com",
  ".msi",
  ".scr",
  ".sh",
  ".bash",
  ".ps1",
  ".psm1",
] as const;

export function vanishBlockedExtension(filename: string): boolean {
  const lower = filename.toLowerCase();
  return VANISH_BLOCKED_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

export interface VanishPublishResult {
  url: string;
  id: string | null;
  expiresAt: string | null;
}

export class VanishError extends Error {
  readonly code: string | null;
  readonly hint: string | null;
  readonly upgradeRequired: boolean;

  constructor(message: string, opts: { code?: string | null; hint?: string | null; upgradeRequired?: boolean } = {}) {
    super(message);
    this.code = opts.code ?? null;
    this.hint = opts.hint ?? null;
    this.upgradeRequired = opts.upgradeRequired ?? false;
  }
}

/**
 * Publish one artifact file. `X-Expires-Days` is deliberately omitted — the account tier's default
 * applies. Field-name drift in the response is normalized here (url/id/expiresAt aliases).
 */
export async function publishRunArtifact(input: {
  apiKey: string;
  filename: string;
  bytes: Buffer;
  idempotencyKey?: string;
  apiUrl?: string;
  /** Test seam. */
  fetcher?: typeof fetch;
}): Promise<VanishPublishResult> {
  const apiUrl = (input.apiUrl ?? (process.env.VANISH_API_URL?.trim() || DEFAULT_API_URL)).replace(/\/+$/, "");
  const fetcher = input.fetcher ?? fetch;
  const basename = input.filename.split("/").pop() || input.filename;

  let res: Response;
  try {
    res = await fetcher(`${apiUrl}/upload`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${input.apiKey}`,
        "content-type": "application/octet-stream",
        "x-filename": basename,
        ...(input.idempotencyKey ? { "idempotency-key": input.idempotencyKey } : {}),
      },
      body: new Uint8Array(input.bytes),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (error) {
    throw new VanishError(`vanish upload failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  let payload: Record<string, unknown> = {};
  try {
    payload = (await res.json()) as Record<string, unknown>;
  } catch {
    // Non-JSON body — fall through to the status check with an empty payload.
  }

  if (!res.ok) {
    const message = typeof payload.message === "string" && payload.message ? payload.message : `vanish responded ${res.status}`;
    throw new VanishError(message, {
      code: typeof payload.code === "string" ? payload.code : null,
      hint: typeof payload.hint === "string" ? payload.hint : null,
      upgradeRequired: payload.upgradeRequired === true,
    });
  }

  const url = firstString(payload, ["url", "publicUrl", "public_url", "link"]);
  if (!url) throw new VanishError("vanish upload succeeded but returned no url");
  return {
    url,
    id: firstString(payload, ["id", "uploadId", "upload_id"]),
    expiresAt: firstString(payload, ["expiresAt", "expires_at", "expiry"]),
  };
}

function firstString(payload: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string" && value) return value;
  }
  return null;
}
