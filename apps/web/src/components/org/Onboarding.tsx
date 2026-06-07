"use client";

import { useState } from "react";
import { Icon } from "../Icon";
import { Dialog } from "./primitives";

export type OnboardingMode = "choose" | "create" | "join";

/** First-run / switcher onboarding: choose -> create a workspace or join one. */
export function Onboarding({
  mode,
  onMode,
  onCreate,
  onJoin,
  busy,
}: {
  mode: OnboardingMode;
  onMode: (m: OnboardingMode | null) => void;
  onCreate: (name: string, kind: "personal" | "team") => void;
  onJoin: (codeOrLink: string) => void;
  busy: boolean;
}) {
  const close = () => onMode(null);

  if (mode === "create") return <CreateOrgFlow onCreate={onCreate} busy={busy} onBack={() => onMode("choose")} onClose={close} />;
  if (mode === "join") return <JoinOrgFlow onJoin={onJoin} busy={busy} onBack={() => onMode("choose")} onClose={close} />;

  return (
    <div className="og-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="og-dialog og-onb" role="dialog" aria-modal="true">
        <div className="og-onb__brand">
          <span className="og-onb__mark">C</span>
          <span className="og-onb__wm">Companion</span>
        </div>
        <h2 className="og-onb__h">Set up your workspace</h2>
        <p className="og-onb__sub">
          Start with a personal workspace just for you, or join an organization your team already runs.
        </p>
        <div className="og-choices">
          <button className="og-choice" onClick={() => onMode("create")}>
            <span className="og-choice__ic"><Icon name="user" size={20} /></span>
            <span>
              <span className="og-choice__t">Create a personal workspace</span>
              <span className="og-choice__d">A private space for your own agents and skills. You're the owner. Invite people later.</span>
            </span>
            <span className="og-choice__arrow"><Icon name="arrow-right" size={16} /></span>
          </button>
          <button className="og-choice" onClick={() => onMode("join")}>
            <span className="og-choice__ic"><Icon name="users" size={20} /></span>
            <span>
              <span className="og-choice__t">Join an organization</span>
              <span className="og-choice__d">Use an invite link or code from a teammate to join an existing organization and its teams.</span>
            </span>
            <span className="og-choice__arrow"><Icon name="arrow-right" size={16} /></span>
          </button>
        </div>
        <div className="og-onb__foot">
          <Icon name="shield" size={13} /> Self-hostable · runs on your tailnet
        </div>
      </div>
    </div>
  );
}

function CreateOrgFlow({
  onCreate,
  busy,
  onBack,
  onClose,
}: {
  onCreate: (name: string, kind: "personal" | "team") => void;
  busy: boolean;
  onBack: () => void;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"personal" | "team">("personal");
  const valid = name.trim().length >= 2;
  const submit = () => { if (valid && !busy) onCreate(name.trim(), kind); };
  return (
    <Dialog
      icon="plus"
      title="Create a workspace"
      desc="Name it and pick whether it's just for you or for a team."
      onClose={onClose}
      foot={
        <>
          <button className="og-back-link" onClick={onBack}><Icon name="arrow-left" size={14} />Back</button>
          <span className="og-spacer" />
          <button className="btn-primary" disabled={!valid || busy} onClick={submit}>
            <Icon name="check" size={14} />
            Create workspace
          </button>
        </>
      }
    >
      <div className="og-field">
        <label className="og-field__label">Workspace name</label>
        <input
          className="og-input"
          autoFocus
          placeholder={kind === "personal" ? "Alice's workspace" : "Acme"}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
        />
      </div>
      <div className="og-field">
        <label className="og-field__label">Type</label>
        <div className="og-seg">
          <button className={"og-seg__btn" + (kind === "personal" ? " is-on" : "")} onClick={() => setKind("personal")}>
            <Icon name="user" size={13} />Personal
          </button>
          <button className={"og-seg__btn" + (kind === "team" ? " is-on" : "")} onClick={() => setKind("team")}>
            <Icon name="users" size={13} />Team
          </button>
        </div>
        <span className="og-field__hint">
          {kind === "personal" ? "Private to you. You can convert it to a team later." : "Invite members and create teams from settings."}
        </span>
      </div>
    </Dialog>
  );
}

function JoinOrgFlow({
  onJoin,
  busy,
  onBack,
  onClose,
}: {
  onJoin: (codeOrLink: string) => void;
  busy: boolean;
  onBack: () => void;
  onClose: () => void;
}) {
  const [code, setCode] = useState("");
  const valid = code.trim().length >= 4;
  const submit = () => { if (valid && !busy) onJoin(code.trim()); };
  return (
    <Dialog
      icon="log-in"
      title="Join an organization"
      desc="Paste the invite link or code a teammate shared with you."
      onClose={onClose}
      foot={
        <>
          <button className="og-back-link" onClick={onBack}><Icon name="arrow-left" size={14} />Back</button>
          <span className="og-spacer" />
          <button className="btn-primary" disabled={!valid || busy} onClick={submit}>
            <Icon name="log-in" size={14} />
            Join
          </button>
        </>
      }
    >
      <div className="og-field">
        <label className="og-field__label">Invite link or code</label>
        <input
          className="og-input og-input--mono"
          autoFocus
          placeholder="companion.dev/join/XXXXXX"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
        />
        <span className="og-field__hint">Paste the full link or just the code — both work.</span>
      </div>
    </Dialog>
  );
}
