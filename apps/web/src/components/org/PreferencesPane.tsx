"use client";

import { useMemo, useState } from "react";
import { Icon } from "../Icon";
import { PaneHead } from "./paneKit";
import type { OrgCtx } from "./model";
import { browserTimeZones, detectedBrowserTimeZone } from "@/lib/timezones";

/** Accent presets — the single action color. Signal yellow is the Companion default. */
export const ACCENTS: { id: string; label: string; color: string }[] = [
  { id: "yellow", label: "Signal", color: "oklch(0.81 0.166 88)" },
  { id: "cloud", label: "Cloud", color: "oklch(0.585 0.142 242)" },
  { id: "evergreen", label: "Evergreen", color: "oklch(0.58 0.115 162)" },
  { id: "coral", label: "Coral", color: "oklch(0.66 0.165 30)" },
];

/** Interface theme choices — light, dark, or follow the OS. */
export const THEMES: {
  id: "light" | "dark" | "system";
  label: string;
  icon: string;
  chip: string;
}[] = [
  { id: "light", label: "Light", icon: "sun", chip: "chip-light" },
  { id: "dark", label: "Dark", icon: "moon", chip: "chip-dark" },
  { id: "system", label: "System", icon: "monitor", chip: "chip-sys" },
];

/** Account › Preferences — personal, per-device display settings (theme + accent). */
export function PreferencesPane({ ctx }: { ctx: OrgCtx }) {
  const detected = useMemo(detectedBrowserTimeZone, []);
  const [timezone, setTimezone] = useState(ctx.timezone ?? detected);
  const [savingTimezone, setSavingTimezone] = useState(false);
  const timezoneOptions = useMemo(
    () => browserTimeZones(ctx.timezone, detected, timezone),
    [ctx.timezone, detected, timezone],
  );
  const saveTimezone = async () => {
    setSavingTimezone(true);
    try {
      await ctx.setTimezone(timezone);
    } catch {
      // SettingsApp surfaces the shared request error above the pane.
    } finally {
      setSavingTimezone(false);
    }
  };
  return (
    <div className="sx-pane">
      <PaneHead title="Preferences" desc="Personal display settings. These apply only to your account." />

      <div className="sx-sec">
        <h2 className="sx-sec__h">Timezone</h2>
        <p className="sx-sec__d">
          Used by every Companion for local time, scheduled routines, and activity timestamps.
        </p>
        <div className="sx-field">
          <label className="sx-field__label" htmlFor="member-timezone">IANA timezone</label>
          <select
            id="member-timezone"
            className="sx-select"
            value={timezone}
            onChange={(event) => setTimezone(event.target.value)}
            disabled={savingTimezone || ctx.busy}
          >
            {timezoneOptions.map((option) => <option key={option}>{option}</option>)}
          </select>
          <span className="sx-field__hint">
            Detected on this device as {detected}. You can override it at any time.
          </span>
          {(ctx.timezone ?? detected) !== timezone || ctx.timezone === null ? (
            <div className="sx-row-actions">
              <button
                type="button"
                className="btn-sec"
                disabled={savingTimezone || ctx.busy}
                onClick={() => void saveTimezone()}
              >
                {savingTimezone ? "Saving" : "Save timezone"}
              </button>
            </div>
          ) : null}
        </div>
      </div>

      <div className="sx-sec">
        <h2 className="sx-sec__h">Interface theme</h2>
        <p className="sx-sec__d">Choose how Companion looks for you.</p>
        <div className="sx-themes">
          {THEMES.map((t) => {
            const on = ctx.prefs.theme === t.id;
            return (
              <button
                key={t.id}
                className={"sx-theme" + (on ? " is-on" : "")}
                aria-pressed={on}
                onClick={() => ctx.setTheme(t.id)}
              >
                <span className={"sx-theme__chip " + t.chip}>
                  <span className="bar a" />
                  <span className="bar b" />
                  <span className="bar c" />
                </span>
                <span className="sx-theme__lab">
                  <Icon name={t.icon} size={14} />
                  {t.label}
                  <span className="sx-theme__check">
                    <Icon name="check" size={15} />
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="sx-sec">
        <h2 className="sx-sec__h">Accent color</h2>
        <p className="sx-sec__d">
          The single action color used for primary buttons, links, and selection. Signal yellow is the
          Companion default.
        </p>
        <div className="sx-accents">
          {ACCENTS.map((a) => {
            const on = ctx.prefs.accent === a.id;
            return (
              <button
                key={a.id}
                className={"sx-accent" + (on ? " is-on" : "")}
                aria-pressed={on}
                title={a.label}
                onClick={() => ctx.setAccent(a.id)}
              >
                <span className="sx-accent__sw" style={{ background: a.color }} />
                <span className="sx-accent__lab">{a.label}</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
