import { z } from "zod";

/**
 * Labels ("folders") are the org-wide shared way to organize skills. There is no owner / visibility
 * axis: every skill is visible to every member, and any member may create / assign / rename /
 * recolor / delete labels. A label is identified by its slash-separated `path` (e.g. `marketing/seo`);
 * intermediate parents are derived (split on `/`), never stored. The same path can be assigned to
 * many skills, and a skill can carry many paths. An empty folder is a `labels` row with no
 * assignments.
 */

/** Max characters for a full label path (sum of all segments + separators). */
export const LABEL_PATH_MAX = 256;
/** Max nesting depth (segments separated by `/`). */
export const LABEL_PATH_MAX_DEPTH = 8;
/** Max characters for a human-facing label segment name. */
export const LABEL_DISPLAY_NAME_MAX = 64;

/** A single path segment: kebab-case (lowercase letters, digits, single hyphens). */
export const LABEL_SEGMENT_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * A label path: one or more kebab segments joined by `/`, no empty / leading / trailing slash,
 * bounded length + depth. This is the canonical validator reused on create / assign / rename.
 */
export const labelPathSchema = z
  .string()
  .min(1, "label path is required")
  .max(LABEL_PATH_MAX, `label path must be at most ${LABEL_PATH_MAX} characters`)
  .superRefine((value, ctx) => {
    if (value.startsWith("/") || value.endsWith("/")) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "label path must not start or end with '/'" });
      return;
    }
    const segments = value.split("/");
    if (segments.length > LABEL_PATH_MAX_DEPTH) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `label path must be at most ${LABEL_PATH_MAX_DEPTH} segments deep`,
      });
    }
    for (const segment of segments) {
      if (!LABEL_SEGMENT_RE.test(segment)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "each label segment must be kebab-case (lowercase letters, digits, hyphens)",
        });
        return;
      }
    }
  });
export type LabelPath = z.infer<typeof labelPathSchema>;

/** Human-facing label name for a single segment. The canonical path stays kebab-case. */
export const labelDisplayNameSchema = z
  .string()
  .trim()
  .min(1, "label display name is required")
  .max(LABEL_DISPLAY_NAME_MAX, `label display name must be at most ${LABEL_DISPLAY_NAME_MAX} characters`);
export type LabelDisplayName = z.infer<typeof labelDisplayNameSchema>;

function slugifyLabelSegment(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

/**
 * Convert friendly label input into a canonical slash-separated label path.
 * Each slash-separated segment is slugified independently, so `Dev Tools/QA` becomes `dev-tools/qa`.
 */
export function labelDisplayNameToPath(input: string): LabelPath {
  const path = input
    .split("/")
    .map(slugifyLabelSegment)
    .filter(Boolean)
    .join("/");
  return labelPathSchema.parse(path);
}

/**
 * The seven design swatches: six concrete colors + `null` (the default / inherited appearance).
 * Stored verbatim as the `labels.color` string; `null` clears any custom color.
 */
export const LABEL_COLORS = [
  "oklch(0.56 0.13 250)", // blue
  "oklch(0.54 0.10 168)", // teal
  "oklch(0.55 0.13 300)", // violet
  "oklch(0.60 0.10 66)", // amber
  "oklch(0.55 0.13 24)", // terracotta
  "oklch(0.62 0.16 145)", // green
] as const;
export type LabelColor = (typeof LABEL_COLORS)[number];

/** A label color: one of the six swatches, or `null` for the default. */
export const labelColorSchema = z.enum(LABEL_COLORS).nullable();

/**
 * The 17 allowed label icons (lucide glyph names). `null` falls back to the default folder icon.
 * The web Icon component must render every one of these (plus the `folder-open` state).
 */
export const LABEL_ICONS = [
  "folder",
  "tag",
  "bookmark",
  "layers",
  "star",
  "sparkles",
  "globe",
  "users",
  "key",
  "megaphone",
  "code",
  "rocket",
  "package",
  "heart",
  "zap",
  "flame",
  "pen-tool",
] as const;
export type LabelIcon = (typeof LABEL_ICONS)[number];

/** A label icon: one of the 17 allowed glyphs, or `null` for the default folder icon. */
export const labelIconSchema = z.enum(LABEL_ICONS).nullable();

/**
 * The flat appearance record for a path that exists in `labels` (i.e. has an explicit row). Paths
 * that exist only as derived parents or only via assignments do not appear in `flat`.
 */
export const labelVMSchema = z.object({
  path: labelPathSchema,
  displayName: labelDisplayNameSchema.nullable().default(null),
  color: labelColorSchema.default(null),
  icon: labelIconSchema.default(null),
});
export type LabelVM = z.infer<typeof labelVMSchema>;

/**
 * One node of the derived label tree. `name` is the leaf segment; `count` is the de-duped roll-up of
 * skills filed at this path OR any descendant. `children` are the immediate child nodes. `explicit`
 * is true when a `labels` row exists for this exact path (so empty explicit folders still render).
 */
export interface LabelTreeNode {
  path: string;
  name: string;
  displayName: string | null;
  color: LabelColor | null;
  icon: LabelIcon | null;
  count: number;
  explicit: boolean;
  children: LabelTreeNode[];
}

export const labelTreeNodeSchema: z.ZodType<LabelTreeNode> = z.lazy(() =>
  z.object({
    path: labelPathSchema,
    name: z.string(),
    displayName: labelDisplayNameSchema.nullable(),
    color: labelColorSchema,
    icon: labelIconSchema,
    count: z.number().int().nonnegative(),
    explicit: z.boolean(),
    children: z.array(labelTreeNodeSchema),
  }),
);

/** Response of `GET /v1/labels` — the derived tree plus a flat appearance list. */
export const labelsResponseSchema = z.object({
  tree: z.array(labelTreeNodeSchema),
  flat: z.array(labelVMSchema),
});
export type LabelsResponse = z.infer<typeof labelsResponseSchema>;

/**
 * Body of `POST /v1/labels` — create (upsert) a label path, optionally with appearance. Intermediate
 * ancestors are created implicitly by the service.
 */
export const createLabelInputSchema = z.object({
  path: labelPathSchema,
  displayName: labelDisplayNameSchema.optional(),
  color: labelColorSchema.optional(),
  icon: labelIconSchema.optional(),
});
export type CreateLabelInput = z.infer<typeof createLabelInputSchema>;

/**
 * Body of `PUT /v1/labels/rename` — move a path (and its whole subtree) to a new path. Rejected when
 * `to` (or a descendant of it) already exists as a distinct label.
 */
export const renameLabelInputSchema = z.object({
  from: labelPathSchema,
  to: labelPathSchema,
  displayName: labelDisplayNameSchema.optional(),
});
export type RenameLabelInput = z.infer<typeof renameLabelInputSchema>;

/** Body of `PUT /v1/labels/color` — set (or clear, with `null`) a path's color. */
export const setLabelColorInputSchema = z.object({
  path: labelPathSchema,
  color: labelColorSchema,
});
export type SetLabelColorInput = z.infer<typeof setLabelColorInputSchema>;

/** Body of `PUT /v1/labels/icon` — set (or clear, with `null`) a path's icon. */
export const setLabelIconInputSchema = z.object({
  path: labelPathSchema,
  icon: labelIconSchema,
});
export type SetLabelIconInput = z.infer<typeof setLabelIconInputSchema>;

/** Body of `DELETE /v1/labels` — delete a path and its whole subtree across both tables. */
export const deleteLabelInputSchema = z.object({
  path: labelPathSchema,
});
export type DeleteLabelInput = z.infer<typeof deleteLabelInputSchema>;

/**
 * Body of `POST` / `DELETE /v1/skills/:slug/labels` — assign / unassign one path on a skill. The
 * path lives in the body (not the URL) so slashes survive.
 */
export const assignLabelInputSchema = z.object({
  path: labelPathSchema,
});
export type AssignLabelInput = z.infer<typeof assignLabelInputSchema>;

/** Generic OK envelope returned by the label mutation endpoints. */
export const labelMutationResultSchema = z.object({
  ok: z.literal(true),
});
export type LabelMutationResult = z.infer<typeof labelMutationResultSchema>;
