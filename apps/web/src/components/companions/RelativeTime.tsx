"use client";

import { useEffect, useState } from "react";
import { relativeTime } from "./status";

/**
 * A timestamp read as "how long ago". Server markup keeps the stable ISO day so the two renders
 * agree; the relative form appears once the client owns the clock.
 */
export function RelativeTime({ iso, className }: { iso: string; className?: string }) {
  const [text, setText] = useState(() => iso.slice(0, 10));
  useEffect(() => setText(relativeTime(iso)), [iso]);
  return <time className={className} dateTime={iso}>{text}</time>;
}
