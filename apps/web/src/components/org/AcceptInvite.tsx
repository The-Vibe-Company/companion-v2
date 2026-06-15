"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "../Icon";
import { acceptInvite, setCurrentOrg } from "@/lib/org";

/** Invite-link landing: a signed-in user redeems the token, then lands in the new workspace. */
export function AcceptInvite({ token }: { token: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const accept = async () => {
    setBusy(true);
    setError(null);
    try {
      const { orgId } = await acceptInvite(token);
      if (orgId) await setCurrentOrg(orgId);
      setDone(true);
      router.push("/skills");
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="authwrap">
      <div className="authcard">
        <div className="authcard__brand">
          <span className="brandmark" aria-hidden="true" />
          <div>
            <div className="brandname">Companion</div>
            <div className="brandsub">join workspace</div>
          </div>
        </div>
        <div>
          <h1 className="authcard__title">Accept your invite</h1>
          <p className="authcard__desc">
            You&apos;ve been invited to a Companion workspace. Accept to join with the role your admin assigned.
          </p>
        </div>
        {error ? <div className="autherr">{error}</div> : null}
        <button className="btn-primary" disabled={busy || done} onClick={accept}>
          <Icon name="log-in" size={14} />
          {busy ? "Joining..." : done ? "Joined" : "Accept invite"}
        </button>
      </div>
    </div>
  );
}
