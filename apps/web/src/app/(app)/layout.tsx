import { redirect } from "next/navigation";
import { SessionKeepAlive } from "@/components/auth/SessionKeepAlive";
import { AuthUnavailable } from "@/components/org/WorkspaceLoadError";
import { loadServerAuth } from "@/lib/serverAuth";

export default async function AppLayout({
  children,
  settings,
}: {
  children: React.ReactNode;
  settings: React.ReactNode;
}) {
  const authState = await loadServerAuth();
  if (authState.status === "unauthenticated") redirect("/login");
  if (authState.status === "unavailable") return <AuthUnavailable />;
  return (
    <>
      <SessionKeepAlive />
      {children}
      {settings}
    </>
  );
}
