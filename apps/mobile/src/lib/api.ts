import type {
  Companion,
  CompanionDecision,
  CompanionThread,
  CompanionTurn,
  CreateCompanionInput,
  ProvidersResponse,
  Session,
  WhoAmI,
} from "./types";
import { ApiError } from "./types";

const apiUrl = (process.env.EXPO_PUBLIC_API_URL ?? "http://127.0.0.1:3001").replace(/\/$/, "");

let activeSession: Session | null = null;
let unauthorized: (() => void) | null = null;

type ApiErrorPayload = {
  code?: string;
  error?: string;
  message?: string;
};

type ParsedApiError = { code: string | null; message: string };

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

async function requestResponse(path: string, init: RequestInit = {}): Promise<Response> {
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
    if (response.status === 401) unauthorized?.();
    throw new ApiError(response.status, error.code, error.message);
  }
  return response;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await requestResponse(path, init);
  return response.json();
}

export async function login(email: string, password: string): Promise<{ cookie: string; me: WhoAmI }> {
  const response = await requestResponse("/v1/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password, name: email.split("@")[0] ?? email }),
  });
  const cookie = response.headers.get("set-cookie");
  if (!cookie) throw new ApiError(500, "missing_session", "The auth server did not return a session.");
  activeSession = { cookie, orgId: null, user: { id: "", email } };
  const me = await whoami();
  return { cookie, me };
}

export function logout(): Promise<void> {
  return requestResponse("/v1/auth/logout", { method: "POST" }).then(() => undefined);
}

export function whoami(): Promise<WhoAmI> {
  return request<WhoAmI>("/v1/auth/whoami");
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

export async function sendMessage(
  companionId: string,
  content: string,
  clientMessageId: string,
): Promise<CompanionTurn> {
  return request<{ turn: CompanionTurn }>(
    `/v1/companions/${encodeURIComponent(companionId)}/messages`,
    {
      method: "POST",
      body: JSON.stringify({
        content,
        client_message_id: clientMessageId,
        client_surface: "native_mobile",
      }),
    },
  ).then((result) => result.turn);
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
