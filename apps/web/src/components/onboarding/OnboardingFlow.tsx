"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/Icon";
import { completeOnboarding, joinByDomain, type OnboardingContext } from "@/lib/onboarding";
import {
  Aside,
  ScreenAccount,
  ScreenCreateOrg,
  ScreenDetecting,
  ScreenFound,
  ScreenInvite,
  ScreenWelcome,
  hashColor,
  initialsOf,
  type OrgDraft,
} from "./screens";

type Screen = "account" | "detecting" | "found" | "create_org" | "invite" | "welcome";
type Path = "create" | "join" | null;

const CREATE_STEPS = ["Account", "Organization", "Invite teammates", "You're in"];
const JOIN_STEPS = ["Account", "Your organization", "You're in"];

function stepOf(screen: Screen, path: Path): number {
  if (path === "join") {
    if (screen === "account") return 0;
    if (screen === "detecting" || screen === "found") return 1;
    return 2;
  }
  switch (screen) {
    case "account":
      return 0;
    case "detecting":
    case "found":
    case "create_org":
      return 1;
    case "invite":
      return 2;
    default:
      return 3;
  }
}

export function OnboardingFlow({ context, me }: { context: OnboardingContext; me: { name: string; email: string } }) {
  const router = useRouter();
  const logoutForm = useRef<HTMLFormElement>(null);
  const detectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const email = context.email || me.email;
  const corporateDomain = context.isPersonal ? null : context.domain;

  const [name, setName] = useState(me.name || "");
  const [screen, setScreen] = useState<Screen>("account");
  const [path, setPath] = useState<Path>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedOrgId, setSelectedOrgId] = useState<string | null>(() => context.matchedOrgs[0]?.id ?? null);

  const [org, setOrg] = useState<OrgDraft>({ name: "", website: "", logo: null, candidates: [], fetchedFrom: "", domain: "" });
  const [invites, setInvites] = useState<string[]>([]);
  const [allowDomain, setAllowDomain] = useState<boolean>(!!corporateDomain);

  useEffect(() => () => {
    if (detectTimer.current) clearTimeout(detectTimer.current);
  }, []);

  function seedCreateOrg() {
    setPath("create");
    setOrg((o) => ({ ...o, domain: corporateDomain ?? "", website: corporateDomain ?? "" }));
    setScreen("create_org");
  }

  function gotoDetect() {
    setError(null);
    setScreen("detecting");
    if (detectTimer.current) clearTimeout(detectTimer.current);
    detectTimer.current = setTimeout(() => {
      if (context.matchedOrgs.length > 0) {
        setPath("join");
        setScreen("found");
      } else {
        seedCreateOrg();
      }
    }, 1400);
  }

  async function joinOrg() {
    const orgId = selectedOrgId ?? context.matchedOrgs[0]?.id;
    if (!orgId) {
      setError("Choose an organization to join.");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      await joinByDomain(orgId);
      setPath("join");
      setScreen("welcome");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function finishCreate() {
    setError(null);
    setBusy(true);
    try {
      await completeOnboarding({
        org: {
          name: org.name.trim(),
          domain: org.domain || undefined,
          autoJoin: allowDomain,
          color: org.logo?.color ?? null,
          logoUrl: org.logo?.src ?? null,
        },
        invites,
      });
      router.push("/skills");
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  function openApp() {
    router.push("/skills");
    router.refresh();
  }

  function logout() {
    logoutForm.current?.submit();
  }

  const steps = path === "join" ? JOIN_STEPS : CREATE_STEPS;
  const stepIndex = stepOf(screen, path);
  const showEmailChip = screen !== "account";

  let panel: React.ReactNode = null;
  if (screen === "account") {
    panel = <ScreenAccount name={name} email={email} setName={setName} onNext={gotoDetect} />;
  } else if (screen === "detecting") {
    panel = <ScreenDetecting domain={context.domain} />;
  } else if (screen === "found" && context.matchedOrgs.length > 0) {
    panel = (
      <ScreenFound
        orgs={context.matchedOrgs}
        selectedOrgId={selectedOrgId}
        setSelectedOrgId={setSelectedOrgId}
        busy={busy}
        onJoin={joinOrg}
        onCreateInstead={seedCreateOrg}
      />
    );
  } else if (screen === "create_org") {
    panel = (
      <ScreenCreateOrg
        org={org}
        setOrg={setOrg}
        domainHint={corporateDomain}
        onNext={() => setScreen("invite")}
        onBack={() => (context.matchedOrgs.length ? setScreen("found") : setScreen("account"))}
      />
    );
  } else if (screen === "invite") {
    panel = (
      <ScreenInvite
        invites={invites}
        setInvites={setInvites}
        allowDomain={allowDomain}
        setAllowDomain={setAllowDomain}
        domain={org.domain || null}
        onFinish={() => setScreen("welcome")}
        onBack={() => setScreen("create_org")}
      />
    );
  } else if (screen === "welcome") {
    panel = (
      <ScreenWelcome
        path={path === "join" ? "join" : "create"}
        org={org}
        invites={invites}
        allowDomain={allowDomain}
        domain={org.domain || null}
        joinedOrg={context.matchedOrgs.find((org) => org.id === selectedOrgId) ?? context.matchedOrgs[0] ?? null}
        busy={busy}
        onEnter={path === "join" ? openApp : finishCreate}
      />
    );
  }

  return (
    <div className="ob">
      {/* Full-page POST logout (mirrors the login form posting to /v1/auth/login-redirect). */}
      <form ref={logoutForm} method="post" action="/v1/auth/logout" className="ob-logout-form" />
      <Aside steps={steps} stepIndex={stepIndex} meName={name} meEmail={email} onLogout={logout} />
      <main className="ob-main">
        <div className="ob-main__top">
          <div className="ob-main__topbrand">
            <span className="ob-brand__mark" aria-hidden="true" />
            <span className="ob-brand__wm">Companion</span>
          </div>
          <div className="ob-topright">
            {showEmailChip && (
              <span className="ob-emailchip">
                <span
                  className="ob-avatar"
                  style={{ background: hashColor(name || "You"), width: 18, height: 18, fontSize: 9, borderRadius: 5 }}
                >
                  {initialsOf(name || "You")}
                </span>
                {email}
              </span>
            )}
            <button className="ob-logout ob-topact" onClick={logout} aria-label="Log out" title="Log out">
              <Icon name="log-out" size={16} />
            </button>
          </div>
        </div>
        <div className="ob-stage">{panel}</div>
        {error && (
          <div className="ob-stage" style={{ paddingTop: 0 }} role="alert">
            <div className="ob-panel" style={{ paddingTop: 0, maxWidth: 452 }}>
              <div className="ob-note ob-note--danger">
                <Icon name="alert-triangle" size={15} />
                <span>{error}</span>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
