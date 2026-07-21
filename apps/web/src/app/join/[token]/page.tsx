import { redirect } from "next/navigation";
import { AcceptInvite } from "@/components/org/AcceptInvite";
import { AuthUnavailable } from "@/components/org/WorkspaceLoadError";
import { loadServerAuth } from "@/lib/serverAuth";

export default async function JoinPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const authState = await loadServerAuth();
  if (authState.status === "unauthenticated") redirect(`/login?next=${encodeURIComponent(`/join/${token}`)}`);
  if (authState.status === "unavailable") return <AuthUnavailable />;
  return <AcceptInvite token={token} />;
}
