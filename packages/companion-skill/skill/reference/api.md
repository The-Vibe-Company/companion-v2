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
| Upload owner choices | `GET /skills/upload-options` | `skills:write` |
| Current published version + checksum | `GET /skills/{slug}/download` | `skills:read` |
| Download a version package | `GET /skills/{slug}/versions/{version}/package` | `skills:read` |
| Browse a version's files | `GET /skills/{slug}/versions/{version}/files` | `skills:read` |
| Validate (no publish) + dependency preflight | `POST /skills?action=validate` | `skills:write` |
| Publish a new skill | `POST /skills` | `skills:write` |
| Update a skill | `POST /skills?expect_slug={slug}&expect_skill_id={id}` | `skills:write` |
| Inspect a skill's dependency graph | `GET /skills/{slug}/dependencies` | `skills:read` |
| Change a skill's owner | `PUT /skills/{slug}/owner` | `skills:write` |
| Archive a skill | `POST /skills/{slug}/archive` | `skills:write` |
| Restore an archived skill | `POST /skills/{slug}/restore` | `skills:write` |
| Current bundled Companion skill status | `GET /local-skills/companion` | `skills:read` |
| Download bundled Companion skill package | `GET /local-skills/companion/package` | `skills:read` |
| Confirm this skill installed | `POST /local-skills/companion/installed` | `skills:write` |

Some skills-management routes are intended for the signed-in web session rather than the
Companion PAT. Use them only when the caller is operating with a valid session cookie:

| Action | Method & path | Auth |
| --- | --- | --- |
| List visible skills | `GET /skills` | Session |
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

Do not use this skill for workspace members, teams, invitations, org settings, or token management.
Those are outside the skills-only management surface.

Listing the whole workspace catalog (`GET /skills`) and enumerating versions are session-only in the
web app and reject tokens. To inventory what is installed on this machine, read the local skill
folders directly (each has a `SKILL.md` with `metadata.companion_skill_id` / `companion_version`).

The built-in Companion skill is different from user-published skills. For the skill shown in the
workspace's **Companion skills** section, use only the `/local-skills/companion` endpoints.

## Upload bodies and ownership

Before asking the user to choose an owner, fetch the available choices:

```http
GET /skills/upload-options
```

The response shape is:

```json
{
  "defaults": {
    "owner_team": null
  },
  "teams": [
    {
      "id": "team_...",
      "slug": "platform",
      "name": "Platform",
      "color": null,
      "icon": null,
      "teamRole": "editor",
      "canOwn": true
    }
  ]
}
```

Owner is the single access choice — present one picker: "Personal" (private to the user) plus
`canOwn=true` teams (a team-owned skill is readable by every workspace member). For a new publish,
keep the response defaults (`owner_team: null`, i.e. Personal) unless the user chooses otherwise.

`POST /skills` accepts either:

- `multipart/form-data` with a `file` field (and `owner_team` / `version` / `message` /
  `expect_slug` / `expect_skill_id` / `dependency` fields), or
- a raw `application/zip` or `application/gzip` body (the archive itself), with the same options as
  query params.

Declare dependencies in the package root `companion.json`. The API still accepts repeated
`dependency=<slug>` parameters as a legacy fallback only when the uploaded archive has no
`companion.json`; when the manifest exists, its `dependencies` list wins. The Companion skill must
analyze the local package, compare the result with `companion.json`, ask before changing the
dependency list, synchronize `companion.json` to the confirmed final list, and only then package and
send the archive. Set `action=validate` to run every package and identity check without publishing;
the validate response is `{ "result": <validation>, "dependency_plan": <plan> }`.

Owner is the single access axis — there is no separate visibility:

- `owner_team=<team-slug>` makes the skill **Team-owned**: readable by every member of the workspace
  and editable by that team's Admins/Editors (plus org Owners/Admins). The actor must be an
  organization Owner/Admin, or an Admin/Editor of that team. Team Readers cannot upload or update for
  the team.
- Omit `owner_team` for **Personal** ownership: the skill is private to the owning user (only they and
  org admins can read or edit it).
- "Sharing broadly" means assigning the skill to a team — all team skills are workspace-visible. There
  is no separate "Everyone" share, and a skill must not declare visibility in its `SKILL.md`.
- Sending legacy `everyone`, `team`, `teams`, `scope`, or `visibility` parameters is rejected.

Examples:

```http
POST /skills?owner_team=platform
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

The owner is **immutable on update**. Omit `owner_team` and the skill's current owner is kept. If you
do include `owner_team`, it must match the skill's current owner team. Publishing a new version cannot
move a skill between Personal and team ownership, or from one owner team to another — use
`PUT /skills/{slug}/owner` for that.

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
  "blocked": [{ "slug": "secret-helper", "status": "visibility", "msg": "secret-helper is Personal and not visible to everyone who can see incident-summary" }]
}
```

A publish whose dependencies are missing, cyclic, or less visible than the skill is rejected with
`422` and the same `dependency_plan` (look at `blocked`). The owner-cover rule: a team-owned target
covers any dependent; a Personal target only covers a dependent that is Personal **and** owned by the
same user. So a Personal dependency under a Team-owned dependent (visible to everyone) is a
`visibility` mismatch. Publish dependencies in `upload` first, in topological order.

`GET /skills/{slug}/dependencies?version=` returns the resolved Requires + Used by graph. Each row
carries an `owner_kind` (`"user"` | `"team"` | `null`) describing how the dependency is owned, and
each edge keeps a live status (`satisfied` / `missing` / `archived` / `visibility` / `cycle`); the
`visibility` status flags a Personal dependency that is not visible to everyone who can see the
dependent.

Archiving hides a skill from the normal lists but keeps it viewable, restorable, and downloadable
while a published version still references it. `POST /skills/{slug}/archive` accepts an optional
`{ "reason": "…" }`; `POST /skills/{slug}/restore` brings it back. Both require the same permission
as modifying the skill. Only archive a removed dependency after the user confirms, and never when
another published skill still requires it.

## Change owner

`PUT /skills/{slug}/owner` moves an existing skill between Personal and a team without uploading a new
version. Owner is the single access axis, so this changes who can read **and** edit the skill. JSON
body:

```json
{ "owner_team": "research" }
```

- `owner_team: "<team-slug>"` makes the skill **Team-owned** (readable by every workspace member,
  editable by that team's Admins/Editors plus org Owners/Admins).
- `owner_team: null` makes the skill **Personal** (private to the owning user; only they and org
  admins can read or edit it).

There is no `cascade` flag and no `teams` array. The response is `{ "ok": true }`.

The cover invariant (a skill is never more visible than what it depends on) is enforced here too. A
team-owned target covers any dependent; a Personal target only covers a dependent that is Personal
**and** owned by the same user. Moving a skill to a team makes it visible to everyone, so each of its
transitive dependencies must already cover that audience — if a dependency would end up less visible
(Personal under a now-team-owned skill), the change is rejected. Raise the dependency's owner first
(move it to a team). The whole change is rejected if the caller cannot modify the skill.

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

{ "version": "1.4.0", "agent": "Claude Code" }
```

`version` must be valid semver (use this skill's `metadata.companion_version`). The response is
`{ "ok": true, "status": "installed" | "update", "availableVersion": "1.4.0" }`.
