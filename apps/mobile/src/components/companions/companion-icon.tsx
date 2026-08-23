import Svg, {
  Circle,
  Defs,
  Ellipse,
  G,
  Line,
  LinearGradient,
  Path,
  Rect,
  Stop,
} from "react-native-svg";

import type { CompanionIconValue } from "@/lib/types";

/* Icon catalogs are literally geometric; "shape" is the domain term in the REST contract. */
/* oxlint-disable anti-slop/no-shape-in-symbol-names */

const shapes = [
  "M32 6a26 26 0 1 0 .001 0z",
  "M32 5C17 5 6 15 6 29c0 12 9 22 22 22 14 0 26-8 26-21S45 5 32 5z",
  "M20 7h24a13 13 0 0 1 13 13v24a13 13 0 0 1-13 13H20A13 13 0 0 1 7 44V20A13 13 0 0 1 20 7z",
  "M25 8h14a24 24 0 0 1 0 48H25a24 24 0 0 1 0-48z",
  "M27 9a6 6 0 0 1 10 0l19 33a6 6 0 0 1-5 9H13a6 6 0 0 1-5-9L27 9z",
  "M28 6a8 8 0 0 1 8 0l17 10a8 8 0 0 1 4 7v20a8 8 0 0 1-4 7L36 60a8 8 0 0 1-8 0L11 50a8 8 0 0 1-4-7V23a8 8 0 0 1 4-7L28 6z",
  "M20 54c-9 0-15-6-15-13 0-6 4-11 10-13 1-10 8-18 18-18 9 0 16 6 18 14h3c5 0 9 5 9 12 0 10-7 18-17 18H20z",
  "M32 4C22 18 12 28 12 39a20 20 0 0 0 40 0C52 28 42 18 32 4z",
];

const colors: [string, string][] = [
  ["#F2F2F0", "#CFCFC9"], ["#8A6A4F", "#6B4F37"], ["#E04B44", "#C23530"],
  ["#F08A24", "#DB6E0D"], ["#F2B01E", "#DE9410"], ["#3FA95C", "#2E8A47"],
  ["#2FA98C", "#22866E"], ["#3D7BF2", "#2A5FD0"], ["#8B5CF6", "#6F3FE0"],
  ["#E0559F", "#C93B84"], ["#9AA0A6", "#7E848B"],
];

export const iconCatalog = { shapes: 8, mouths: 5, accessories: 7, colors: 11 } as const;
export const defaultCompanionIcon: CompanionIconValue = { shape: 1, mouth: 1, accessory: 1, color: 2 };

function valid(value: number | undefined, count: number, fallback: number): number {
  return Number.isInteger(value) && value !== undefined && value >= 0 && value < count ? value : fallback;
}

function Accessory({ index }: { index: number }) {
  if (index === 1) return <><Line x1="32" y1="8" x2="36" y2="2" stroke="#F2B01E" strokeWidth="2.4" strokeLinecap="round" /><Circle cx="37" cy="2" r="3" fill="#F2B01E" /></>;
  if (index === 2) return <Ellipse cx="32" cy="4" rx="12" ry="3.5" fill="none" stroke="#F2B01E" strokeWidth="2.6" />;
  if (index === 3) return <Path d="M20 8l4-7 8 5 8-5 4 7z" fill="#F2B01E" />;
  if (index === 4) return <><Path d="M46 12l10-5v10zM56 7l-10 5 10 5z" fill="#E0559F" /><Circle cx="45" cy="12" r="2.6" fill="#E0559F" /></>;
  if (index === 5) return <><Path d="M12 30a20 20 0 0 1 40 0" stroke="#9AA0A6" strokeWidth="3.4" fill="none" /><Rect x="8" y="28" width="7" height="12" rx="3.5" fill="#9AA0A6" /><Rect x="49" y="28" width="7" height="12" rx="3.5" fill="#9AA0A6" /></>;
  if (index === 6) return <Path d="M54 4l1.6 3.6L59 9l-3.4 1.4L54 14l-1.6-3.6L49 9l3.4-1.4z" fill="#F2B01E" />;
  return null;
}

function Mouth({ index }: { index: number }) {
  if (index === 1) return <Path d="M27 38q5 5 10 0" stroke="#101014" strokeWidth="2.4" fill="none" strokeLinecap="round" />;
  if (index === 2) return <Ellipse cx="32" cy="39" rx="3" ry="4" fill="#101014" />;
  if (index === 3) return <Path d="M27 38q2.5 3 5 0q2.5 3 5 0" stroke="#101014" strokeWidth="2.2" fill="none" strokeLinecap="round" />;
  if (index === 4) return <Path d="M26 37h12q-1 6-6 6t-6-6z" fill="#101014" />;
  return null;
}

export function CompanionIcon({ icon, size = 32 }: { icon?: CompanionIconValue | null; size?: number }) {
  const shape = valid(icon?.shape, iconCatalog.shapes, defaultCompanionIcon.shape);
  const mouth = valid(icon?.mouth, iconCatalog.mouths, defaultCompanionIcon.mouth);
  const accessory = valid(icon?.accessory, iconCatalog.accessories, defaultCompanionIcon.accessory);
  const color = valid(icon?.color, iconCatalog.colors, defaultCompanionIcon.color);
  const [base, shadow] = colors[color] ?? colors[defaultCompanionIcon.color]!;
  return (
    <Svg width={size} height={size * (68 / 64)} viewBox="0 0 64 68" accessibilityElementsHidden>
      <Defs>
        <LinearGradient id="body" x1="0" y1="0" x2="1" y2="1">
          <Stop offset="0" stopColor={base} />
          <Stop offset="1" stopColor={shadow} />
        </LinearGradient>
      </Defs>
      <G><Accessory index={accessory} /><Path d={shapes[shape]} fill="url(#body)" /></G>
      <G>
        <Ellipse cx="26" cy="30" rx="2.6" ry="4.4" fill="#101014" />
        <Ellipse cx="38" cy="30" rx="2.6" ry="4.4" fill="#101014" />
        <Mouth index={mouth} />
      </G>
    </Svg>
  );
}
