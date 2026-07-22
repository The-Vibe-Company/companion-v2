import { redirect } from "next/navigation";
import { loadServerAuth } from "@/lib/serverAuth";
import { DeviceCapabilitiesApproval } from "./DeviceCapabilitiesApproval";

export const dynamic = "force-dynamic";

function valueOf(value: string | string[] | undefined): string {
  return typeof value === "string" ? value : "";
}

export default async function DeviceCapabilitiesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const agentId = valueOf(params.agent_id);
  const code = valueOf(params.code).trim().toUpperCase();
  const returnPath = `/device/capabilities?agent_id=${encodeURIComponent(agentId)}&code=${encodeURIComponent(code)}`;
  const auth = await loadServerAuth();
  if (auth.status === "unauthenticated") redirect(`/login?next=${encodeURIComponent(returnPath)}`);

  return (
    <main className="device-approval-page">
      {auth.status === "unavailable" ? (
        <section className="device-approval device-approval--error" role="alert">
          <h1>Approval unavailable</h1>
          <p>Companion could not verify your session. Refresh when the API is reachable.</p>
        </section>
      ) : (
        <DeviceCapabilitiesApproval agentId={agentId} code={code} />
      )}
    </main>
  );
}
