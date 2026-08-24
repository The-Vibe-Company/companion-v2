import type {
  Companion,
  CompanionDecision,
  CompanionThread,
  CompanionTurn,
  CreateCompanionInput,
  NamedResource,
  OnboardingContext,
  ProvidersResponse,
  Session,
  WhoAmI,
} from "./types";
import { ApiError } from "./types";

export const apiUrl = (process.env.EXPO_PUBLIC_API_URL ?? "http://127.0.0.1:3001").replace(/\/$/, "");

let activeSession: Session | null = null;
let unauthorized: (() => void) | null = null;

type ApiErrorPayload = {
  code?: string;
  error?: string;
  message?: string;
};

type ParsedApiError = { code: string | null; message: string };
type RequestOptions = { invalidateSessionOnUnauthorized?: boolean };

export function configureApi(session: Session | null, onUnauthorized?: () => void): void {
  activeSession = session;
  unauthorized = onUnauthorized ?? null;
}

function messageFromPayload(payload: ApiErrorPayload, fallback: string): ParsedApiError {
  return {
    code: payload.code ?? null,
    message: payload.message ?? payload.error ?? fallback,
  };
}

async function requestResponse(
  path: string,
  init: RequestInit = {},
  options: RequestOptions = {},
): Promise<Response> {
  const method = (init.method ?? "GET").toUpperCase();
  const headers = new Headers(init.headers);
  if (init.body && !(init.body instanceof FormData)) headers.set("content-type", "application/json");
  if (activeSession?.cookie) headers.set("cookie", activeSession.cookie);
  if (activeSession?.orgId) headers.set("x-companion-org", activeSession.orgId);
  if (method !== "GET" && method !== "HEAD") headers.set("origin", apiUrl);

  let response: Response;
  try {
    response = await fetch(`${apiUrl}${path}`, {
      ...init,
      headers,
      credentials: "omit",
    });
  } catch {
    throw new ApiError(0, "network_error", "The server could not be reached.");
  }
  if (!response.ok) {
    // SAFETY: Error bodies are used only for optional display strings; missing fields fall back.
    const payload = await response.json().catch(() => ({})) as ApiErrorPayload;
    const error = messageFromPayload(payload, `Request failed with status ${response.status}.`);
    if (response.status === 401 && options.invalidateSessionOnUnauthorized !== false) unauthorized?.();
    throw new ApiError(response.status, error.code, error.message);
  }
  return response;
}

async function request<T>(path: string, init?: RequestInit, options?: RequestOptions): Promise<T> {
  const response = await requestResponse(path, init, options);
  return response.json();
}

export async function login(email: string, password: string): Promise<{ cookie: string; me: WhoAmI }> {
  const response = await requestResponse("/v1/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password, name: email.split("@")[0] ?? email }),
  });
  const cookie = response.headers.get("set-cookie");
  if (!cookie) throw new ApiError(500, "missing_session", "The auth server did not return a session.");
  activeSession = {
    cookie,
    orgId: null,
    needsOnboarding: false,
    user: { id: "", email, name: null },
  };
  const me = await whoami();
  return { cookie, me };
}

export function logout(): Promise<void> {
  return requestResponse("/v1/auth/logout", { method: "POST" }).then(() => undefined);
}

export function whoami(): Promise<WhoAmI> {
  return request<WhoAmI>("/v1/auth/whoami");
}

export async function getOnboardingContext(): Promise<OnboardingContext> {
  try {
    return await request<OnboardingContext>(
      "/v1/onboarding/context",
      undefined,
      { invalidateSessionOnUnauthorized: false },
    );
  } catch (cause) {
    if (cause instanceof ApiError && cause.status === 401) {
      // The onboarding route historically maps dependency failures to 401. Confirm the bearer with
      // whoami before allowing the global unauthorized callback to delete a recoverable session.
      await whoami().catch(() => undefined);
    }
    throw cause;
  }
}

export function joinOnboardingOrg(orgId: string): Promise<{ orgId: string }> {
  return request<{ orgId: string }>("/v1/onboarding/join", {
    method: "POST",
    body: JSON.stringify({ orgId }),
  });
}

export function createOnboardingOrg(name: string): Promise<{ orgId: string }> {
  return request<{ orgId: string }>("/v1/onboarding/create", {
    method: "POST",
    body: JSON.stringify({
      org: { name, autoJoin: false },
      invites: [],
    }),
  });
}

export async function listCompanions(): Promise<Companion[]> {
  return request<{ companions: Companion[] }>("/v1/companions?preview=true")
    .then((result) => result.companions);
}

export async function getThread(companionId: string): Promise<{ thread: CompanionThread; raw: string }> {
  const response = await requestResponse(`/v1/companions/${encodeURIComponent(companionId)}/thread`);
  const raw = await response.text();
  // SAFETY: A successful thread route returns the documented `{ thread }` REST contract.
  return { thread: (JSON.parse(raw) as { thread: CompanionThread }).thread, raw };
}

/** One staged file as the native pickers hand it over: a local uri plus its declared name/type. */
export type PickedAttachment = { uri: string; name: string; type: string; byteSize: number };

/** The file descriptor React Native's FormData accepts for a file part. */
type NativeFormFilePart = { uri: string; name: string; type: string };
/** FormData as React Native implements it; the DOM lib this project compiles against types Blob. */
type NativeFormData = { append(name: string, value: string | NativeFormFilePart): void };

export async function sendMessage(
  companionId: string,
  content: string,
  clientMessageId: string,
  files: readonly PickedAttachment[] = [],
): Promise<CompanionTurn> {
  const path = `/v1/companions/${encodeURIComponent(companionId)}/messages`;
  if (files.length === 0) {
    return request<{ turn: CompanionTurn }>(path, {
      method: "POST",
      body: JSON.stringify({
        content,
        client_message_id: clientMessageId,
        client_surface: "mobile_web",
      }),
    }).then((result) => result.turn);
  }
  const form = new FormData();
  // SAFETY: React Native's runtime FormData accepts the file descriptor; only the compile-time DOM
  // lib disagrees, so the append seam is re-typed once through the named contract above.
  const nativeForm = form as NativeFormData;
  nativeForm.append("content", content);
  nativeForm.append("client_message_id", clientMessageId);
  nativeForm.append("client_surface", "mobile_web");
  for (const file of files) {
    nativeForm.append("file", { uri: file.uri, name: file.name, type: file.type });
  }
  return request<{ turn: CompanionTurn }>(path, { method: "POST", body: form })
    .then((result) => result.turn);
}

/** Where one attachment's bytes live; the route re-authorizes on every request. */
export function attachmentUrl(companionId: string, attachmentId: string): string {
  return `${apiUrl}/v1/companions/${encodeURIComponent(companionId)}/attachments/${encodeURIComponent(attachmentId)}`;
}

/** Session headers an image or download request must carry to that per-request route. */
export function sessionHeaders() {
  const headers = new Map<string, string>();
  if (activeSession?.cookie) headers.set("cookie", activeSession.cookie);
  if (activeSession?.orgId) headers.set("x-companion-org", activeSession.orgId);
  return Object.fromEntries(headers);
}

export function listPluginAccounts(): Promise<NamedResource[]> {
  return request<{ accounts: { id: string; label: string }[] }>("/v1/companion-plugins")
    .then((result) => result.accounts.map((account) => ({ id: account.id, label: account.label })));
}

export function listSkillNames(): Promise<NamedResource[]> {
  return request<{ id: string; slug: string }[]>("/v1/skills?lib=accessible")
    .then((rows) => rows.map((row) => ({ id: row.id, label: row.slug })));
}

export function retryTurn(companionId: string, turnId: string, retryId: string): Promise<void> {
  return request(`/v1/companions/${encodeURIComponent(companionId)}/turns/${encodeURIComponent(turnId)}/retry`, {
    method: "POST",
    body: JSON.stringify({ retry_id: retryId }),
  }).then(() => undefined);
}

export function cancelTurn(companionId: string, turnId: string): Promise<CompanionThread> {
  return request<{ thread: CompanionThread }>(
    `/v1/companions/${encodeURIComponent(companionId)}/turns/${encodeURIComponent(turnId)}/cancel`,
    { method: "POST", body: JSON.stringify({}) },
  ).then((result) => result.thread);
}

export function answerDecision(
  companionId: string,
  decision: Pick<CompanionDecision, "request_id">,
  input: { action: "allow" | "deny" } | { action: "answer"; answer: string },
): Promise<CompanionThread> {
  return request<{ thread: CompanionThread }>(
    `/v1/companions/${encodeURIComponent(companionId)}/decisions/${encodeURIComponent(decision.request_id)}`,
    { method: "POST", body: JSON.stringify(input) },
  ).then((result) => result.thread);
}

export function getProviders(): Promise<ProvidersResponse> {
  return request<ProvidersResponse>("/v1/companion-providers");
}

export function createCompanion(input: CreateCompanionInput): Promise<Companion> {
  return request<{ companion: Companion }>("/v1/companions", {
    method: "POST",
    body: JSON.stringify(input),
  }).then((result) => result.companion);
}
