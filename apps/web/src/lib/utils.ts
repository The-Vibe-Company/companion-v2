import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Join class names and let the last Tailwind utility win. The vendored assistant-ui components are
 * written against this helper — it is what lets a caller pass `className` and actually override the
 * component's own padding or colour instead of landing in a specificity tie.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
