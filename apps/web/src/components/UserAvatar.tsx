"use client";

import { useEffect, useState, type CSSProperties } from "react";

/**
 * A user's avatar: the custom upload or Gravatar image when available, falling back to the colored
 * initials monogram when there is no URL or the image fails to load (e.g. a Gravatar `?d=404` miss).
 *
 * Renders into each surface's existing avatar box via `className` (`.avatar`, `.sx-av`, `.og-mav`,
 * `.sx-profile__av`, …) so sizing/shape is unchanged — the paired CSS makes a child `<img>` cover the
 * box. The `onError` fallback is why this is a client component.
 */
export function UserAvatar({
  avatarUrl,
  initials,
  className,
  size,
  style,
}: {
  avatarUrl: string | null;
  initials: string;
  className?: string;
  size?: number;
  style?: CSSProperties;
}) {
  const [failed, setFailed] = useState(false);
  // Recover from a prior load error when the URL changes (a re-upload cache-busts the `?v=` path).
  useEffect(() => setFailed(false), [avatarUrl]);
  const boxStyle: CSSProperties | undefined =
    size != null ? { width: size, height: size, ...style } : style;
  return (
    <span className={className} style={boxStyle}>
      {avatarUrl && !failed ? (
        <img src={avatarUrl} alt="" onError={() => setFailed(true)} />
      ) : (
        initials
      )}
    </span>
  );
}
