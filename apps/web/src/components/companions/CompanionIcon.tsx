import { useId } from "react";

/* Icon catalogs are literally geometric; "shape" is the domain term throughout. */
/* oxlint-disable anti-slop/no-shape-in-symbol-names */

/**
 * Cosmetic blob icon (THE-382). The four indexes match `companions.icon_*` columns and the bounds
 * enforced by contracts and SQL checks; the catalogs here are the single rendering of those
 * indexes on every surface that shows a Companion.
 */

const SHAPES = [
  "M32 6a26 26 0 1 0 .001 0z",
  "M32 5C17 5 6 15 6 29c0 12 9 22 22 22 14 0 26-8 26-21S45 5 32 5z",
  "M20 7h24a13 13 0 0 1 13 13v24a13 13 0 0 1-13 13H20A13 13 0 0 1 7 44V20A13 13 0 0 1 20 7z",
  "M25 8h14a24 24 0 0 1 0 48H25a24 24 0 0 1 0-48z",
  "M27 9a6 6 0 0 1 10 0l19 33a6 6 0 0 1-5 9H13a6 6 0 0 1-5-9L27 9z",
  "M28 6a8 8 0 0 1 8 0l17 10a8 8 0 0 1 4 7v20a8 8 0 0 1-4 7L36 60a8 8 0 0 1-8 0L11 50a8 8 0 0 1-4-7V23a8 8 0 0 1 4-7L28 6z",
  "M20 54c-9 0-15-6-15-13 0-6 4-11 10-13 1-10 8-18 18-18 9 0 16 6 18 14h3c5 0 9 5 9 12 0 10-7 18-17 18H20z",
  "M32 4C22 18 12 28 12 39a20 20 0 0 0 40 0C52 28 42 18 32 4z",
];

const MOUTHS = [
  "",
  `<path d="M27 38q5 5 10 0" stroke="#101014" stroke-width="2.4" fill="none" stroke-linecap="round"/>`,
  `<ellipse cx="32" cy="39" rx="3" ry="4" fill="#101014"/>`,
  `<path d="M27 38q2.5 3 5 0q2.5 3 5 0" stroke="#101014" stroke-width="2.2" fill="none" stroke-linecap="round"/>`,
  `<path d="M26 37h12q-1 6-6 6t-6-6z" fill="#101014"/>`,
];

const ACCESSORIES = [
  "",
  `<line x1="32" y1="8" x2="36" y2="2" stroke="#F2B01E" stroke-width="2.4" stroke-linecap="round"/><circle cx="37" cy="2" r="3" fill="#F2B01E"/>`,
  `<ellipse cx="32" cy="4" rx="12" ry="3.5" fill="none" stroke="#F2B01E" stroke-width="2.6"/>`,
  `<path d="M20 8l4-7 8 5 8-5 4 7z" fill="#F2B01E"/>`,
  `<path d="M46 12l10-5v10zM56 7l-10 5 10 5z" fill="#E0559F"/><circle cx="45" cy="12" r="2.6" fill="#E0559F"/>`,
  `<path d="M12 30a20 20 0 0 1 40 0" stroke="#9AA0A6" stroke-width="3.4" fill="none"/><rect x="8" y="28" width="7" height="12" rx="3.5" fill="#9AA0A6"/><rect x="49" y="28" width="7" height="12" rx="3.5" fill="#9AA0A6"/>`,
  `<path d="M54 4l1.6 3.6L59 9l-3.4 1.4L54 14l-1.6-3.6L49 9l3.4-1.4z" fill="#F2B01E"/>`,
];

/** [name, base, shadow] — the gradient is derived, never stored. */
const COLORS: Array<[string, string, string]> = [
  ["white", "#F2F2F0", "#CFCFC9"],
  ["brown", "#8A6A4F", "#6B4F37"],
  ["red", "#E04B44", "#C23530"],
  ["orange", "#F08A24", "#DB6E0D"],
  ["amber", "#F2B01E", "#DE9410"],
  ["green", "#3FA95C", "#2E8A47"],
  ["teal", "#2FA98C", "#22866E"],
  ["blue", "#3D7BF2", "#2A5FD0"],
  ["violet", "#8B5CF6", "#6F3FE0"],
  ["pink", "#E0559F", "#C93B84"],
  ["gray", "#9AA0A6", "#7E848B"],
];

export const COMPANION_ICON_COLOR_COUNT = COLORS.length;
export const COMPANION_ICON_SHAPE_COUNT = SHAPES.length;
export const COMPANION_ICON_MOUTH_COUNT = MOUTHS.length;
export const COMPANION_ICON_ACCESSORY_COUNT = ACCESSORIES.length;

export const DEFAULT_COMPANION_ICON = { shape: 1, mouth: 1, accessory: 1, color: 2 } as const;

/**
 * `still` renders the bot with no animation at all — the thread body forbids ambient motion, so
 * per-message avatars use it while roster and header avatars breathe or think.
 */
export type CompanionIconState = "idle" | "thinking" | "still";

function clamp(value: number | undefined, max: number, fallback: number): number {
  // SAFETY: Number.isInteger excludes undefined/non-numbers before each comparison below.
  const index = Number(value);
  return Number.isInteger(index) && index >= 0 && index < max ? index : fallback;
}

function lighten(hex: string, amount: number): string {
  const n = parseInt(hex.slice(1), 16);
  const channel = (shift: number) =>
    Math.min(255, ((n >> shift) & 255) + amount).toString(16).padStart(2, "0");
  return `#${channel(16)}${channel(8)}${channel(0)}`;
}

/**
 * `thinking` animates the whole bot — squish, gaze, sparkles — while a turn is being worked;
 * `idle` breathes gently and blinks. Everything is CSS transform work on one inline SVG, so no
 * image asset ever loads and the icon renders at any size.
 */
export function CompanionIcon({
  icon,
  size = 28,
  state = "idle",
  className,
}: {
  icon?: { shape?: number; mouth?: number; accessory?: number; color?: number } | null;
  size?: number;
  state?: CompanionIconState;
  className?: string;
}) {
  const gradientId = `ci-${useId()}`;
  const shape = clamp(icon?.shape, SHAPES.length, DEFAULT_COMPANION_ICON.shape);
  const mouth = clamp(icon?.mouth, MOUTHS.length, DEFAULT_COMPANION_ICON.mouth);
  const accessory = clamp(icon?.accessory, ACCESSORIES.length, DEFAULT_COMPANION_ICON.accessory);
  const color = clamp(icon?.color, COLORS.length, DEFAULT_COMPANION_ICON.color);
  const entry = COLORS[color] ?? COLORS[DEFAULT_COMPANION_ICON.color] ?? ["gray", "#9AA0A6", "#7E848B"];
  const base = entry[1];
  const dark = entry[2];
  return (
    <svg
      className={`companion-icon companion-icon--${state}${className ? ` ${className}` : ""}`}
      width={size}
      height={size}
      viewBox="0 0 64 68"
      aria-hidden="true"
    >
      <defs>
        <radialGradient id={gradientId} cx="35%" cy="28%" r="85%">
          <stop offset="0%" stopColor={lighten(base, 55)} />
          <stop offset="55%" stopColor={base} />
          <stop offset="100%" stopColor={dark} />
        </radialGradient>
      </defs>
      <g className="companion-icon__bot">
        {ACCESSORIES[accessory]
          ? <g className="companion-icon__accessory" dangerouslySetInnerHTML={{ __html: ACCESSORIES[accessory] }} />
          : null}
        <path className="companion-icon__body" d={SHAPES[shape]} fill={`url(#${gradientId})`} />
        <g className="companion-icon__face">
          <ellipse cx="26" cy="30" rx="2.6" ry="4.4" fill="#101014" />
          <ellipse cx="38" cy="30" rx="2.6" ry="4.4" fill="#101014" />
          {MOUTHS[mouth]
            ? <g className="companion-icon__mouth" dangerouslySetInnerHTML={{ __html: MOUTHS[mouth] }} />
            : null}
        </g>
      </g>
      {state === "thinking"
        ? (
            <g className="companion-icon__sparkles">
              <path className="companion-icon__sparkle" d="M50 14l1.4 3.2L54.6 18l-3.2 1.4L50 23l-1.4-3.6L45.4 18l3.2-.8z" fill="#F2B01E" />
              <path className="companion-icon__sparkle companion-icon__sparkle--s2" d="M57 26l1 2.4 2.4 1-2.4 1-1 2.4-1-2.4-2.4-1 2.4-1z" fill="#E0559F" />
              <path className="companion-icon__sparkle companion-icon__sparkle--s3" d="M12 12l1 2.4 2.4 1-2.4 1-1 2.4-1-2.4-2.4-1 2.4-1z" fill="#F2B01E" />
            </g>
          )
        : null}
    </svg>
  );
}
