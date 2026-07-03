/**
 * Display names for the two libraries. With Companion Agents, each library holds both agents and
 * skills, so the personal library reads "My Companions" (the design's option 1a) — route/API
 * identifiers stay `mine` / `org` and personal skills keep their "My Skills" copy where the text
 * refers to the skills *library slice* specifically.
 */
export const LIB_NAMES = {
  mine: "My Companions",
  org: "Organization",
} as const;

export type LibKey = keyof typeof LIB_NAMES;
