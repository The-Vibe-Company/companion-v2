import { NextResponse, type NextRequest } from "next/server";
import { skillShareTargetSchema } from "@companion/contracts";
import { apiBaseUrl } from "@/lib/apiServer";
import { skillDetailHrefForSlug } from "../preview";

type ShareGoParams = { params: Promise<{ token: string }> };

function sharePreviewHref(token: string): string {
  return `/s/${encodeURIComponent(token)}?view=public`;
}

function requestOrigin(request: NextRequest): string {
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  if (!host) return new URL(request.url).origin;
  const proto = request.headers.get("x-forwarded-proto") ?? new URL(request.url).protocol.replace(/:$/, "");
  return `${proto}://${host}`;
}

function localUrl(request: NextRequest, path: string): URL {
  return new URL(path, requestOrigin(request));
}

export async function GET(request: NextRequest, { params }: ShareGoParams): Promise<NextResponse> {
  const { token } = await params;
  const cookie = request.headers.get("cookie") ?? "";

  let response: Response;
  try {
    response = await fetch(`${apiBaseUrl()}/v1/skills/share-target/${encodeURIComponent(token)}`, {
      cache: "no-store",
      headers: { cookie },
    });
  } catch {
    return NextResponse.redirect(localUrl(request, sharePreviewHref(token)));
  }

  if (response.status === 401) {
    return NextResponse.redirect(localUrl(request, `/login?next=${encodeURIComponent(`/s/${token}`)}`));
  }
  if (!response.ok) {
    return NextResponse.redirect(localUrl(request, sharePreviewHref(token)));
  }

  const json = await response.json().catch(() => null);
  const parsed = skillShareTargetSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.redirect(localUrl(request, sharePreviewHref(token)));
  }

  const redirect = NextResponse.redirect(localUrl(request, skillDetailHrefForSlug(parsed.data.slug)));
  redirect.cookies.set("companion_org", parsed.data.org_id, {
    path: "/",
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
  });
  return redirect;
}
