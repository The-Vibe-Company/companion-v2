# Companion workspace API — quick reference

Base URL is `COMPANION_API_URL` (ends in `/v1`). The active workspace id is
`COMPANION_WORKSPACE_ID` (`organizations.id`). Authenticate management requests with
`Authorization: Bearer $COMPANION_TOKEN`. The token is scoped to `skills:read` + `skills:write`.
The public preview endpoint documented below intentionally does not use this token.

Resolve those values from the environment first. If either variable is missing, read the dedicated
local credentials file written by the Companion install/use prompt:

- macOS/Linux: `~/.companion/credentials.json`
- Windows: `$HOME\.companion\credentials.json`

The current file is schema v2 and is keyed by workspace id:

```json
{
  "schemaVersion": 2,
  "activeWorkspaceId": "6a9c3cfd-6a1e-4a7b-8f77-1f7f0e62e3d4",
  "workspaces": {
    "6a9c3cfd-6a1e-4a7b-8f77-1f7f0e62e3d4": {
      "apiUrl": "https://companion.acme.dev/v1",
      "token": "cmp_pat_...",
      "updatedAt": "2026-06-15T12:00:00.000Z"
    }
  }
}
```

Use `activeWorkspaceId` to pick the workspace entry, then use that entry's `apiUrl` and `token`.
For the legacy flat shape `{ "apiUrl": "...", "token": "..." }`, use those values and call
token-supported `GET /local-skills/companion` to read its `workspaceId` before writing local
inventory. Never print the token back to the user.

These are the skills endpoints a personal access token (`skills:read` + `skills:write`) can call:

| Action | Method & path | Scope |
| --- | --- | --- |
| List org library skills | `GET /skills?lib=org` | `skills:read` |
| List My Skills | `GET /skills?lib=mine` | `skills:read` |
| List reported installed skills | `GET /skills?installed=true` | `skills:read` |
| Current published version + checksum | `GET /skills/{slug}/download` | `skills:read` |
| Download a version package | `GET /skills/{slug}/versions/{version}/package` | `skills:read` |
| Browse a version's files | `GET /skills/{slug}/versions/{version}/files` | `skills:read` |
| Validate (no publish) + dependency preflight | `POST /skills?action=validate` | `skills:write` |
| Publish a new skill | `POST /skills` | `skills:write` |
| Update a skill | `POST /skills?expect_slug={slug}&expect_skill_id={id}` | `skills:write` |
| Rename a skill in place | `POST /skills/{slug}/rename` | `skills:write` |
| Inspect a skill's dependency graph | `GET /skills/{slug}/dependencies` | `skills:read` |
| Archive a skill | `POST /skills/{slug}/archive` | `skills:write` |
| Restore an archived skill | `POST /skills/{slug}/restore` | `skills:write` |
| Preview private deps included when sharing | `GET /skills/{slug}/share-plan` | `skills:read` |
| Share a personal skill to the org | `POST /skills/{slug}/share` | `skills:write` |
| List the label (folder) tree | `GET /labels` | `skills:read` |
| Create a label (folder) | `POST /labels` | `skills:write` |
| Rename a label (cascades) | `PUT /labels/rename` | `skills:write` |
| Set a label's color | `PUT /labels/color` | `skills:write` |
| Set a label's icon | `PUT /labels/icon` | `skills:write` |
| Delete a label (cascades) | `DELETE /labels` | `skills:write` |
| File a skill into a label | `POST /skills/{slug}/labels` | `skills:write` |
| Unfile a skill from a label | `DELETE /skills/{slug}/labels` | `skills:write` |
| List the personal folder tree | `GET /personal-labels` | `skills:read` |
| Create a personal folder | `POST /personal-labels` | `skills:write` |
| Rename a personal folder (cascades) | `PUT /personal-labels/rename` | `skills:write` |
| Set a personal folder's color | `PUT /personal-labels/color` | `skills:write` |
| Set a personal folder's icon | `PUT /personal-labels/icon` | `skills:write` |
| Delete a personal folder (cascades) | `DELETE /personal-labels` | `skills:write` |
| File a personal skill into a personal folder | `POST /skills/{slug}/personal-labels` | `skills:write` |
| Unfile a personal skill from a personal folder | `DELETE /skills/{slug}/personal-labels` | `skills:write` |
| Current bundled Companion skill status + workspace id | `GET /local-skills/companion` | `skills:read` |
| Download bundled Companion skill package | `GET /local-skills/companion/package` | `skills:read` |
| Confirm this skill installed | `POST /local-skills/companion/installed` | `skills:write` |
| Fetch companion.json v2 schema | `GET /v1/schemas/companion-manifest.v2.schema.json` | Public |

Public org-skill previews are separate from PAT-authenticated management. Use the `share_token`
returned on skill rows to build the web URL `/s/{share_token}` or to fetch metadata directly:

```http
GET /public/skills/{share_token}
```

This endpoint is unauthenticated. It returns only `display_name`, `slug`, `description`,
`current_version`, `creator_name`, `creator_initials`, `star_count`, and `updated_at` for a live org
skill. Personal, archived, and unknown tokens return 404. It never exposes package content, files,
downloads, requirements, secrets, labels, `id`, `org_id`, or `creator_id`.

The signed-in web app uses `GET /skills/share-target/{share_token}` with a session cookie to resolve
`{org_id, slug}` for members before opening the slug-keyed detail route. Agents should normally share
the web URL `/s/{share_token}` instead of calling that resolver directly.

After a successful skill upload or update, agents must include a `Skill link: ...` line in the chat.
For org skills, fetch `GET /skills?lib=org`, find the published `slug`, and build
`${COMPANION_API_URL without /v1}/s/{share_token}` from that row. Personal skills have no public
preview until they are shared to the org; use the signed-in detail URL
`${COMPANION_API_URL without /v1}/skills?skill={slug}` instead. If the publish succeeded but the
org `share_token` lookup fails, do not republish; report success and provide the signed-in detail
fallback.

Some skills-management routes are intended for the signed-in web session rather than the
Companion PAT. Use them only when the caller is operating with a valid session cookie:

| Action | Method & path | Auth |
| --- | --- | --- |
| Resolve a share link target | `GET /skills/share-target/{share_token}` | Session |
| Get skill metadata | `GET /skills/{slug}` | Session |
| Enumerate versions | `GET /skills/{slug}/versions` | Session |
| Read comments | `GET /skills/{slug}/comments` | Session |
| Add a comment | `POST /skills/{slug}/comments` | Session |
| Deprecate/restore a comment | `PATCH /skills/{slug}/comments/{id}` | Session |
| Read a comment image | `GET /skills/{slug}/comments/{commentId}/images/{imageId}` | Session |
| Toggle star | `POST /skills/{slug}/star` | Session |

Version rows returned by `GET /skills/{slug}/versions` include a nullable `changelog` object. When
present, it is the `companion.json.metadata.changelog` entry for that exact version and carries
`version`, optional `date`, and `changes`.

A comment row includes an `images` array; each image carries `id`, `content_type`, `byte_size`,
`position`, and a `url` (the session-gated path above) for display. To attach images when adding a
comment, send `POST /skills/{slug}/comments` as `multipart/form-data` with the `body` field plus up to
six `image` files (PNG, JPEG, WebP, or GIF, 10 MB each); the content type is verified from the file
bytes. Text-only comments may still be sent as JSON.

Skill metadata rows returned by `GET /skills` and `GET /skills/{slug}` include both `description`
(the short summary used in lists and detail leads) and `notes` (optional Markdown-compatible
`companion.json` notes). Rows also include `share_token`, which is only for org-skill public preview
links and is not an auth credential. Keep summaries and notes distinct: do not copy setup notes or
long Markdown content into `description`.

Do not use this skill for workspace members, invitations, org settings, or token management.
Those are outside the skills-only management surface.

Listing the workspace catalog (`GET /skills?lib=org`), My Skills (`GET /skills?lib=mine`), and
Companion-reported installs (`GET /skills?installed=true`) works with a `skills:read` token.
`installed=true` means the current user has a `skill_installs` row in Companion; it does not prove
the package files still exist on disk. To inventory what is actually installed on this machine, read
the active workspace-id entry in `~/.companion/skills.lock.json` first, then fall back to pointed-at
skill folders with `companion.json.metadata.companionSkillId` / `companion.json.version`.
`~/.companion/skills.log.json` is a legacy alias: read it only once if `skills.lock.json` is absent,
then write future state to `skills.lock.json`.

The built-in Companion skill is different from user-published skills. For the skill shown in the
workspace's **Companion skills** section, use only the `/local-skills/companion` endpoints.
The `GET /local-skills/companion` response includes `workspaceId`; use it as
`COMPANION_WORKSPACE_ID` when migrating legacy flat credentials or URL-keyed lockfiles.

## Libraries (personal vs org)

A skill lives in one of two libraries, set by its `scope`:

- **`org`** — the flat org-wide library: visible to every member, and any member can read, edit,
  archive, or delete it. Organized with org-wide **labels** (folders).
- **`personal`** — a private "My Skills" library: visible only to its creator (even to admins).
  Organized with the creator's own **personal folders** (`/personal-labels`).

`GET /skills?lib=mine` returns the caller's My Skills (their authored personal skills plus org skills
they have installed); `GET /skills?lib=org` (the default) returns the org library. On first publish,
the `scope` field chooses the library. The Companion skill must send `scope=personal` or `scope=org`
explicitly for a brand-new skill after asking the user where to publish it; do not rely on server
defaults. Re-publishing never changes scope, so do not send `scope` on updates. Depending on server
version, update-time `scope` may be ignored or rejected if it contradicts the existing skill.
**`GET /skills/{slug}/share-plan`** previews the mandatory private dependency migration for a personal
skill. It returns the private dependencies owned by the same creator that will be shared with the root
skill, plus any blocking dependency issues. **`POST /skills/{slug}/share`** is the only way to move a
personal skill into the org library (owner only, one-way). Sharing is atomic and includes those private
dependencies automatically; the response includes `shared_dependencies`. A skill name (slug) is unique
across both libraries in a workspace.

## Upload bodies and labels

`POST /skills` accepts either:

- `multipart/form-data` with a `file` field (and `version` / `message` / `expect_slug` /
  `expect_skill_id` / `scope` / `dependency` / `label` fields), or
- a raw `application/zip` or `application/gzip` body (the archive itself), with the same options as
  query params.

Declare dependencies in the package root `companion.json`. Manifest v2 uses a name-to-id map:
`{ "dependencies": { "markdown-report": "84d8bee1-5ad3-4676-8c16-730e2a15ba70" } }`.
The API still accepts repeated `dependency=<slug>` parameters as a legacy fallback only when the
uploaded archive has no `companion.json`; when the manifest exists, its dependency keys win. The
Companion skill must analyze the local package, compare the result with `companion.json`, ask before
changing the dependency map, resolve each dependency to its workspace skill id, synchronize
`companion.json`, and only then package and send the archive. Set `action=validate` to run every
package and identity check without publishing; the validate response is
`{ "result": <validation>, "dependency_plan": <plan> }`.

After a successful publish or re-publish performed by the Companion skill, an org skill must be
reported as installed for the current user:

```http
POST /skills/{slug}/install
Content-Type: application/json

{ "version": "1.10.0", "source": "agent", "agent": "Claude Code" }
```

Skip this install report for personal skills; they already appear in the author's My Skills library.
If the install report fails after publish succeeds, do not republish. Tell the user publish succeeded
and retry only the install report.

The install report stays **aggregate**: the workspace tracks one `skill_installs` row per user, with
no per-tool dimension. When a skill is installed into several local tools at once (Claude Code, Codex,
…) or into multiple projects, still send a **single** `POST /skills/{slug}/install`, using `agent` to
name the tools (for example `"Claude Code, Codex"`). The per-tool, per-project install locations are
tracked locally, not in the workspace: each lockfile skill record carries a `targets[]` array
(`{ tool, scope, path, checksum }`), user-scope targets in `~/.companion/skills.lock.json` and
project-scope targets in a per-project `<repo>/.companion/skills.lock.json`. A legacy single-`installPath`
record reads as one `claude-code`/`user` target.

Before publishing a brand-new skill, the Companion skill must ask the user for both placement
decisions: Personal/My Skills vs Org/everyone, then existing folder, new folder, or no folder. Fetch
the relevant tree first (`GET /personal-labels` for personal, `GET /labels` for org) and validate new
paths as slash-separated, lower-case kebab segments (`[a-z0-9]+(?:-[a-z0-9]+)*`), with no
empty/leading/trailing slash. Labels never affect who can see a skill — they only file it.

For org skills, file a new skill under one or more folders at publish time by repeating a `label`
parameter whose value is a label path (URL-encode the slashes, `%2F`). The folders are created if
they do not exist. Omit `label` to leave the skill unfiled. For personal skills, use the API-supported
personal-folder flow. If publish-time personal labels are not supported by the target server, publish
with `scope=personal`, then immediately file the returned slug with `POST /skills/{slug}/personal-labels`
using the path the user already confirmed.

- `scope` (`personal` | `org`) chooses the library on first create. The Companion skill must send it
  explicitly for new skills. Do not send it on re-publish; updates preserve the existing scope.
  Sending legacy `owner_team`, `everyone`, `team`, `teams`, `visibility`, or `private` parameters is
  rejected, and a skill must not declare `scope` or `visibility` in its `SKILL.md`.
- Personal-folder endpoints mirror the org `/labels` set under `/personal-labels` and
  `/skills/{slug}/personal-labels`; they only organize your own authored personal skills.

Examples:

```http
POST /skills?scope=org&label=marketing&label=marketing%2Fseo
Content-Type: application/zip
```

```http
POST /skills?scope=personal
Content-Type: application/zip
```

## Targeted updates

When updating a skill that already exists, send both `expect_slug` and `expect_skill_id`. The server
**requires** both whenever the published slug already exists and rejects the update otherwise
(`updating skill "<name>" requires expect_slug and expect_skill_id`). It also rejects the upload if the
package's frontmatter `name` differs from `expect_slug`. Legacy `metadata.companion_skill_id` is
accepted only as a migration fallback.

On top of that, the server enforces the slug ↔ id binding on **every** publish and validate, even when
no `expect_*` is sent: if the package's `companion.json.metadata.companionSkillId` resolves to a
workspace skill whose slug is not the package name, the upload is rejected
(`package Companion skill id "<id>" belongs to skill "<other>", not "<name>"; refusing to retarget`),
and if a skill already exists for the package slug but the package declares a different id, the upload
is rejected (`skill "<name>" has id "<id>", but the package declares Companion skill id "<other>";
refusing to retarget`). This makes it impossible for an edit to silently retarget another skill.

## Rename a skill

Use `POST /skills/{slug}/rename` only when the user explicitly wants the same workspace skill id to
move to a new slug. This is not a publish and does not create, archive, duplicate, or replace a skill.

```http
POST /skills/skill-creator/rename
Content-Type: application/json

{ "newSlug": "skill-creator-and-eval", "title": "Skill Creator and Eval" }
```

The response is `{ "ok": true, "id": "...", "old_slug": "skill-creator", "slug":
"skill-creator-and-eval", "title": "Skill Creator and Eval" }`. The `id`, versions, labels,
installs, stars, comments, share token, dependency links, checksums, and package history stay attached
to the same skill. Existing public `/s/{share_token}` links remain valid and resolve to the new slug.
Historical package archives are not rewritten.

After a successful rename, update the local package folder so future publishes use the new slug:
change `SKILL.md` frontmatter `name` and `companion.json.name` to the returned `slug`, keep
`companion.json.metadata.companionSkillId` unchanged, and send future updates with
`expect_slug={newSlug}&expect_skill_id={id}`. Do not try to rename by uploading the old
`companionSkillId` under a new package name; normal `POST /skills` retarget protection will reject it.

A re-publish preserves the skill's existing scope and labels. Do not ask Personal vs Org for updates,
because scope is immutable. Re-publish never moves, adds, or removes folder labels. Ask only whether
to add folders after the update; if yes, publish the new version first, then call
`POST /skills/{slug}/labels` for org skills or `POST /skills/{slug}/personal-labels` for personal
skills using the already-confirmed paths and the library already known from the current workflow. The
token-supported download endpoint does not expose `scope`; if the skill's library is not known, do
not guess or try both routes. Publish the update without folder changes and ask the user to run a
separate organize/folder command from the skill's library context. To remove a skill from a folder,
call the org or personal label routes separately and only after explicit user confirmation.

## Dependencies & archive

Dependencies are un-versioned skill→skill links persisted in a package's `companion.json`
(`{ "dependencies": { "slug-a": "skill-uuid" } }`). Before validate or publish, the Companion skill
must still analyze the full local package, compare inferred dependencies with `companion.json`, and
ask before synchronizing additions or removals. Package only after `companion.json` matches the
confirmed dependency map. Repeated `dependency=` parameters are accepted only for old packages without
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
`dependency_plan` (look at `blocked`). Dependency checks use the normal access model: org skills are
visible to every member, while personal skills are visible only to their creator. Publish dependencies
in `upload` first, in topological order.

`GET /skills/{slug}/dependencies?version=` returns the resolved Requires + Used by graph. Each edge
keeps a live status (`satisfied` / `missing` / `archived` / `cycle`). Dependency reads use the stable
target skill id when the server has one, so a renamed dependency continues to resolve and is shown
under its current slug.

Archiving hides a skill from the normal lists but keeps it viewable, restorable, and downloadable
while a published version still references it. `POST /skills/{slug}/archive` accepts an optional
`{ "reason": "…" }`; `POST /skills/{slug}/restore` brings it back. Both require the same permission
as modifying the skill. Only archive a removed dependency after the user confirms, and never when
another published skill still requires it.

## Org labels (folders)

Org labels are the org-wide, **shared** folder tree for org skills. Personal skills use the mirrored
personal folder routes under `/personal-labels` and `/skills/{slug}/personal-labels`. A label is a
slash-separated path of lower-case kebab segments (`marketing/seo`) with an optional human-facing
`displayName` (`SEO`); a skill can carry several, folders may be empty, and labels never change who
can see a skill. Any member can create, assign, rename, recolor, or delete an org label. **The path
always travels in the request body or query, never as a URL path segment**, so the slashes inside a
path survive routing.

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

Personal folder routes use the same request bodies and response shapes under `/personal-labels` and
`/skills/{slug}/personal-labels`, but are scoped to the caller and only organize authored personal
skills.

## Versions & checksums

Versions are immutable. Each version row carries a `checksum` of the form `sha256:<64 hex>` over the
canonical (uncompressed) tar. This is **not** the hash of the `.zip` the package endpoint serves, so
treat it as a version identity reference, not a byte check of the download. To confirm an install,
check that `SKILL.md` is at the package root and `companion.json.version` matches the version you
fetched.

Before the Companion skill installs or updates a workspace-published skill, it must inspect the
target `companion.json.environment.secrets`. Secrets marked `required: true` block installation until
the user confirms they are already available/configured, or explicitly authorizes installing without
them. The agent must never ask the user to paste secret values. Optional secrets and non-secret
environment variables are surfaced as setup notes only. If required secrets are not confirmed and no
override is given, stop before downloading/replacing files, calling install endpoints, or writing
`~/.companion/skills.lock.json`. This guard does not apply to the bundled Companion self-update
endpoints under `/local-skills/companion`.

## Local manifest checks

Manifest v2 may declare a local update check:

```json
{
  "checks": {
    "updates": {
      "runtime": "python",
      "script": "scripts/bootstrap.py",
      "timeoutSeconds": 30
    }
  }
}
```

The Companion API validates the declaration and verifies the referenced script is packaged, but it
never executes the script. The installed Companion skill runs it locally when asked to audit updates.
The bundled `scripts/bootstrap.py` resolves credentials, calls `GET /local-skills/companion`,
`GET /skills?lib=mine`, `GET /skills?lib=org`, and `GET /skills?installed=true`, then compares those
rows with `~/.companion/skills.lock.json` or the legacy `skills.log.json` fallback.
`scripts/check_updates.py` remains a compatibility wrapper around the bootstrap.

Run the fast bootstrap when the agent needs startup context:

```sh
python3 scripts/bootstrap.py --json --auto-update-companion
```

The JSON shape is stable and contains `workspace`, `companion`, `integrity`, `skills`, `actions`, and
`errors`. With `--auto-update-companion`, the script may update only the Companion skill itself. It
never installs workspace-published skill updates; it only reports those as actions.

## Local preflight guard

`scripts/skill_guard.py` is a local-only preflight the installed Companion skill runs before it
creates, updates, installs, or writes the lockfile for a skill. Like the update check, the API never
runs it.

```sh
python3 scripts/skill_guard.py --json [--create-check <slug>] [skill-dir ...]
```

It unions `GET /skills?lib=org`, `?lib=mine`, `?installed=true`, and the `archived=true` views with the
local inventory (`~/.companion/skills.lock.json` plus scanned local skill folders), reports
duplication / retargeting conflicts, and — when `--create-check` is passed — refuses to create over a
slug that already exists anywhere. If a legacy `~/.companion/skills.log.json` is present it is migrated
into `skills.lock.json` and deleted; secrets are never copied and the token is never printed. Exit code
`0` means clean (warnings allowed), `2` means a blocking conflict or a refused create, `1` means it
could not run.

## Update the Companion skill itself

The Companion skill must check whether this local Companion skill is current at startup, before any
other Companion task or skill mutation:

```http
GET /local-skills/companion
```

The response includes `status`, `installedVersion`, `availableVersion`, `changes`, and `integrity`.
`integrity.packageChecksum` is the canonical bundled package checksum, and `integrity.files` maps
package-relative paths such as `SKILL.md`, `companion.json`, and `scripts/bootstrap.py` to official
`sha256:<hex>` file hashes. Compare `availableVersion` with the version in the installed Companion
skill's `companion.json`. If they match, no update is needed.

If `availableVersion` is newer, download the bundled package:

```http
GET /local-skills/companion/package
```

Before replacing anything, compare the installed tracked files with the installed package's
`companion.integrity.json` baseline. If the installed copy predates that baseline and already matches
`availableVersion`, use `integrity.files` from `/local-skills/companion` as the fallback baseline. If
any tracked file is modified or missing against the selected baseline, preserve the local folder and
report `reason: "local_customizations"`. If all tracked files match, extract the package into a
temporary directory, verify `SKILL.md` is at the package root, verify its `companion.json.version`
equals the `availableVersion` from `/local-skills/companion`, and verify the staged
`companion.integrity.json` matches the staged package files. Only then replace the installed
Companion skill folder. After replacement, call `POST /local-skills/companion/installed` with the
installed version so the workspace status updates. After that install report succeeds, delete only
the backup folder created for this self-update. Keep the backup if install reporting fails, and never
delete older Companion backup folders that existed before this update.

Do not use `/skills/{slug}/download` or `/skills/{slug}/versions/{version}/package` to update the
built-in Companion skill. Those endpoints are for workspace-published skills.

## Confirm install

```http
POST /local-skills/companion/installed
Content-Type: application/json

{ "version": "1.13.0", "agent": "Claude Code" }
```

`version` must be valid semver (use this skill's `companion.json.version`). The response is
`{ "ok": true, "status": "installed" | "update", "availableVersion": "1.13.0" }`.
