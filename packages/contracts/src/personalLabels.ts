import {
  assignLabelInputSchema,
  createLabelInputSchema,
  deleteLabelInputSchema,
  labelsResponseSchema,
  renameLabelInputSchema,
  setLabelColorInputSchema,
  setLabelIconInputSchema,
} from "./labels";

/**
 * Personal folders are the per-user counterpart to org {@link labels}: they organize a member's
 * private "My Skills" library and are visible only to that member. The path / appearance / request
 * shapes are identical to org labels (same {@link labelPathSchema}, colors, and icons), so the
 * contracts are aliased here rather than redefined. Only the endpoints differ — `/v1/personal-labels`
 * and `/v1/skills/:slug/personal-labels` — and every row is owner-scoped server-side.
 */

/** Response of `GET /v1/personal-labels` — the caller's personal folder tree + flat appearance. */
export const personalLabelsResponseSchema = labelsResponseSchema;

/** Body of `POST /v1/personal-labels` — create (upsert) a personal folder path. */
export const createPersonalLabelInputSchema = createLabelInputSchema;

/** Body of `PUT /v1/personal-labels/rename` — move a personal folder (and its subtree). */
export const renamePersonalLabelInputSchema = renameLabelInputSchema;

/** Body of `PUT /v1/personal-labels/color` — set/clear a personal folder's color. */
export const setPersonalLabelColorInputSchema = setLabelColorInputSchema;

/** Body of `PUT /v1/personal-labels/icon` — set/clear a personal folder's icon. */
export const setPersonalLabelIconInputSchema = setLabelIconInputSchema;

/** Body of `DELETE /v1/personal-labels` — delete a personal folder path and its subtree. */
export const deletePersonalLabelInputSchema = deleteLabelInputSchema;

/** Body of `POST` / `DELETE /v1/skills/:slug/personal-labels` — assign/unassign a personal folder. */
export const assignPersonalLabelInputSchema = assignLabelInputSchema;
