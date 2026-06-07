"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { getBrowserSupabase } from "@/lib/supabase/client";
import { Button } from "@/components/cds";

export default function LoginPage() {
  const router = useRouter();
  const supabase = useMemo(() => getBrowserSupabase(), []);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error } =
      mode === "signin"
        ? await supabase.auth.signInWithPassword({ email, password })
        : await supabase.auth.signUp({ email, password });
    setBusy(false);
    if (error) {
      setError(error.message);
      return;
    }
    router.push("/skills");
    router.refresh();
  }

  return (
    <div className="authwrap">
      <form className="authcard" onSubmit={submit}>
        <div className="authcard__brand">
          <span className="brandmark">C</span>
          <div>
            <div className="brandname">Companion</div>
            <div className="brandsub">skills hub</div>
          </div>
        </div>
        <div>
          <h1 className="authcard__title">{mode === "signin" ? "Sign in" : "Create account"}</h1>
          <p className="authcard__desc">
            {mode === "signin"
              ? "Sign in to your Companion workspace."
              : "The first account becomes the organization owner."}
          </p>
        </div>

        <div className="authform">
          <div className="cds-field">
            <label className="cds-field__label" htmlFor="email">
              Email
            </label>
            <input
              id="email"
              className="cds-field__control"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>
          <div className="cds-field">
            <label className="cds-field__label" htmlFor="password">
              Password
            </label>
            <input
              id="password"
              className="cds-field__control"
              type="password"
              autoComplete={mode === "signin" ? "current-password" : "new-password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              minLength={6}
              required
            />
          </div>
          {error ? <div className="autherr">{error}</div> : null}
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? "Working…" : mode === "signin" ? "Sign in" : "Create account"}
          </Button>
          <div className="authrow">
            <span className="authnote">
              {mode === "signin" ? "No account yet?" : "Already have an account?"}
            </span>
            <button
              type="button"
              className="cds-link"
              style={{ background: "none", border: "none", cursor: "pointer", padding: 0 }}
              onClick={() => {
                setMode(mode === "signin" ? "signup" : "signin");
                setError(null);
              }}
            >
              {mode === "signin" ? "Create one" : "Sign in"}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
