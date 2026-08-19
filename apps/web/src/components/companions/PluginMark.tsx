import { Icon } from "../Icon";
import type { CompanionPluginCatalogEntry } from "@companion/contracts";

/**
 * Official vendor marks for the product-owned MCP catalog. Paths come from each brand's public
 * mark (Simple Icons, CC0). Unknown providers keep a letter tile so a custom MCP still has a face.
 */
const MARK_PATHS: Record<CompanionPluginCatalogEntry["provider"], string> = {
  linear:
    "M2.886 4.18A11.982 11.982 0 0 1 11.99 0C18.624 0 24 5.376 24 12.009c0 3.64-1.62 6.903-4.18 9.112L2.887 4.18ZM1.849 5.602 18.399 22.15C16.59 23.323 14.381 24 11.99 24 5.375 24 0 18.624 0 12.009c0-2.393.677-4.596 1.849-6.407Z",
  github:
    "M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12",
  notion:
    "M4.459 4.208c.746.606 1.026.56 2.428.466l13.215-.793c.28 0 .047-.28-.046-.326L17.86 1.968c-.42-.326-.98-.7-2.055-.607L3.01 2.295c-.466.046-.66.28-.512.646l1.96 1.267zm.793 3.173v13.904c0 .707.35 1.026.932.976l14.147-.84c.582-.047.932-.466.932-1.213V6.354c0-.606-.233-.933-.746-.887l-14.58.793c-.56.047-.746.42-.746.933zm14.337.745c.093.42 0 .793-.35.84l-.7.14v10.264c-.608.327-1.168.514-1.635.514-.746 0-.933-.234-1.495-.933l-4.577-7.186v6.952l1.448.326s0 .84-1.168.84l-3.222.186c-.093-.186 0-.653.327-.746l.84-.233V9.854L7.822 9.76c-.094-.42.14-1.026.793-1.073l3.456-.233 4.764 7.279v-6.44l-1.215-.139c-.093-.514.28-.887.747-.933l3.222-.186zM1.936 1.035l13.31-.98c1.634-.14 2.055-.047 3.082.7l4.247 2.986c.7.513.933.746.933 1.213v16.378c0 1.026-.373 1.634-1.68 1.726l-15.458.934c-.98.047-1.448-.093-1.962-.747l-3.129-4.06c-.56-.747-.793-1.306-.793-1.96V2.667c0-.839.374-1.54 1.45-1.632z",
};

export type KnownPluginProvider = CompanionPluginCatalogEntry["provider"];

const MARK_SVG_SIZE = {
  sm: 16,
  md: 20,
} as const;

export function PluginMark({
  provider,
  size = "sm",
  variant = "tile",
}: {
  provider: string;
  size?: "sm" | "md";
  /** `glyph` is the SVG alone, for embedding in an existing tile such as a dialog icon. */
  variant?: "tile" | "glyph";
}) {
  const known = Object.hasOwn(MARK_PATHS, provider)
    ? (provider as KnownPluginProvider)
    : null;
  const glyph = known ? (
    <svg
      width={MARK_SVG_SIZE[size]}
      height={MARK_SVG_SIZE[size]}
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
    >
      <path fill="currentColor" d={MARK_PATHS[known]} />
    </svg>
  ) : (
    provider.slice(0, 1).toLocaleUpperCase("en-US") || (
      <Icon name="plug-zap" size={MARK_SVG_SIZE[size]} />
    )
  );

  if (variant === "glyph") return glyph;

  const className = [
    "companions-plugin-icon",
    size === "md" ? "companions-plugin-icon--md" : null,
    known ? `companions-plugin-icon--${known}` : null,
  ].filter(Boolean).join(" ");

  return (
    <span className={className} data-plugin-mark={known ?? undefined} aria-hidden="true">
      {glyph}
    </span>
  );
}
