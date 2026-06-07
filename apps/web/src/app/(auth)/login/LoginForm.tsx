"use client";

import { useState } from "react";
import { Button } from "@/components/cds";

export function LoginForm({ next = "/skills" }: { next?: string }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(mode === "signin" ? "/auth/sign-in/email" : "/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email,
          password,
          name: email.split("@")[0] ?? email,
        }),
      });
      if (!res.ok) {
        const json = (await res.json().catch(() => ({}))) as { message?: string; error?: { message?: string } };
        setError(json.error?.message ?? json.message ?? "Authentication failed");
        return;
      }
      window.location.replace(next);
    } catch {
      setError("Could not reach the authentication server");
    } finally {
      setBusy(false);
    }
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
              minLength={8}
              required
            />
          </div>
          {error ? <div className="autherr" role="alert">{error}</div> : null}
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? "Working..." : mode === "signin" ? "Sign in" : "Create account"}
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
