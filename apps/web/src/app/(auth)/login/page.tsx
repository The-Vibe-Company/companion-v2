import { redirect } from "next/navigation";
import { LoginForm } from "./LoginForm";
import { serverApiFetch } from "@/lib/apiServer";

function safeNext(value: string | string[] | undefined): string {
  const next = typeof value === "string" ? value : "";
  return next.startsWith("/") && !next.startsWith("//") ? next : "/skills";
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await serverApiFetch("/v1/auth/whoami").catch(() => null);
  const next = safeNext((await searchParams).next);
  if (user) redirect(next);

  return <LoginForm next={next} />;
}
