import { redirect } from "next/navigation";
import { serverApiFetch } from "@/lib/apiServer";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await serverApiFetch("/v1/auth/whoami").catch(() => null);
  if (!user) redirect("/login");
  return <>{children}</>;
}
