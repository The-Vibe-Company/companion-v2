import Link from "next/link";
import { getServerSupabase } from "@/lib/supabase/server";
import { AcceptInvite } from "@/components/org/AcceptInvite";

export const dynamic = "force-dynamic";

/** Public invite-link landing. Signed-in users can redeem; others are asked to sign in first. */
export default async function JoinPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const supabase = await getServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return (
      <div className="authwrap">
        <div className="authcard">
          <div className="authcard__brand">
            <span className="brandmark">C</span>
            <div>
              <div className="brandname">Companion</div>
              <div className="brandsub">join workspace</div>
            </div>
          </div>
          <div>
            <h1 className="authcard__title">You&apos;ve been invited</h1>
            <p className="authcard__desc">
              Sign in (or create an account) with the email this invite was sent to, then open the link again to join.
            </p>
          </div>
          <Link className="btn-primary" href="/login" style={{ justifyContent: "center" }}>
            Sign in to continue
          </Link>
        </div>
      </div>
    );
  }

  return <AcceptInvite token={token} />;
}
