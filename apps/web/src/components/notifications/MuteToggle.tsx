"use client";

import { useEffect, useState } from "react";
import { muteSkill, unmuteSkill } from "@/lib/queries";
import { Icon } from "../Icon";

/**
 * Mute / un-mute notifications for a skill. Subscriptions are implicit (you're notified because you
 * starred / installed / commented / own it), so this only toggles an explicit opt-out: `muted` stops
 * notifications; clearing it reverts to the implicit default.
 */
export function MuteToggle({
  slug,
  subscriptionState,
}: {
  slug: string;
  subscriptionState: "subscribed" | "muted" | null;
}) {
  const [muted, setMuted] = useState(subscriptionState === "muted");
  const [busy, setBusy] = useState(false);

  // Re-sync when navigating between skills (the component instance is reused).
  useEffect(() => {
    setMuted(subscriptionState === "muted");
  }, [subscriptionState]);

  const toggle = async () => {
    if (busy) return;
    setBusy(true);
    const next = !muted;
    setMuted(next); // optimistic
    try {
      if (next) await muteSkill(slug);
      else await unmuteSkill(slug);
    } catch {
      setMuted(!next); // revert on failure
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      type="button"
      className={"btn-ghost notif-mute" + (muted ? " notif-mute--on" : "")}
      onClick={toggle}
      disabled={busy}
      aria-pressed={muted}
      title={muted ? "Notifications muted. Click to unmute" : "Mute notifications for this skill"}
    >
      <Icon name={muted ? "bell-off" : "bell"} size={14} />
      {muted ? "Muted" : "Mute"}
    </button>
  );
}
