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
| Upload owner/visibility choices | `GET /skills/upload-options` | `skills:write` |
| Current published version + checksum | `GET /skills/{slug}/download` | `skills:read` |
| Download a version package | `GET /skills/{slug}/versions/{version}/package` | `skills:read` |
| Browse a version's files | `GET /skills/{slug}/versions/{version}/files` | `skills:read` |
| Validate (no publish) + dependency preflight | `POST /skills?action=validate` | `skills:write` |
| Publish a new skill | `POST /skills` | `skills:write` |
| Update a skill | `POST /skills?expect_slug={slug}&expect_skill_id={id}` | `skills:write` |
| Inspect a skill's dependency graph | `GET /skills/{slug}/dependencies` | `skills:read` |
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
| Change visibility | `PUT /skills/{slug}/visibility` | Session |
| Read comments | `GET /skills/{slug}/comments` | Session |
| Add a comment | `POST /skills/{slug}/comments` | Session |
| Deprecate/restore a comment | `PATCH /skills/{slug}/comments/{id}` | Session |
| Toggle star | `POST /skills/{slug}/star` | Session |

Do not use this skill for workspace members, teams, invitations, org settings, or token management.
Those are outside the skills-only management surface.

Listing the whole workspace catalog (`GET /skills`) and enumerating versions are session-only in the
web app and reject tokens. To inventory what is installed on this machine, read the local skill
folders directly (each has a `SKILL.md` with `metadata.companion_skill_id` / `companion_version`).

The built-in Companion skill is different from user-published skills. For the skill shown in the
workspace's **Companion skills** section, use only the `/local-skills/companion` endpoints.

## Upload bodies and ownership

Before asking the user to choose ownership or visibility, fetch the available choices:

```http
GET /skills/upload-options
```

The response shape is:

```json
{
  "defaults": {
    "owner_team": null,
    "visibility": { "everyone": false, "teams": [] }
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

Present "Personal" plus `canOwn=true` teams as owner choices. Present "Private", "Everyone", and
optional team shares from `teams` as visibility choices. For a new publish, keep the response
defaults unless the user chooses otherwise.

`POST /skills` accepts either:

- `multipart/form-data` with a `file` field (and `owner_team` / `everyone` / `team` / `version` /
  `message` / `expect_slug` / `expect_skill_id` / `dependency` fields), or
- a raw `application/zip` or `application/gzip` body (the archive itself), with the same options as
  query params.

Declare required dependencies with repeated `dependency=<slug>` parameters (from `companion.json`).
Set `action=validate` to run every package and identity check without publishing; the validate
response is `{ "result": <validation>, "dependency_plan": <plan> }`.

Ownership and visibility are separate:

- `owner_team=<team-slug>` uploads the skill under that team. The actor must be an organization
  Owner/Admin, or an Admin/Editor of that team. Team Readers cannot upload or update for the team.
- Omit `owner_team` for personal ownership.
- Private visibility is `everyone=false` with no `team` values.
- Workspace-wide visibility is `everyone=true`.
- `team=<team-slug>` or repeated `team=` values grant read visibility only. Visibility team shares
  never grant edit rights.

Examples:

```http
POST /skills?owner_team=platform&everyone=false
Content-Type: application/zip
```

```http
POST /skills?owner_team=platform&everyone=true&team=research
Content-Type: application/zip
```

## Targeted updates

When updating a skill that already exists, send both `expect_slug` and `expect_skill_id`. The server
rejects the upload if the package's frontmatter `name` differs from `expect_slug`, or if its
`metadata.companion_skill_id` points at a different skill. This makes it impossible for an edit to
silently retarget another skill.

If you include `owner_team` on an update, it must match the skill's current owner team. Publishing a
new version cannot move a skill between personal and team ownership, or from one owner team to
another.

For updates, keep existing settings as the default. Read `GET /skills/{slug}/download`, use its
returned `visibility` as the default, and include that visibility in the upload query. Do not omit
`everyone`/`team` on updates: omitted visibility fields mean Private (`everyone=false`, no team
shares), not "preserve existing". Omit `owner_team` unless the user explicitly chooses a team owner
that already owns the skill.

## Dependencies & archive

Dependencies are un-versioned skill→skill links declared in a package's `companion.json`
(`{ "dependencies": ["slug-a", "slug-b"] }`). Pass each slug as a repeated `dependency=` parameter
on validate and publish.

`POST /skills?action=validate&dependency=...` returns a `dependency_plan`:

```json
{
  "declared": ["log-parser", "timeline-fmt"],
  "ready": ["log-parser"],
  "upload": [{ "slug": "timeline-fmt", "msg": "declared in the new SKILL.md, not in the registry" }],
  "removed": ["csv-export"],
  "archive_candidates": [{ "slug": "csv-export", "reason": "no published skill requires it anymore" }],
  "blocked": [{ "slug": "secret-helper", "status": "visibility", "msg": "secret-helper is less visible than incident-summary" }]
}
```

A publish whose dependencies are missing, cyclic, or less visible than the skill is rejected with
`422` and the same `dependency_plan` (look at `blocked`). Publish dependencies in `upload` first,
in topological order. `GET /skills/{slug}/dependencies?version=` returns the resolved Requires + Used
by graph with each edge's live status (`satisfied` / `missing` / `archived` / `visibility` /
`cycle`).

Archiving hides a skill from the normal lists but keeps it viewable, restorable, and downloadable
while a published version still references it. `POST /skills/{slug}/archive` accepts an optional
`{ "reason": "…" }`; `POST /skills/{slug}/restore` brings it back. Both require the same permission
as modifying the skill. Only archive a removed dependency after the user confirms, and never when
another published skill still requires it.

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

{ "version": "1.3.0", "agent": "Claude Code" }
```

`version` must be valid semver (use this skill's `metadata.companion_version`). The response is
`{ "ok": true, "status": "installed" | "update", "availableVersion": "1.3.0" }`.
