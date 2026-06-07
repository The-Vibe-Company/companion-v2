import { redirect } from "next/navigation";
import { AcceptInvite } from "@/components/org/AcceptInvite";
import { serverApiFetch } from "@/lib/apiServer";

export default async function JoinPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const whoami = await serverApiFetch("/v1/auth/whoami").catch(() => null);
  if (!whoami) redirect(`/login?next=${encodeURIComponent(`/join/${token}`)}`);
  return <AcceptInvite token={token} />;
}
