import { NextResponse, type NextRequest } from "next/server";

export function canonicalAliasRedirect(request: NextRequest, configuredWebUrl = process.env.COMPANION_WEB_URL) {
  if (!configuredWebUrl) return null;

  let canonical: URL;
  try {
    canonical = new URL(configuredWebUrl);
  } catch {
    return null;
  }

  const canonicalHost = canonical.hostname.toLowerCase();
  const aliasHost = canonicalHost.startsWith("www.") ? canonicalHost.slice(4) : `www.${canonicalHost}`;
  if (request.nextUrl.hostname.toLowerCase() !== aliasHost) return null;

  const destination = request.nextUrl.clone();
  destination.protocol = canonical.protocol;
  destination.hostname = canonical.hostname;
  destination.port = canonical.port;
  return destination;
}

function isAgentAuthProxyPath(pathname: string): boolean {
  return pathname === "/v1"
    || pathname.startsWith("/v1/")
    || pathname === "/auth/agent"
    || pathname.startsWith("/auth/agent/")
    || pathname === "/auth/host"
    || pathname.startsWith("/auth/host/")
    || pathname === "/auth/capability"
    || pathname.startsWith("/auth/capability/");
}

/**
 * Preserve the fixed public Agent Auth origin across the external Next.js rewrite. Hosting proxies
 * may replace the standard forwarding headers with their own service host, so the API consumes this
 * exact configured-origin marker and still canonicalizes Better Auth's JWT audience to one value.
 */
export function agentAuthProxyHeaders(
  request: NextRequest,
  configuredWebUrl = process.env.COMPANION_WEB_URL,
): Headers | null {
  if (!configuredWebUrl || !isAgentAuthProxyPath(request.nextUrl.pathname)) return null;
  let origin: string;
  try {
    const configured = new URL(configuredWebUrl);
    if (!["http:", "https:"].includes(configured.protocol) || configured.username || configured.password) return null;
    origin = configured.origin;
  } catch {
    return null;
  }
  const headers = new Headers(request.headers);
  headers.set("x-companion-agent-auth-origin", origin);
  return headers;
}

export function middleware(request: NextRequest) {
  const destination = canonicalAliasRedirect(request);
  if (destination) return NextResponse.redirect(destination, 308);
  const headers = agentAuthProxyHeaders(request);
  return headers ? NextResponse.next({ request: { headers } }) : NextResponse.next();
}
