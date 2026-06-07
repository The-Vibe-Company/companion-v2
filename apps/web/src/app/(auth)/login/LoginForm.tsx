import { Button } from "@/components/cds";

function modeHref(mode: "signin" | "signup", next: string): string {
  return `/login?${new URLSearchParams({ mode, next }).toString()}`;
}

export function LoginForm({
  loginAction,
  next = "/skills",
  initialError = null,
  initialMode = "signin",
}: {
  loginAction: string;
  next?: string;
  initialError?: string | null;
  initialMode?: "signin" | "signup";
}) {
  const isSignin = initialMode === "signin";
  const errorId = initialError ? "auth-error" : undefined;

  return (
    <div className="authwrap">
      <form className="authcard" method="post" action={loginAction}>
        <input type="hidden" name="mode" value={initialMode} />
        <input type="hidden" name="next" value={next} />
        <div className="authcard__brand">
          <span className="brandmark">C</span>
          <div>
            <div className="brandname">Companion</div>
            <div className="brandsub">skills hub</div>
          </div>
        </div>
        <div>
          <h1 className="authcard__title">{isSignin ? "Sign in" : "Create account"}</h1>
          <p className="authcard__desc">
            {isSignin ? "Sign in to your Companion workspace." : "The first account becomes the organization owner."}
          </p>
        </div>

        <div className="authform">
          {!isSignin ? (
            <div className="cds-field">
              <label className="cds-field__label" htmlFor="name">
                Name
              </label>
              <input id="name" className="cds-field__control" name="name" type="text" autoComplete="name" required />
            </div>
          ) : null}
          <div className="cds-field">
            <label className="cds-field__label" htmlFor="email">
              Email
            </label>
            <input
              id="email"
              className="cds-field__control"
              name="email"
              type="email"
              autoComplete="email"
              aria-describedby={errorId}
              aria-invalid={initialError ? true : undefined}
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
              name="password"
              type="password"
              autoComplete={isSignin ? "current-password" : "new-password"}
              aria-describedby={errorId}
              aria-invalid={initialError ? true : undefined}
              minLength={8}
              required
            />
          </div>
          {initialError ? (
            <div id={errorId} className="autherr" role="alert">
              {initialError}
            </div>
          ) : null}
          <Button type="submit" variant="primary">
            {isSignin ? "Sign in" : "Create account"}
          </Button>
          <div className="authrow">
            <span className="authnote">{isSignin ? "No account yet?" : "Already have an account?"}</span>
            <a className="cds-link" href={modeHref(isSignin ? "signup" : "signin", next)}>
              {isSignin ? "Create one" : "Sign in"}
            </a>
          </div>
        </div>
      </form>
    </div>
  );
}
