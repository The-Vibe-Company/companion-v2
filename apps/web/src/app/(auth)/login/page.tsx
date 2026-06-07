import { redirect } from "next/navigation";
import { LoginForm } from "./LoginForm";
import { serverApiFetch } from "@/lib/apiServer";

function safeNext(value: string | string[] | undefined): string {
  const next = typeof value === "string" ? value : "";
  return next.startsWith("/") && !next.startsWith("//") ? next : "/skills";
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
      loginAction="/v1/auth/login-redirect"
      next={next}
      initialMode={safeMode(params.mode)}
      initialError={safeError(params.error)}
    />
  );
}
