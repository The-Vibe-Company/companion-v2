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

export function middleware(request: NextRequest) {
  const destination = canonicalAliasRedirect(request);
  return destination ? NextResponse.redirect(destination, 308) : NextResponse.next();
}
