# Companion workspace API — quick reference

Base URL is `COMPANION_API_URL` (ends in `/v1`). Authenticate every request with
`Authorization: Bearer $COMPANION_TOKEN`. The token is scoped to `skills:read` + `skills:write`.

Resolve those values from the environment first. If either variable is missing, read the dedicated
local credentials file written by the Companion install/use prompt:

- macOS/Linux: `~/.companion/credentials.json`
- Windows: `$HOME\.companion\credentials.json`

The file contains `apiUrl`, `token`, and `updatedAt`. Use `apiUrl` as `COMPANION_API_URL` and `token`
as `COMPANION_TOKEN`. Never print the token back to the user.

These are the endpoints a personal access token (`skills:read` + `skills:write`) can call:

| Action | Method & path | Scope |
| --- | --- | --- |
| Current published version + checksum | `GET /skills/{slug}/download` | `skills:read` |
| Download a version package | `GET /skills/{slug}/versions/{version}/package` | `skills:read` |
| Browse a version's files | `GET /skills/{slug}/versions/{version}/files` | `skills:read` |
| Validate (no publish) | `POST /skills?action=validate` | `skills:write` |
| Publish a new skill | `POST /skills` | `skills:write` |
| Update a skill | `POST /skills?expect_slug={slug}&expect_skill_id={id}` | `skills:write` |
| Current bundled Companion skill status | `GET /local-skills/companion` | `skills:read` |
| Download bundled Companion skill package | `GET /local-skills/companion/package` | `skills:read` |
| Confirm this skill installed | `POST /local-skills/companion/installed` | `skills:write` |

Listing the whole workspace catalog (`GET /skills`) and enumerating versions are **session-only** in
the web app and reject tokens. To inventory what is installed on this machine, read the local skill
folders directly (each has a `SKILL.md` with `metadata.companion_skill_id` / `companion_version`).

The built-in Companion skill is different from user-published skills. For the skill shown in the
workspace's **Companion skills** section, use only the `/local-skills/companion` endpoints.

## Upload bodies

`POST /skills` accepts either:

- `multipart/form-data` with a `file` field (and `everyone` / `team` / `version` / `message` /
  `expect_slug` / `expect_skill_id` fields), or
- a raw `application/zip` or `application/gzip` body (the archive itself), with the same options as
  query params.

Set `action=validate` to run every package and identity check without publishing.

## Targeted updates

When updating a skill that already exists, send both `expect_slug` and `expect_skill_id`. The server
rejects the upload if the package's frontmatter `name` differs from `expect_slug`, or if its
`metadata.companion_skill_id` points at a different skill. This makes it impossible for an edit to
silently retarget another skill.

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

{ "version": "1.0.2", "agent": "Claude Code" }
```

`version` must be valid semver (use this skill's `metadata.companion_version`). The response is
`{ "ok": true, "status": "installed" | "update", "availableVersion": "1.0.2" }`.
