import { createHash, randomBytes } from "node:crypto";

/**
 * Provider OAuth constants and credential shapes mirror the Pi version deployed into Companion
 * Boxes. They are public native-app clients, so deployments do not need provider client secrets.
 * Tokens are returned only to the provider persistence service and never to the browser.
 */
const ANTHROPIC_CLIENT_ID = Buffer.from(
  "OWQxYzI1MGEtZTYxYi00NGQ5LTg4ZWQtNTk0NGQxOTYyZjVl",
  "base64",
).toString("utf8");
const ANTHROPIC_AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
const ANTHROPIC_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const ANTHROPIC_REDIRECT_URI = "http://localhost:53692/callback";
const ANTHROPIC_SCOPES =
  "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";

const OPENAI_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const OPENAI_AUTH_BASE_URL = "https://auth.openai.com";
const OPENAI_DEVICE_USER_CODE_URL = `${OPENAI_AUTH_BASE_URL}/api/accounts/deviceauth/usercode`;
const OPENAI_DEVICE_TOKEN_URL = `${OPENAI_AUTH_BASE_URL}/api/accounts/deviceauth/token`;
const OPENAI_DEVICE_VERIFICATION_URL = `${OPENAI_AUTH_BASE_URL}/codex/device`;
const OPENAI_DEVICE_REDIRECT_URI = `${OPENAI_AUTH_BASE_URL}/deviceauth/callback`;
const OPENAI_TOKEN_URL = `${OPENAI_AUTH_BASE_URL}/oauth/token`;
const OPENAI_DEVICE_TTL_SECONDS = 15 * 60;
const OPENAI_ACCOUNT_CLAIM = "https://api.openai.com/auth";

export const COMPANION_PROVIDER_OAUTH_TTL_MS = 15 * 60_000;

export type CompanionProviderOAuthCredential = {
  type: "oauth";
  access: string;
  refresh: string;
  expires: number;
  accountId?: string;
};

export type CompanionProviderOAuthPendingFlow =
  | {
      providerId: "anthropic";
      verifier: string;
      state: string;
      expiresAt: number;
    }
  | {
      providerId: "openai-codex";
      deviceAuthId: string;
      userCode: string;
      pollIntervalSeconds: number;
      expiresAt: number;
    };

export class CompanionProviderOAuthError extends Error {
  constructor(
    readonly code: "oauth_invalid" | "oauth_expired" | "oauth_unavailable",
    message: string,
  ) {
    super(message);
    this.name = "CompanionProviderOAuthError";
  }
}

function base64url(value: Buffer): string {
  return value.toString("base64url");
}

function generatePkce(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

async function request(
  url: string,
  init: RequestInit,
  fetchImpl: typeof fetch,
): Promise<Response> {
  try {
    return await fetchImpl(url, {
      ...init,
      signal: init.signal ?? AbortSignal.timeout(30_000),
    });
  } catch {
    throw new CompanionProviderOAuthError(
      "oauth_unavailable",
      "The provider sign-in service is unavailable. Try again.",
    );
  }
}

export function beginAnthropicProviderOAuth(): {
  authorizationUrl: string;
  flow: Extract<CompanionProviderOAuthPendingFlow, { providerId: "anthropic" }>;
} {
  const { verifier, challenge } = generatePkce();
  const state = base64url(randomBytes(32));
  const params = new URLSearchParams({
    code: "true",
    client_id: ANTHROPIC_CLIENT_ID,
    response_type: "code",
    redirect_uri: ANTHROPIC_REDIRECT_URI,
    scope: ANTHROPIC_SCOPES,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
  });
  return {
    authorizationUrl: `${ANTHROPIC_AUTHORIZE_URL}?${params.toString()}`,
    flow: {
      providerId: "anthropic",
      verifier,
      state,
      expiresAt: Date.now() + COMPANION_PROVIDER_OAUTH_TTL_MS,
    },
  };
}

function parseAnthropicAuthorizationInput(value: string): { code: string; state?: string } {
  const input = value.trim();
  try {
    const url = new URL(input);
    const code = url.searchParams.get("code");
    if (code) return { code, state: url.searchParams.get("state") ?? undefined };
  } catch {
    // Pi also accepts the displayed one-time code and code#state form.
  }
  if (input.includes("#")) {
    const [code, state] = input.split("#", 2);
    if (code) return { code, state };
  }
  if (input.includes("code=")) {
    const params = new URLSearchParams(input);
    const code = params.get("code");
    if (code) return { code, state: params.get("state") ?? undefined };
  }
  return { code: input };
}

export async function completeAnthropicProviderOAuth(input: {
  flow: Extract<CompanionProviderOAuthPendingFlow, { providerId: "anthropic" }>;
  authorizationInput: string;
  fetchImpl?: typeof fetch;
}): Promise<CompanionProviderOAuthCredential> {
  if (input.flow.expiresAt < Date.now()) {
    throw new CompanionProviderOAuthError("oauth_expired", "Claude sign-in expired. Start again.");
  }
  const parsed = parseAnthropicAuthorizationInput(input.authorizationInput);
  if (!parsed.code || parsed.state !== input.flow.state) {
    throw new CompanionProviderOAuthError(
      "oauth_invalid",
      "Claude returned an invalid authorization code. Paste the complete code or redirect URL.",
    );
  }
  const response = await request(ANTHROPIC_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      client_id: ANTHROPIC_CLIENT_ID,
      code: parsed.code,
      state: parsed.state,
      redirect_uri: ANTHROPIC_REDIRECT_URI,
      code_verifier: input.flow.verifier,
    }),
  }, input.fetchImpl ?? fetch);
  if (!response.ok) {
    throw new CompanionProviderOAuthError(
      "oauth_invalid",
      "Claude could not verify that authorization code. Start sign-in again.",
    );
  }
  const data = await response.json() as {
    access_token?: unknown;
    refresh_token?: unknown;
    expires_in?: unknown;
  };
  if (
    typeof data.access_token !== "string"
    || typeof data.refresh_token !== "string"
    || typeof data.expires_in !== "number"
  ) {
    throw new CompanionProviderOAuthError("oauth_invalid", "Claude returned an invalid sign-in response.");
  }
  return {
    type: "oauth",
    access: data.access_token,
    refresh: data.refresh_token,
    expires: Date.now() + data.expires_in * 1000 - 5 * 60_000,
  };
}

export async function beginOpenAICodexProviderOAuth(input: {
  fetchImpl?: typeof fetch;
} = {}): Promise<{
  verificationUrl: string;
  userCode: string;
  pollIntervalSeconds: number;
  flow: Extract<CompanionProviderOAuthPendingFlow, { providerId: "openai-codex" }>;
}> {
  const response = await request(OPENAI_DEVICE_USER_CODE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: OPENAI_CLIENT_ID }),
  }, input.fetchImpl ?? fetch);
  if (!response.ok) {
    throw new CompanionProviderOAuthError(
      "oauth_unavailable",
      "Codex device sign-in is unavailable. Try again.",
    );
  }
  const data = await response.json() as {
    device_auth_id?: unknown;
    user_code?: unknown;
    interval?: unknown;
  };
  const interval = typeof data.interval === "string" ? Number(data.interval) : data.interval;
  if (
    typeof data.device_auth_id !== "string"
    || typeof data.user_code !== "string"
    || typeof interval !== "number"
    || !Number.isFinite(interval)
  ) {
    throw new CompanionProviderOAuthError("oauth_invalid", "Codex returned an invalid device code.");
  }
  const pollIntervalSeconds = Math.max(1, Math.min(60, Math.ceil(interval)));
  const expiresAt = Date.now() + OPENAI_DEVICE_TTL_SECONDS * 1000;
  return {
    verificationUrl: OPENAI_DEVICE_VERIFICATION_URL,
    userCode: data.user_code,
    pollIntervalSeconds,
    flow: {
      providerId: "openai-codex",
      deviceAuthId: data.device_auth_id,
      userCode: data.user_code,
      pollIntervalSeconds,
      expiresAt,
    },
  };
}

function decodeOpenAIAccountId(accessToken: string): string | null {
  try {
    const payload = JSON.parse(
      Buffer.from(accessToken.split(".")[1] ?? "", "base64url").toString("utf8"),
    ) as { [OPENAI_ACCOUNT_CLAIM]?: { chatgpt_account_id?: unknown } };
    const accountId = payload[OPENAI_ACCOUNT_CLAIM]?.chatgpt_account_id;
    return typeof accountId === "string" && accountId ? accountId : null;
  } catch {
    return null;
  }
}

export async function pollOpenAICodexProviderOAuth(input: {
  flow: Extract<CompanionProviderOAuthPendingFlow, { providerId: "openai-codex" }>;
  fetchImpl?: typeof fetch;
}): Promise<
  | { status: "pending" }
  | { status: "complete"; credential: CompanionProviderOAuthCredential }
> {
  if (input.flow.expiresAt < Date.now()) {
    throw new CompanionProviderOAuthError("oauth_expired", "Codex device sign-in expired. Start again.");
  }
  const fetchImpl = input.fetchImpl ?? fetch;
  const response = await request(OPENAI_DEVICE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      device_auth_id: input.flow.deviceAuthId,
      user_code: input.flow.userCode,
    }),
  }, fetchImpl);
  if (response.status === 403 || response.status === 404) return { status: "pending" };
  if (!response.ok) {
    const responseBody = await response.text().catch(() => "");
    let errorCode: unknown;
    try {
      const data = JSON.parse(responseBody) as {
        error?: string | { code?: unknown };
      } | null;
      errorCode = typeof data?.error === "object" ? data.error?.code : data?.error;
    } catch {
      // A non-JSON provider error is terminal and handled below.
    }
    if (errorCode === "deviceauth_authorization_pending" || errorCode === "slow_down") {
      return { status: "pending" };
    }
    throw new CompanionProviderOAuthError("oauth_invalid", "Codex device sign-in failed. Start again.");
  }
  const device = await response.json() as {
    authorization_code?: unknown;
    code_verifier?: unknown;
  };
  if (typeof device.authorization_code !== "string" || typeof device.code_verifier !== "string") {
    throw new CompanionProviderOAuthError("oauth_invalid", "Codex returned an invalid authorization.");
  }
  const tokenResponse = await request(OPENAI_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: OPENAI_CLIENT_ID,
      code: device.authorization_code,
      code_verifier: device.code_verifier,
      redirect_uri: OPENAI_DEVICE_REDIRECT_URI,
    }),
  }, fetchImpl);
  if (!tokenResponse.ok) {
    throw new CompanionProviderOAuthError("oauth_invalid", "Codex could not finish device sign-in.");
  }
  const token = await tokenResponse.json() as {
    access_token?: unknown;
    refresh_token?: unknown;
    expires_in?: unknown;
  };
  if (
    typeof token.access_token !== "string"
    || typeof token.refresh_token !== "string"
    || typeof token.expires_in !== "number"
  ) {
    throw new CompanionProviderOAuthError("oauth_invalid", "Codex returned an invalid sign-in response.");
  }
  const accountId = decodeOpenAIAccountId(token.access_token);
  if (!accountId) {
    throw new CompanionProviderOAuthError("oauth_invalid", "Codex sign-in did not identify an account.");
  }
  return {
    status: "complete",
    credential: {
      type: "oauth",
      access: token.access_token,
      refresh: token.refresh_token,
      expires: Date.now() + token.expires_in * 1000,
      accountId,
    },
  };
}
