import { redirect } from "next/navigation";
import { LoginForm } from "./LoginForm";
import { serverApiFetch } from "@/lib/apiServer";

function safeNext(value: string | string[] | undefined): string {
  const next = typeof value === "string" ? value : "";
  if (!next.startsWith("/") || next.startsWith("//") || next.includes("\\")) {
    return "/skills";
  }

  try {
    const parsed = new URL(next, "http://companion.local");
    if (parsed.origin !== "http://companion.local") return "/skills";
    const pathname = parsed.pathname.toLowerCase();
    if (pathname.startsWith("/%2f") || pathname.startsWith("/%5c")) return "/skills";
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return "/skills";
  }
}

function safeMode(value: string | string[] | undefined): "signin" | "signup" {
  return value === "signup" ? "signup" : "signin";
}

function safeError(value: string | string[] | undefined): string | null {
  return typeof value === "string" && value ? value : null;
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await serverApiFetch("/v1/auth/whoami").catch(() => null);
  const params = await searchParams;
  const next = safeNext(params.next);
  if (user) redirect(next);

  return (
    <LoginForm
      next={next}
      initialMode={safeMode(params.mode)}
      initialError={safeError(params.error)}
      initialReset={params.reset === "1"}
    />
  );
}
