# Companion workspace API — quick reference

Base URL is `COMPANION_API_URL` (ends in `/v1`). Authenticate every request with
`Authorization: Bearer $COMPANION_TOKEN`. The token is scoped to `skills:read` + `skills:write`.

Resolve those values from the environment first. If either variable is missing, read the dedicated
local credentials file written by the Companion install/use prompt:

- macOS/Linux: `~/.companion/credentials.json`
- Windows: `$HOME\.companion\credentials.json`

The file contains `apiUrl`, `token`, and `updatedAt`. Use `apiUrl` as `COMPANION_API_URL` and `token`
as `COMPANION_TOKEN`. Never print the token back to the user.

These are the skills endpoints a personal access token (`skills:read` + `skills:write`) can call:

| Action | Method & path | Scope |
| --- | --- | --- |
| Current published version + checksum | `GET /skills/{slug}/download` | `skills:read` |
| Download a version package | `GET /skills/{slug}/versions/{version}/package` | `skills:read` |
| Browse a version's files | `GET /skills/{slug}/versions/{version}/files` | `skills:read` |
| Validate (no publish) + dependency preflight | `POST /skills?action=validate` | `skills:write` |
| Publish a new skill | `POST /skills` | `skills:write` |
| Update a skill | `POST /skills?expect_slug={slug}&expect_skill_id={id}` | `skills:write` |
| Inspect a skill's dependency graph | `GET /skills/{slug}/dependencies` | `skills:read` |
| Archive a skill | `POST /skills/{slug}/archive` | `skills:write` |
| Restore an archived skill | `POST /skills/{slug}/restore` | `skills:write` |
| List the label (folder) tree | `GET /labels` | `skills:read` |
| Create a label (folder) | `POST /labels` | `skills:write` |
| Rename a label (cascades) | `PUT /labels/rename` | `skills:write` |
| Set a label's color | `PUT /labels/color` | `skills:write` |
| Set a label's icon | `PUT /labels/icon` | `skills:write` |
| Delete a label (cascades) | `DELETE /labels` | `skills:write` |
| File a skill into a label | `POST /skills/{slug}/labels` | `skills:write` |
| Unfile a skill from a label | `DELETE /skills/{slug}/labels` | `skills:write` |
| Current bundled Companion skill status | `GET /local-skills/companion` | `skills:read` |
| Download bundled Companion skill package | `GET /local-skills/companion/package` | `skills:read` |
| Confirm this skill installed | `POST /local-skills/companion/installed` | `skills:write` |

Some skills-management routes are intended for the signed-in web session rather than the
Companion PAT. Use them only when the caller is operating with a valid session cookie:

| Action | Method & path | Auth |
| --- | --- | --- |
| List skills | `GET /skills` | Session |
| Get skill metadata | `GET /skills/{slug}` | Session |
| Enumerate versions | `GET /skills/{slug}/versions` | Session |
| Read comments | `GET /skills/{slug}/comments` | Session |
| Add a comment | `POST /skills/{slug}/comments` | Session |
| Deprecate/restore a comment | `PATCH /skills/{slug}/comments/{id}` | Session |
| Read a comment image | `GET /skills/{slug}/comments/{commentId}/images/{imageId}` | Session |
| Toggle star | `POST /skills/{slug}/star` | Session |

A comment row includes an `images` array; each image carries `id`, `content_type`, `byte_size`,
`position`, and a `url` (the session-gated path above) for display. To attach images when adding a
comment, send `POST /skills/{slug}/comments` as `multipart/form-data` with the `body` field plus up to
six `image` files (PNG, JPEG, WebP, or GIF, 10 MB each); the content type is verified from the file
bytes. Text-only comments may still be sent as JSON.

Do not use this skill for workspace members, invitations, org settings, or token management.
Those are outside the skills-only management surface.

Listing the whole workspace catalog (`GET /skills`) and enumerating versions are session-only in the
web app and reject tokens. To inventory what is installed on this machine, read the local skill
folders directly (each has a `SKILL.md` with `metadata.companion_skill_id` / `companion_version`).

The built-in Companion skill is different from user-published skills. For the skill shown in the
workspace's **Companion skills** section, use only the `/local-skills/companion` endpoints.

## Upload bodies and labels

There is no owner and no visibility. Every skill in a workspace is visible to every member, and any
member can read, edit, archive, or delete any skill. Skills are organized with **labels** (folders)
instead — see "Labels (folders)" below.

`POST /skills` accepts either:

- `multipart/form-data` with a `file` field (and `version` / `message` / `expect_slug` /
  `expect_skill_id` / `dependency` / `label` fields), or
- a raw `application/zip` or `application/gzip` body (the archive itself), with the same options as
  query params.

Declare dependencies in the package root `companion.json`. The API still accepts repeated
`dependency=<slug>` parameters as a legacy fallback only when the uploaded archive has no
`companion.json`; when the manifest exists, its `dependencies` list wins. The Companion skill must
analyze the local package, compare the result with `companion.json`, ask before changing the
dependency list, synchronize `companion.json` to the confirmed final list, and only then package and
send the archive. Set `action=validate` to run every package and identity check without publishing;
the validate response is `{ "result": <validation>, "dependency_plan": <plan> }`.

To file the new skill under one or more folders at publish time, repeat a `label` parameter whose
value is a label path (URL-encode the slashes, `%2F`). The folders are created if they do not exist.
Omit `label` to leave the skill unfiled. A label path is slash-separated, lower-case kebab segments
(`[a-z0-9]+(?:-[a-z0-9]+)*`), no empty/leading/trailing slash, and a bounded length and depth.
Labels never affect who can see a skill — they only file it.

- Sending legacy `owner_team`, `everyone`, `team`, `teams`, `scope`, `visibility`, or `private`
  parameters is rejected, and a skill must not declare `scope` or `visibility` in its `SKILL.md`.

Examples:

```http
POST /skills?label=marketing&label=marketing%2Fseo
Content-Type: application/zip
```

```http
POST /skills
Content-Type: application/zip
```

## Targeted updates

When updating a skill that already exists, send both `expect_slug` and `expect_skill_id`. The server
rejects the upload if the package's frontmatter `name` differs from `expect_slug`, or if its
`metadata.companion_skill_id` points at a different skill. This makes it impossible for an edit to
silently retarget another skill.

A re-publish leaves the skill's existing labels untouched. Pass `label` on an update only to **add**
the skill to more folders; to remove a skill from a folder, call `DELETE /skills/{slug}/labels`
instead of re-publishing.

## Dependencies & archive

Dependencies are un-versioned skill→skill links persisted in a package's `companion.json`
(`{ "dependencies": ["slug-a", "slug-b"] }`). Before validate or publish, the Companion skill must
still analyze the full local package, compare inferred dependencies with `companion.json`, and ask
before synchronizing additions or removals. Package only after `companion.json` matches the confirmed
final list. Repeated `dependency=` parameters are accepted only for old packages without
`companion.json`; do not send them for manifest-backed packages because the manifest is the source of
truth.

`POST /skills?action=validate&dependency=...` returns a `dependency_plan`:

```json
{
  "declared": ["log-parser", "timeline-fmt"],
  "ready": ["log-parser"],
  "upload": [{ "slug": "timeline-fmt", "msg": "declared in the new SKILL.md, not in the registry" }],
  "removed": ["csv-export"],
  "archive_candidates": [{ "slug": "csv-export", "reason": "no published skill requires it anymore" }],
  "blocked": [{ "slug": "self-loop", "status": "cycle", "msg": "self-loop forms a dependency cycle" }]
}
```

A publish whose dependencies are missing or cyclic is rejected with `422` and the same
`dependency_plan` (look at `blocked`). Every skill is visible to every member, so there is no
visibility to reconcile across a dependency edge. Publish dependencies in `upload` first, in
topological order.

`GET /skills/{slug}/dependencies?version=` returns the resolved Requires + Used by graph. Each edge
keeps a live status (`satisfied` / `missing` / `archived` / `cycle`).

Archiving hides a skill from the normal lists but keeps it viewable, restorable, and downloadable
while a published version still references it. `POST /skills/{slug}/archive` accepts an optional
`{ "reason": "…" }`; `POST /skills/{slug}/restore` brings it back. Both require the same permission
as modifying the skill. Only archive a removed dependency after the user confirms, and never when
another published skill still requires it.

## Labels (folders)

Labels are an org-wide, **shared** folder tree — the only axis for organizing skills. A label is a
slash-separated path of lower-case kebab segments (`marketing/seo`) with an optional human-facing
`displayName` (`SEO`); a skill can carry several, folders may be empty, and labels never change who
can see a skill. Any member can create, assign, rename, recolor, or delete a label. **The path always
travels in the request body or query, never as a URL path segment**, so the slashes inside a path
survive routing.

`GET /labels` returns `{ "tree": [...], "flat": [...] }`:

```json
{
  "tree": [
    {
      "path": "marketing",
      "name": "marketing",
      "displayName": "Marketing",
      "color": null,
      "icon": null,
      "count": 3,
      "explicit": true,
      "children": [
        { "path": "marketing/seo", "name": "seo", "displayName": "SEO", "color": "oklch(0.72 0.18 145)", "icon": "rocket", "count": 1, "explicit": true, "children": [] }
      ]
    }
  ],
  "flat": [
    { "path": "marketing", "displayName": "Marketing", "color": null, "icon": null },
    { "path": "marketing/seo", "displayName": "SEO", "color": "oklch(0.72 0.18 145)", "icon": "rocket" }
  ]
}
```

`count` is the roll-up of skills at that path or any descendant, de-duplicated per skill. `explicit`
is `true` when a canonical `labels` row exists for the path (an intermediate parent derived only from
a child's path is `explicit: false`). `displayName` is nullable and falls back to the path leaf when
absent. `color` is one of the design swatches or `null`; `icon` is one of the allowed glyph names or
`null`.

Manage the tree (each returns `{ "ok": true }`):

```http
POST /labels            { "path": "marketing/seo", "displayName": "SEO", "color": null, "icon": null }
PUT  /labels/rename     { "from": "marketing", "to": "growth", "displayName": "Growth" }
PUT  /labels/color      { "path": "growth/seo", "color": "oklch(0.72 0.18 145)" }
PUT  /labels/icon       { "path": "growth/seo", "icon": "rocket" }
DELETE /labels          { "path": "growth/seo" }
```

`POST /labels` upserts the path and its ancestors so an empty folder can exist. `rename` and `DELETE`
**cascade** over the path and every descendant (`path = $p OR path LIKE $p/%`) across both the label
set and the skill assignments, in one transaction; `rename` is rejected if `to` collides with an
existing path. Deleting a folder only unfiles its skills — it never deletes a skill.

File a skill into or out of a folder (the skill keeps all its other labels):

```http
POST   /skills/{slug}/labels   { "path": "growth/seo" }
DELETE /skills/{slug}/labels   { "path": "growth/seo" }
```

`POST` upserts the assignment and any missing ancestor folder rows; `DELETE` removes the single
assignment. Both return `{ "ok": true }`. All label routes require any signed-in member or a
`skills:write` token; there is no owner check.

## Versions & checksums

Versions are immutable. Each version row carries a `checksum` of the form `sha256:<64 hex>` over the
canonical (uncompressed) tar. This is **not** the hash of the `.zip` the package endpoint serves, so
treat it as a version identity reference, not a byte check of the download. To confirm an install,
check that `SKILL.md` is at the package root and its `metadata.companion_version` matches the
version you fetched.

## Update the Companion skill itself

To check whether this local Companion skill is current:

```http
GET /local-skills/companion
```

The response includes `status`, `installedVersion`, `availableVersion`, and `changes`. Compare
`availableVersion` with the `metadata.companion_version` in the installed Companion skill's
`SKILL.md`. If they match, no update is needed.

If `availableVersion` is newer, download the bundled package:

```http
GET /local-skills/companion/package
```

Extract it into a temporary directory, verify `SKILL.md` is at the package root, and verify its
`metadata.companion_version` equals the `availableVersion` from `/local-skills/companion`. Only then
replace the installed Companion skill folder. After replacement, call
`POST /local-skills/companion/installed` with the installed version so the workspace status updates.

Do not use `/skills/{slug}/download` or `/skills/{slug}/versions/{version}/package` to update the
built-in Companion skill. Those endpoints are for workspace-published skills.

## Confirm install

```http
POST /local-skills/companion/installed
Content-Type: application/json

{ "version": "1.8.0", "agent": "Claude Code" }
```

`version` must be valid semver (use this skill's `metadata.companion_version`). The response is
`{ "ok": true, "status": "installed" | "update", "availableVersion": "1.8.0" }`.
