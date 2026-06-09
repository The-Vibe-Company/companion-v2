"use client";

import { useState } from "react";
import { TEAM_BRAND_COLORS } from "@companion/contracts";
import { Icon } from "@/components/Icon";

export const LOGO_COLORS = TEAM_BRAND_COLORS;

export function hashColor(str: string): string {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = ((h * 31 + str.charCodeAt(i)) >>> 0);
  return LOGO_COLORS[h % LOGO_COLORS.length]!;
}

export function initialsOf(str: string): string {
  const parts = str.trim().split(/[\s.\-_]+/).filter(Boolean);
  if (!parts.length) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

export function Avatar({
  size = "md",
  color,
  initial,
  emoji,
  src,
  ring = true,
}: {
  size?: "sm" | "md" | "lg";
  color?: string;
  initial?: string;
  emoji?: string;
  src?: string;
  ring?: boolean;
}) {
  const tint = color || "var(--color-accent)";
  const bg = src
    ? "var(--color-surface-raised)"
    : emoji
      ? `color-mix(in oklch, ${tint} 18%, var(--color-surface))`
      : color;
  return (
    <span className={`ob-avatar ob-avatar--${size}${ring ? " ob-avatar--ring" : ""}`} style={{ background: bg }}>
      {src ? (
        <img src={src} alt="" />
      ) : emoji ? (
        <span className="ob-avatar__emoji" style={{ color: "transparent", textShadow: `0 0 0 ${tint}` }}>
          {emoji}
        </span>
      ) : (
        initial
      )}
    </span>
  );
}

interface EmojiEntry {
  e: string;
  k: string;
}
const EMOJIS: EmojiEntry[] = [
  { e: "🚀", k: "rocket launch ship platform growth" }, { e: "⚡", k: "bolt zap fast power energy" },
  { e: "🧩", k: "puzzle piece module platform" }, { e: "🛠️", k: "tools build wrench platform" },
  { e: "🤖", k: "robot agent ai bot" }, { e: "🧠", k: "brain ai memory think" },
  { e: "🔭", k: "telescope research discover" }, { e: "🧪", k: "lab experiment research test" },
  { e: "🎯", k: "target goal growth focus" }, { e: "📈", k: "chart growth analytics up" },
  { e: "🎨", k: "palette design art paint" }, { e: "✨", k: "sparkles magic ai shine" },
  { e: "🔧", k: "wrench fix infra platform" }, { e: "⚙️", k: "gear settings ops infra" },
  { e: "🛡️", k: "shield security trust safety" }, { e: "🔑", k: "key access secret auth" },
  { e: "📦", k: "package deploy ship container" }, { e: "🚢", k: "ship container deploy" },
  { e: "🔌", k: "plug connect integration api" }, { e: "📡", k: "satellite signal network" },
  { e: "🔍", k: "search find discover lookup" }, { e: "💬", k: "chat message talk support" },
  { e: "📚", k: "books docs knowledge skills" }, { e: "📝", k: "note write docs skills" },
  { e: "🧭", k: "compass direction plan navigate" }, { e: "🗺️", k: "map plan route" },
  { e: "🌱", k: "seedling grow growth new" }, { e: "🔥", k: "fire hot trending growth" },
  { e: "💎", k: "gem premium quality core" }, { e: "🥇", k: "medal first win quality" },
  { e: "🏗️", k: "construction build platform infra" }, { e: "🧱", k: "brick build blocks platform" },
  { e: "💼", k: "briefcase work business team" }, { e: "👥", k: "people team group users" },
  { e: "🌐", k: "globe world web network" }, { e: "🛰️", k: "satellite space network" },
  { e: "🎫", k: "ticket support ops" }, { e: "📌", k: "pin save plan board" },
  { e: "🧮", k: "abacus compute math data" }, { e: "💽", k: "disk data storage vault" },
  { e: "🗄️", k: "cabinet files data storage" }, { e: "🔋", k: "battery power energy" },
  { e: "🎙️", k: "mic voice audio" }, { e: "📷", k: "camera vision image" },
  { e: "🎮", k: "game play fun" }, { e: "🧲", k: "magnet attract growth" },
  { e: "🌈", k: "rainbow design color" }, { e: "❤️", k: "heart love care" },
];

export function EmojiPicker({ value, onPick, onClose }: { value?: string; onPick: (e: string | null) => void; onClose: () => void }) {
  const [q, setQ] = useState("");
  const list = q.trim() ? EMOJIS.filter((x) => x.k.includes(q.trim().toLowerCase())) : EMOJIS;
  return (
    <>
      <div className="ob-emoji-backdrop" onClick={onClose} />
      <div className="ob-emoji-pop" role="dialog" aria-label="Pick an icon" onClick={(e) => e.stopPropagation()}>
        <div className="ob-emoji-pop__row">
          <span className="ob-emoji-pop__hint">Pick an icon</span>
          {value && (
            <button className="ob-emoji-reset" onClick={() => onPick(null)}>
              <Icon name="rotate-ccw" size={12} />Use initials
            </button>
          )}
        </div>
        <input className="ob-emoji-search" autoFocus placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="ob-emoji-grid">
          {list.length ? (
            list.map((x) => (
              <button key={x.e} className="ob-emoji-cell" title={x.k.split(" ")[0]} onClick={() => onPick(x.e)}>
                {x.e}
              </button>
            ))
          ) : (
            <div className="ob-emoji-empty">No icon matches “{q}”</div>
          )}
        </div>
      </div>
    </>
  );
}
