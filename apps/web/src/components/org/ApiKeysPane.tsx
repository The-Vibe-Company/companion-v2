"use client";

import { useState } from "react";
import { Icon } from "../Icon";
import { Dialog } from "./primitives";
import { PaneHead } from "./paneKit";
import type { ApiKeyVM, OrgCtx } from "./model";

/** The two real, enforceable key scopes. Each maps to a concrete set of API scope strings. */
const KEY_SCOPES = {
  read: { label: "Read", desc: "Read-only access to skills.", scopes: ["skills:read"] },
  write: { label: "Read & write", desc: "Read plus create/edit skills.", scopes: ["skills:read", "skills:write"] },
} as const;
const KEY_SCOPE_ORDER = ["read", "write"] as const;

type KeyScope = (typeof KEY_SCOPE_ORDER)[number];

/** The one-time secret payload surfaced by CreateKeyDialog and revealed by KeyRevealDialog. */
interface RevealedKey {
  name: string;
  scope: KeyScope;
  secret: string;
}

/* ============================ Account › API keys ============================ */
export function ApiKeysPane({ ctx, keys }: { ctx: OrgCtx; keys: ApiKeyVM[] }) {
  const [creating, setCreating] = useState(false);
  const [revealed, setRevealed] = useState<RevealedKey | null>(null);
  return (
    <div className="sx-pane">
      <PaneHead
        title="API keys"
        desc="Personal keys to authenticate with the Companion API and CLI. They carry your access — treat them like passwords and never commit them."
        action={
          <button className="btn-primary" onClick={() => setCreating(true)}>
            <Icon name="plus" size={14} />
            Create key
          </button>
        }
      />

      <div className="og-lockbar og-lockbar--wide" style={{ marginBottom: 18 }}>
        <Icon name="shield-check" size={13} />
        <span>Keys are shown in full only once, at creation. Companion stores a hash, never the raw value.</span>
      </div>

      {keys.length === 0 ? (
        <div className="sx-empty">No API keys yet. Create one to use the Companion CLI or call the API.</div>
      ) : (
        <>
          <div className="mlist__lbl">
            <span>
              {keys.length} key{keys.length === 1 ? "" : "s"}
            </span>
            <span className="n">last used</span>
          </div>
          <div className="mlist">
            {keys.map((k) => (
              <div className="mrow" key={k.id}>
                <span className="keyic">
                  <Icon name="key" size={16} />
                </span>
                <div className="mrow__id">
                  <div className="og-mname">
                    {k.name}
                    <span className="badge scopebadge">{KEY_SCOPES[k.scope].label}</span>
                  </div>
                  <div className="keytok">
                    <b>{k.prefix}</b>••••••••••••{k.last4} · created {k.created}
                  </div>
                </div>
                <div className="mrow__end">
                  <span className="mrow__meta" style={{ minWidth: 110 }}>
                    {k.lastUsed === "never" ? "never used" : k.lastUsed}
                  </span>
                  <button className="mrow__x" title="Revoke key" onClick={() => ctx.revokeApiKey(k.id)}>
                    <Icon name="trash-2" size={15} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {creating && (
        <CreateKeyDialog
          ctx={ctx}
          onClose={() => setCreating(false)}
          onCreated={(r) => {
            setCreating(false);
            setRevealed(r);
          }}
        />
      )}
      {revealed && <KeyRevealDialog data={revealed} onClose={() => setRevealed(null)} />}
    </div>
  );
}

/** Name + scope picker; on submit issues the key and hands its one-time secret to the reveal dialog. */
function CreateKeyDialog({
  ctx,
  onClose,
  onCreated,
}: {
  ctx: OrgCtx;
  onClose: () => void;
  onCreated: (revealed: RevealedKey) => void;
}) {
  const [name, setName] = useState("");
  const [scope, setScope] = useState<KeyScope>("read");
  const [busy, setBusy] = useState(false);
  const valid = name.trim().length >= 2;
  const submit = async () => {
    if (!valid || busy) return;
    setBusy(true);
    try {
      const secret = await ctx.createApiKey(name.trim(), scope);
      onCreated({ name: name.trim(), scope, secret });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      icon="key"
      title="Create API key"
      desc="Name the key and choose its scope. You'll see the secret once."
      onClose={onClose}
      foot={
        <>
          <span className="og-spacer" />
          <button className="btn-sec" onClick={onClose}>
            Cancel
          </button>
          <button className="btn-primary" disabled={!valid || busy} onClick={() => void submit()}>
            <Icon name="key" size={14} />
            Create key
          </button>
        </>
      }
    >
      <div className="og-field">
        <label className="og-field__label">Name</label>
        <input
          className="sx-input"
          autoFocus
          placeholder="Local CLI"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void submit();
          }}
        />
        <span className="og-field__hint">A label so you can recognize this key later.</span>
      </div>
      <div className="og-field">
        <label className="og-field__label">Scope</label>
        <div className="og-seg">
          {KEY_SCOPE_ORDER.map((s) => (
            <button key={s} className={"og-seg__btn" + (scope === s ? " is-on" : "")} onClick={() => setScope(s)}>
              {KEY_SCOPES[s].label}
            </button>
          ))}
        </div>
        <span className="og-field__hint">{KEY_SCOPES[scope].desc}</span>
      </div>
    </Dialog>
  );
}

/** One-time reveal of a freshly created key's plaintext secret with copy-to-clipboard. */
function KeyRevealDialog({ data, onClose }: { data: RevealedKey; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(data.secret);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard may be unavailable (insecure context); the secret stays visible to copy manually.
    }
  };
  return (
    <Dialog
      icon="key"
      title={data.name + " created"}
      desc="Copy this key now. For your security it won't be shown again."
      onClose={onClose}
      foot={
        <>
          <span className="og-spacer" />
          <button className="btn-primary" onClick={onClose}>
            <Icon name="check" size={14} />
            Done
          </button>
        </>
      }
    >
      <div className="og-field">
        <label className="og-field__label">Secret key</label>
        <div className="secretbox">
          <span>{data.secret}</span>
          <button className="iconbtn" title="Copy" onClick={() => void copy()}>
            <Icon name={copied ? "check" : "copy"} size={15} />
          </button>
        </div>
        <span className="og-field__hint">
          <Icon name="alert-triangle" size={11} style={{ verticalAlign: "-1px", marginRight: 4 }} />
          Store it in a secret manager. Anyone with this key has {KEY_SCOPES[data.scope].label.toLowerCase()} access as
          you.
        </span>
      </div>
    </Dialog>
  );
}
