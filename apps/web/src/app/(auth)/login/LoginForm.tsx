"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/cds";

/* ============================================================================
   Icons — Lucide-style line glyphs (24x24, currentColor, ~1.75 stroke).
   ============================================================================ */
function Svg(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    />
  );
}
const IconEye = () => (
  <Svg>
    <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
    <circle cx="12" cy="12" r="3" />
  </Svg>
);
const IconEyeOff = () => (
  <Svg>
    <path d="M10.7 5.1A9.9 9.9 0 0 1 12 5c6.5 0 10 7 10 7a14 14 0 0 1-2.3 3" />
    <path d="M6.6 6.6A14.5 14.5 0 0 0 2 12s3.5 7 10 7a9.8 9.8 0 0 0 4.5-1.1" />
    <path d="m3 3 18 18" />
    <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
  </Svg>
);
const IconMail = () => (
  <Svg>
    <rect x="2.5" y="4.5" width="19" height="15" rx="2.5" />
    <path d="m3 7 9 6 9-6" />
  </Svg>
);
const IconArrowLeft = () => (
  <Svg>
    <path d="M19 12H5" />
    <path d="m12 19-7-7 7-7" />
  </Svg>
);
const IconAlert = () => (
  <Svg>
    <circle cx="12" cy="12" r="9.5" />
    <path d="M12 7.5v5" />
    <path d="M12 16h.01" />
  </Svg>
);
const IconLockReset = () => (
  <Svg>
    <rect x="4.5" y="11" width="15" height="9.5" rx="2" />
    <path d="M8 11V8a4 4 0 0 1 8 0v3" />
  </Svg>
);

/* Official Google "G" mark — standard for an OAuth button (keep the exact brand hexes). */
const GoogleG = () => (
  <svg viewBox="0 0 48 48" aria-hidden="true">
    <path
      fill="#4285F4"
      d="M45.1 24.5c0-1.6-.1-3.1-.4-4.5H24v8.5h11.8c-.5 2.7-2 5-4.4 6.6v5.5h7.1c4.1-3.8 6.6-9.4 6.6-16.1Z"
    />
    <path
      fill="#34A853"
      d="M24 46c5.9 0 10.9-2 14.5-5.3l-7.1-5.5c-2 1.3-4.5 2.1-7.4 2.1-5.7 0-10.5-3.8-12.2-9h-7.3v5.7C8.1 41.1 15.4 46 24 46Z"
    />
    <path
      fill="#FBBC05"
      d="M11.8 28.3c-.4-1.3-.7-2.7-.7-4.3s.3-3 .7-4.3v-5.7H4.5C3 16.9 2.1 20.3 2.1 24s.9 7.1 2.4 10l7.3-5.7Z"
    />
    <path
      fill="#EA4335"
      d="M24 10.8c3.2 0 6.1 1.1 8.4 3.3l6.3-6.3C34.9 4.1 29.9 2 24 2 15.4 2 8.1 6.9 4.5 14l7.3 5.7c1.7-5.2 6.5-9 12.2-9Z"
    />
  </svg>
);

/* ============================================================================
   Small shared pieces
   ============================================================================ */
function Brand() {
  return (
    <div className="authbrand">
      <span className="brandmark" aria-hidden="true" />
      <div>
        <div className="brandname">Companion</div>
      </div>
    </div>
  );
}

function GoogleButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" className="gbtn" onClick={onClick}>
      <GoogleG />
      {label}
    </button>
  );
}

function Divider({ label }: { label: string }) {
  return (
    <div className="authdiv">
      <span>{label}</span>
    </div>
  );
}

function ErrorNote({ children }: { children: ReactNode }) {
  return (
    <div className="autherr" role="alert">
      <IconAlert />
      <span>{children}</span>
    </div>
  );
}

function Notice({ children }: { children: ReactNode }) {
  return <p className="authnotice">{children}</p>;
}

function SubmitButton({ busy, children }: { busy: boolean; children: ReactNode }) {
  return (
    <Button type="submit" variant="primary" disabled={busy} iconLeft={busy ? <span className="cds-spinner" /> : undefined}>
      {children}
    </Button>
  );
}

function TextField({
  id,
  label,
  type = "text",
  value,
  onChange,
  autoComplete,
  placeholder,
}: {
  id: string;
  label: string;
  type?: string;
  value: string;
  onChange: (v: string) => void;
  autoComplete?: string;
  placeholder?: string;
}) {
  return (
    <div className="cds-field">
      <label className="cds-field__label" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        className="cds-field__control"
        type={type}
        value={value}
        autoComplete={autoComplete}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

function PasswordField({
  id,
  label,
  value,
  onChange,
  autoComplete,
  placeholder,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  autoComplete?: string;
  placeholder?: string;
}) {
  const [show, setShow] = useState(false);
  return (
    <div className="cds-field">
      <span className="cds-field__label">
        <label htmlFor={id}>{label}</label>
      </span>
      <div className="pwwrap">
        <input
          id={id}
          className="cds-field__control"
          type={show ? "text" : "password"}
          value={value}
          autoComplete={autoComplete}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
        <button
          type="button"
          className="pwtoggle"
          onClick={() => setShow((s) => !s)}
          aria-label={show ? "Hide password" : "Show password"}
          title={show ? "Hide password" : "Show password"}
        >
          {show ? <IconEyeOff /> : <IconEye />}
        </button>
      </div>
    </div>
  );
}

/* Password strength: 0 none, 1 weak, 2 ok, 3 strong */
function scorePassword(pw: string): number {
  if (!pw) return 0;
  let s = 0;
  if (pw.length >= 8) s++;
  if (/[A-Z]/.test(pw) && /[a-z]/.test(pw)) s++;
  if (/\d/.test(pw)) s++;
  if (/[^A-Za-z0-9]/.test(pw)) s++;
  if (pw.length < 8) return 1;
  return Math.min(3, Math.max(1, s - 1));
}
function PasswordMeter({ value }: { value: string }) {
  const score = scorePassword(value);
  const tone = score >= 3 ? "strong" : score === 2 ? "ok" : "weak";
  const text = !value
    ? "Use at least 8 characters."
    : score >= 3
      ? "Strong password."
      : score === 2
        ? "Good. Add a symbol to strengthen it."
        : "Weak. Mix upper, lower, and a number.";
  return (
    <div className="pwreq">
      <div className="pwbars">
        {[0, 1, 2, 3].map((i) => (
          <span key={i} className={"pwbar" + (i < score ? " on--" + tone : "")} />
        ))}
      </div>
      <div className="pwreqtext">{text}</div>
    </div>
  );
}

/* ============================================================================
   OTP input — 6 boxes, auto-advance, paste, backspace.
   ============================================================================ */
function OtpInput({
  value,
  onChange,
  error,
  disabled,
  autoFocus,
}: {
  value: string;
  onChange: (v: string) => void;
  error?: boolean;
  disabled?: boolean;
  autoFocus?: boolean;
}) {
  const refs = useRef<Array<HTMLInputElement | null>>([]);
  // Land focus on the first box when the screen mounts so keyboard/SR users can type immediately.
  useEffect(() => {
    if (autoFocus) refs.current[0]?.focus();
  }, [autoFocus]);
  const set = (i: number, ch: string) => {
    const next = value.split("");
    next[i] = ch;
    onChange(next.join("").slice(0, 6));
  };
  const onKey = (i: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Backspace") {
      if (value[i]) {
        set(i, "");
      } else if (i > 0) {
        refs.current[i - 1]?.focus();
        set(i - 1, "");
      }
      e.preventDefault();
    } else if (e.key === "ArrowLeft" && i > 0) {
      refs.current[i - 1]?.focus();
    } else if (e.key === "ArrowRight" && i < 5) {
      refs.current[i + 1]?.focus();
    }
  };
  const onIn = (i: number, e: React.ChangeEvent<HTMLInputElement>) => {
    const ch = e.target.value.replace(/\D/g, "").slice(-1);
    if (!ch) return;
    set(i, ch);
    if (i < 5) refs.current[i + 1]?.focus();
  };
  const onPaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    const txt = (e.clipboardData.getData("text") || "").replace(/\D/g, "").slice(0, 6);
    if (!txt) return;
    e.preventDefault();
    onChange(txt);
    const focusAt = Math.min(txt.length, 5);
    setTimeout(() => refs.current[focusAt]?.focus(), 0);
  };
  return (
    <div className={"otpboxes" + (error ? " err" : "")}>
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <input
          key={i}
          ref={(el) => {
            refs.current[i] = el;
          }}
          className={"otpinput" + (value[i] ? " filled" : "")}
          inputMode="numeric"
          type="text"
          maxLength={1}
          disabled={disabled}
          value={value[i] || ""}
          onChange={(e) => onIn(i, e)}
          onKeyDown={(e) => onKey(i, e)}
          onPaste={onPaste}
          aria-label={`Digit ${i + 1}`}
          aria-invalid={error || undefined}
        />
      ))}
    </div>
  );
}

function maskEmail(email: string): string {
  const [user, domain] = email.split("@");
  if (!domain || !user) return email;
  const head = user.slice(0, Math.min(2, user.length));
  return `${head}${"•".repeat(Math.max(2, user.length - 2))}@${domain}`;
}

async function postJson(
  url: string,
  body: unknown,
): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: res.ok, status: res.status, data };
}

/* ============================================================================
   Resend countdown hook (shared by verify + reset screens)
   ============================================================================ */
function useCountdown(initial: number): [number, () => void] {
  const [left, setLeft] = useState(initial);
  useEffect(() => {
    if (left <= 0) return;
    const t = setTimeout(() => setLeft((n) => n - 1), 1000);
    return () => clearTimeout(t);
  }, [left]);
  return [left, () => setLeft(initial)];
}

/* ============================================================================
   Screens
   ============================================================================ */
type Screen = "signin" | "signup" | "verify" | "forgot" | "reset";
const DEV_LOGIN_EMAIL = "admin@tvc.dev";
const DEV_LOGIN_PASSWORD = "adminadmin";
const ENABLE_DEV_LOGIN = process.env.NODE_ENV === "development";

export function LoginForm({
  next = "/skills",
  initialMode = "signin",
  initialError = null,
  initialReset = false,
}: {
  next?: string;
  initialMode?: "signin" | "signup";
  initialError?: string | null;
  initialReset?: boolean;
}) {
  const [screen, setScreen] = useState<Screen>(initialMode === "signup" ? "signup" : "signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  // A success banner shown on the sign-in screen (e.g. after a password reset).
  const [notice, setNotice] = useState<string | null>(
    initialReset ? "Password updated. Sign in with your new password." : null,
  );
  // Where the verify screen returns to via "Back".
  const verifyBackRef = useRef<Screen>("signup");

  const goGoogle = () => {
    window.location.href = `/v1/auth/google?next=${encodeURIComponent(next)}`;
  };

  return (
    <div className="authstage">
      <div className="authwrap">
        <div className="authcard">
          {screen === "signin" && (
            <SignIn
              email={email}
              password={password}
              setEmail={setEmail}
              setPassword={setPassword}
              next={next}
              notice={notice}
              initialError={initialError}
              onGoogle={goGoogle}
              goSignup={() => {
                setNotice(null);
                setScreen("signup");
              }}
              goForgot={() => {
                setNotice(null);
                setScreen("forgot");
              }}
              needsVerification={() => {
                verifyBackRef.current = "signin";
                setScreen("verify");
              }}
            />
          )}
          {screen === "signup" && (
            <SignUp
              email={email}
              password={password}
              setEmail={setEmail}
              setPassword={setPassword}
              onGoogle={goGoogle}
              goSignin={() => setScreen("signin")}
              onSent={() => {
                verifyBackRef.current = "signup";
                setScreen("verify");
              }}
            />
          )}
          {screen === "verify" && (
            <Verify email={email} onBack={() => setScreen(verifyBackRef.current)} />
          )}
          {screen === "forgot" && (
            <Forgot
              email={email}
              setEmail={setEmail}
              onBack={() => setScreen("signin")}
              onSent={() => setScreen("reset")}
            />
          )}
          {screen === "reset" && (
            <Reset
              email={email}
              onBack={() => setScreen("forgot")}
              onDone={() => {
                setPassword("");
                setNotice("Password updated. Sign in with your new password.");
                setScreen("signin");
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function SignIn({
  email,
  password,
  setEmail,
  setPassword,
  next,
  notice,
  initialError,
  onGoogle,
  goSignup,
  goForgot,
  needsVerification,
}: {
  email: string;
  password: string;
  setEmail: (v: string) => void;
  setPassword: (v: string) => void;
  next: string;
  notice: string | null;
  initialError: string | null;
  onGoogle: () => void;
  goSignup: () => void;
  goForgot: () => void;
  needsVerification: () => void;
}) {
  const [err, setErr] = useState<string | null>(initialError);
  const [busy, setBusy] = useState(false);

  const submitCredentials = async (credentials: { email: string; password: string }) => {
    if (!credentials.email || !credentials.password) {
      setErr("Enter your email and password to continue.");
      return;
    }
    setErr(null);
    setBusy(true);
    try {
      const { data } = await postJson("/v1/auth/signin", { ...credentials, next });
      if (data.ok && typeof data.redirect === "string") {
        window.location.href = data.redirect;
        return;
      }
      if (data.needsVerification) {
        needsVerification();
        return;
      }
      setErr(typeof data.message === "string" ? data.message : "Sign in failed.");
    } catch {
      setErr("Could not reach Companion. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    await submitCredentials({ email, password });
  };

  const devLogin = async () => {
    setEmail(DEV_LOGIN_EMAIL);
    setPassword(DEV_LOGIN_PASSWORD);
    await submitCredentials({ email: DEV_LOGIN_EMAIL, password: DEV_LOGIN_PASSWORD });
  };

  return (
    <form className="screen" onSubmit={submit}>
      <Brand />
      <div className="authhead">
        <h1 className="authtitle">Sign in</h1>
        <p className="authdesc">Sign in to your Companion workspace.</p>
      </div>

      {notice ? <Notice>{notice}</Notice> : null}

      <GoogleButton label="Continue with Google" onClick={onGoogle} />
      <Divider label="or continue with email" />

      <div className="authform">
        <TextField id="si-email" label="Email" type="email" autoComplete="email" placeholder="you@acme.dev" value={email} onChange={setEmail} />
        <div>
          <PasswordField id="si-pw" label="Password" autoComplete="current-password" value={password} onChange={setPassword} />
          <div className="fieldfoot">
            <span />
            <button type="button" className="cds-link" onClick={goForgot}>
              Forgot password?
            </button>
          </div>
        </div>
        {err ? <ErrorNote>{err}</ErrorNote> : null}
        <SubmitButton busy={busy}>{busy ? "Signing in…" : "Sign in"}</SubmitButton>
        {ENABLE_DEV_LOGIN ? (
          <Button type="button" variant="secondary" className="devloginbtn" disabled={busy} onClick={() => void devLogin()}>
            Dev login as {DEV_LOGIN_EMAIL}
          </Button>
        ) : null}
        <div className="authrow">
          <span className="authnote">No account yet?</span>
          <button type="button" className="cds-link" onClick={goSignup}>
            Create one
          </button>
        </div>
      </div>
    </form>
  );
}

function SignUp({
  email,
  password,
  setEmail,
  setPassword,
  onGoogle,
  goSignin,
  onSent,
}: {
  email: string;
  password: string;
  setEmail: (v: string) => void;
  setPassword: (v: string) => void;
  onGoogle: () => void;
  goSignin: () => void;
  onSent: () => void;
}) {
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!/.+@.+\..+/.test(email)) {
      setErr("Enter a valid email address.");
      return;
    }
    if (password.length < 8) {
      setErr("Password must be at least 8 characters.");
      return;
    }
    setErr(null);
    setBusy(true);
    try {
      const { data } = await postJson("/v1/auth/signup", { email, password });
      if (data.ok) {
        onSent();
        return;
      }
      setErr(typeof data.message === "string" ? data.message : "Could not create your account.");
    } catch {
      setErr("Could not reach Companion. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="screen" onSubmit={submit}>
      <Brand />
      <div className="authhead">
        <h1 className="authtitle">Create account</h1>
        <p className="authdesc">The first account becomes the organization owner.</p>
      </div>

      <GoogleButton label="Sign up with Google" onClick={onGoogle} />
      <Divider label="or sign up with email" />

      <div className="authform">
        <TextField id="su-email" label="Email" type="email" autoComplete="email" placeholder="you@acme.dev" value={email} onChange={setEmail} />
        <div>
          <PasswordField id="su-pw" label="Password" autoComplete="new-password" placeholder="At least 8 characters" value={password} onChange={setPassword} />
          <PasswordMeter value={password} />
        </div>
        {err ? <ErrorNote>{err}</ErrorNote> : null}
        <SubmitButton busy={busy}>{busy ? "Creating account…" : "Create account"}</SubmitButton>
        <div className="authrow">
          <span className="authnote">Already have an account?</span>
          <button type="button" className="cds-link" onClick={goSignin}>
            Sign in
          </button>
        </div>
      </div>
    </form>
  );
}

function Verify({ email, onBack }: { email: string; onBack: () => void }) {
  const [code, setCode] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [left, resetCountdown] = useCountdown(34);
  const [resent, setResent] = useState(false);

  const verify = useCallback(async (value: string) => {
    setBusy(true);
    setErr(null);
    try {
      const { data } = await postJson("/v1/auth/verify-email", { email, otp: value });
      if (data.ok && typeof data.redirect === "string") {
        window.location.href = data.redirect;
        return;
      }
      setErr(typeof data.message === "string" ? data.message : "That code is incorrect.");
      setCode("");
    } catch {
      setErr("Could not reach Companion. Try again.");
    } finally {
      setBusy(false);
    }
  }, [email]);

  // Auto-submit once all six digits are entered (debounced by the busy guard).
  useEffect(() => {
    if (code.length === 6 && !busy) void verify(code);
  }, [code, busy, verify]);

  const resend = async () => {
    setErr(null);
    const { data } = await postJson("/v1/auth/verify-email/send", { email });
    if (data.ok) {
      resetCountdown();
      setResent(true);
    } else {
      setErr(typeof data.message === "string" ? data.message : "Could not resend the code. Try again.");
    }
  };

  return (
    <div className="screen">
      <button type="button" className="backlink" onClick={onBack}>
        <IconArrowLeft /> Back
      </button>
      <div
        className="successmark"
        style={{
          background: "var(--color-accent-tint)",
          borderColor: "var(--color-accent-line)",
          color: "var(--color-accent-edge)",
        }}
      >
        <IconMail />
      </div>
      <div className="authhead">
        <h1 className="authtitle">Verify your email</h1>
        <p className="authdesc">Enter the 6-digit code we sent to confirm it is you.</p>
      </div>
      <span className="emailpill">
        <IconMail /> {maskEmail(email)}
      </span>

      <div className="otpwrap">
        <OtpInput
          value={code}
          onChange={(v) => {
            setErr(null);
            setCode(v);
          }}
          error={!!err}
          disabled={busy}
          autoFocus
        />
        {err ? <ErrorNote>{err}</ErrorNote> : null}
        <Button
          variant="primary"
          disabled={busy || code.length !== 6}
          iconLeft={busy ? <span className="cds-spinner" /> : undefined}
          onClick={() => void verify(code)}
        >
          {busy ? "Verifying…" : "Verify email"}
        </Button>
        <div className="resend">
          {left > 0 ? (
            <span>Resend code in {left}s</span>
          ) : (
            <>
              <span className="authnote">Didn&apos;t get it?</span>
              <button type="button" className="cds-link" onClick={() => void resend()}>
                Resend code
              </button>
            </>
          )}
        </div>
        {resent ? (
          <div className="resend">
            <span className="codeline">A new code is on its way.</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function Forgot({
  email,
  setEmail,
  onBack,
  onSent,
}: {
  email: string;
  setEmail: (v: string) => void;
  onBack: () => void;
  onSent: () => void;
}) {
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!/.+@.+\..+/.test(email)) {
      setErr("Enter a valid email address.");
      return;
    }
    setErr(null);
    setBusy(true);
    try {
      // Anti-enumeration: a 200 is returned whether or not the email exists, so advance on ok. Only a
      // rate-limit / delivery failure (non-ok) keeps the user here with an explanation.
      const { data } = await postJson("/v1/auth/forgot-password", { email });
      if (data.ok) {
        onSent();
        return;
      }
      setErr(typeof data.message === "string" ? data.message : "Could not send the reset code. Try again.");
    } catch {
      setErr("Could not reach Companion. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="screen" onSubmit={submit}>
      <button type="button" className="backlink" onClick={onBack}>
        <IconArrowLeft /> Back to sign in
      </button>
      <div className="authhead">
        <h1 className="authtitle">Reset password</h1>
        <p className="authdesc">Enter your email and we&apos;ll send a 6-digit code to reset your password.</p>
      </div>

      <div className="authform">
        <TextField id="fp-email" label="Email" type="email" autoComplete="email" placeholder="you@acme.dev" value={email} onChange={setEmail} />
        {err ? <ErrorNote>{err}</ErrorNote> : null}
        <SubmitButton busy={busy}>{busy ? "Sending code…" : "Send reset code"}</SubmitButton>
      </div>
    </form>
  );
}

function Reset({ email, onBack, onDone }: { email: string; onBack: () => void; onDone: () => void }) {
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [left, resetCountdown] = useCountdown(34);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (code.length !== 6) {
      setErr("Enter the 6-digit code we emailed you.");
      return;
    }
    if (password.length < 8) {
      setErr("Password must be at least 8 characters.");
      return;
    }
    setErr(null);
    setBusy(true);
    try {
      const { data } = await postJson("/v1/auth/reset-password", { email, otp: code, password });
      if (data.ok) {
        onDone();
        return;
      }
      setErr(typeof data.message === "string" ? data.message : "Could not reset your password.");
      if (data.code === "INVALID_OTP" || data.code === "OTP_EXPIRED" || data.code === "TOO_MANY_ATTEMPTS") {
        setCode("");
      }
    } catch {
      setErr("Could not reach Companion. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const resend = async () => {
    setErr(null);
    const { data } = await postJson("/v1/auth/forgot-password", { email });
    if (data.ok) {
      resetCountdown();
    } else {
      setErr(typeof data.message === "string" ? data.message : "Could not resend the code. Try again.");
    }
  };

  return (
    <form className="screen" onSubmit={submit}>
      <button type="button" className="backlink" onClick={onBack}>
        <IconArrowLeft /> Back
      </button>
      <div
        className="successmark"
        style={{
          background: "var(--color-accent-tint)",
          borderColor: "var(--color-accent-line)",
          color: "var(--color-accent-edge)",
        }}
      >
        <IconLockReset />
      </div>
      <div className="authhead">
        <h1 className="authtitle">Choose a new password</h1>
        <p className="authdesc">Enter the code we sent and pick a new password.</p>
      </div>
      <span className="emailpill">
        <IconMail /> {maskEmail(email)}
      </span>

      <div className="otpwrap">
        <OtpInput
          value={code}
          onChange={(v) => {
            setErr(null);
            setCode(v);
          }}
          error={!!err}
          disabled={busy}
          autoFocus
        />
        <div>
          <PasswordField id="rp-pw" label="New password" autoComplete="new-password" placeholder="At least 8 characters" value={password} onChange={setPassword} />
          <PasswordMeter value={password} />
        </div>
        {err ? <ErrorNote>{err}</ErrorNote> : null}
        <SubmitButton busy={busy}>{busy ? "Updating…" : "Reset password"}</SubmitButton>
        <div className="resend">
          {left > 0 ? (
            <span>Resend code in {left}s</span>
          ) : (
            <>
              <span className="authnote">Didn&apos;t get it?</span>
              <button type="button" className="cds-link" onClick={() => void resend()}>
                Resend code
              </button>
            </>
          )}
        </div>
      </div>
    </form>
  );
}
