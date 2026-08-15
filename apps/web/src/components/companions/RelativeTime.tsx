"use client";

import { useEffect, useState } from "react";
import { relativeTime } from "./status";

/** How often "how long ago" is worth saying again. A minute is the finest unit it ever prints. */
const TICK_MS = 60_000;

/**
 * A timestamp read as "how long ago". Server markup keeps the stable ISO day so the two renders
 * agree; the relative form appears once the client owns the clock, and keeps up with it — a list
 * left open is exactly where a frozen "5m ago" would be read hours later.
 */
export function RelativeTime({ iso, className }: { iso: string; className?: string }) {
  const [text, setText] = useState(() => iso.slice(0, 10));
  useEffect(() => {
    setText(relativeTime(iso));
    const timer = setInterval(() => setText(relativeTime(iso)), TICK_MS);
    return () => clearInterval(timer);
  }, [iso]);
  return <time className={className} dateTime={iso}>{text}</time>;
}
