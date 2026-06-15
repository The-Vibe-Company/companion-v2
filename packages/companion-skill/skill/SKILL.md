---
name: companion
description: "Use when managing local SKILL.md packages with Companion: validate, publish, update, install updates, audit skills, check workspace versions, or self-update this Companion skill through the Companion workspace API."
license: MIT
metadata:
  companion_version: 1.1.0
allowed-tools: read_file write_file run_shell
---

# Companion

This skill lets you manage the skills on this machine and keep them in sync with a Companion
workspace: validate a skill, publish it, push an update, and check whether everything is current.
You always confirm a change with the user before anything is published.

## Configuration

You need two values, supplied when this skill is installed, refreshed by the web app's "Use" prompt,
or set in the environment:

- `COMPANION_API_URL` — the workspace API base, e.g. `https://companion.acme.dev/v1`.
- `COMPANION_TOKEN` — a personal access token (`cmp_pat_…`) scoped to `skills:read` and
  `skills:write`. Send it as `Authorization: Bearer $COMPANION_TOKEN`.

Resolve credentials in this order before any network call:

1. If both `COMPANION_API_URL` and `COMPANION_TOKEN` are set in the environment, use them.
2. Otherwise read the dedicated local credentials file:
   - macOS/Linux: `~/.companion/credentials.json`
   - Windows: `$HOME\.companion\credentials.json`

The file is JSON:

```json
{
  "apiUrl": "https://companion.acme.dev/v1",
  "token": "cmp_pat_...",
  "updatedAt": "2026-06-15T12:00:00.000Z"
}
```

Use `apiUrl` as `COMPANION_API_URL` and `token` as `COMPANION_TOKEN`. If neither source is available,
stop and ask the user to copy the latest Companion install/use prompt from the workspace so fresh
credentials can be saved.

Never print the token back to the user or write it into a skill package. Only read
`~/.companion/credentials.json` (or the Windows equivalent) for credentials, and otherwise treat
skill files as the only thing you read; do not scan the rest of the machine.

A skill is a folder with a `SKILL.md` at its root. Companion records two values under
`metadata` in that file:

- `companion_skill_id` — the workspace id of the published skill (added on first publish).
- `companion_version` — the version this folder corresponds to.

These let you tell, offline, which workspace skill a folder maps to and whether it is behind.

## Capabilities

### Manage your skills

Work from the skill folders on this machine: each is a directory with a `SKILL.md` at its root. List
those folders and read each one's frontmatter `metadata` (`companion_skill_id`, `companion_version`)
to know which workspace skill it maps to and which version it is at. This inventory is local and
needs no network call — your token is for publishing and version checks, not for browsing the whole
workspace catalog (that listing is session-only in the web app).

### Validate a skill

Always validate before you publish. The server runs the same checks without writing anything:

```sh
cd <skill-folder> && zip -r -q ../skill.zip . \
  && curl -s "$COMPANION_API_URL/skills?action=validate" \
       -H "Authorization: Bearer $COMPANION_TOKEN" \
       -H "Content-Type: application/zip" \
       --data-binary @../skill.zip
```

Report the checklist back to the user. If any check fails, fix it and re-validate; do not publish.

### Publish a skill

After a clean validation, and after the user confirms, publish a brand-new skill. Ask the user where
the skill should be owned and who should be able to read it before you upload.

Ownership is separate from visibility:

- `owner_team=<team-slug>` uploads the skill under that team. A user can do this only when they are
  an organization Owner/Admin, or an Admin/Editor of that team. Team Readers cannot upload or update
  skills for that team.
- Omit `owner_team` to keep the skill personally owned by the user.
- `everyone=false` with no `team` values means Private.
- `everyone=true` means every member of the current workspace can read the skill.
- `team=<team-slug>` shares read visibility with a team. Team visibility does **not** grant edit
  rights; only direct ownership, owner-team Admin/Editor, or org Owner/Admin can modify a skill.

```sh
curl -s "$COMPANION_API_URL/skills?owner_team=platform&everyone=false" \
  -H "Authorization: Bearer $COMPANION_TOKEN" \
  -H "Content-Type: application/zip" \
  --data-binary @../skill.zip
```

For a workspace-wide skill owned by a team, use `everyone=true`:

```sh
curl -s "$COMPANION_API_URL/skills?owner_team=platform&everyone=true" \
  -H "Authorization: Bearer $COMPANION_TOKEN" \
  -H "Content-Type: application/zip" \
  --data-binary @../skill.zip
```

For private personal ownership, omit `owner_team`, set `everyone=false`, and do not send `team`.
The response contains the assigned `id`, `version`, and `checksum`. Write the returned
`companion_skill_id` and `companion_version` back into the folder's `SKILL.md` `metadata` so the
folder stays linked to the workspace skill.

### Update a skill

When the user changed a skill that already exists in the workspace, bind the upload to that exact
skill so an edit can never retarget another one. Pass `expect_slug` and `expect_skill_id` (read them
from the folder's `metadata`). Keep the existing owner stable: if you pass `owner_team`, it must be
the skill's current owner team, or the server rejects the upload. Use `everyone` and optional `team`
values to change visibility on the new version.

```sh
curl -s "$COMPANION_API_URL/skills?expect_slug=$SLUG&expect_skill_id=$SKILL_ID&owner_team=platform&everyone=true&team=research" \
  -H "Authorization: Bearer $COMPANION_TOKEN" \
  -H "Content-Type: application/zip" \
  --data-binary @../skill.zip
```

The server assigns the next version unless you pass an explicit `version=`. Summarize what changed
and confirm before sending.

### Manage skill API calls

Use the workspace API only for skills-management tasks. Do not use this skill to manage workspace
members, teams, invitations, org settings, or tokens.

Allowed skills API tasks:

- Validate, publish, or update a skill with `POST /skills`.
- Read current published metadata with `GET /skills/$SLUG/download`.
- Download packages with `GET /skills/$SLUG/versions/$VERSION/package`.
- Browse version files with `GET /skills/$SLUG/versions/$VERSION/files`.
- Change visibility with `PUT /skills/$SLUG/visibility` only when authenticated as a signed-in
  session that can call that endpoint; personal access tokens may be rejected.
- Read or write skill comments and stars only when the caller has a valid signed-in session for
  those routes. Do not assume a `cmp_pat_...` token can call session-only endpoints.

For token-authenticated automation, prefer the documented read/write package endpoints in
`reference/api.md`.

### Check for updates

For each skill folder that has a `metadata.companion_skill_id`, read its `metadata.companion_version`,
then ask the workspace for the current published version of that slug:

```sh
curl -s "$COMPANION_API_URL/skills/$SLUG/download" -H "Authorization: Bearer $COMPANION_TOKEN"
```

The response includes the current `version` and `checksum`. If that `version` is greater than the
folder's `companion_version`, the folder is **out of date**. Present a short, plain list: up to date,
out of date, or not published yet (a `404` means the slug is not in this workspace).

### Install updates

For an out-of-date folder, take the current `version` from the `download` response above, fetch that
version's package, and replace the files in place (after the user confirms):

```sh
curl -sL "$COMPANION_API_URL/skills/$SLUG/versions/$VERSION/package" \
  -H "Authorization: Bearer $COMPANION_TOKEN" -o update.zip
```

Unzip it over the folder, then confirm `SKILL.md` sits at the package root and its
`metadata.companion_version` matches the version you fetched. (Companion's `checksum` is a hash of
the canonical tar, not of this repackaged zip, so use it as a version identity reference, not a
byte hash of `update.zip`.)

### Update this Companion skill

Use this flow when the user asks to update **the Companion skill itself**. This is the built-in
local skill shown in the workspace's **Companion skills** section, so never use the generic
`/skills/$SLUG/download` or `/skills/$SLUG/versions/$VERSION/package` endpoints for it.

1. Resolve credentials as described above, without printing the token.
2. Read this skill's local `metadata.companion_version` from its own `SKILL.md`.
3. Ask the workspace for the current bundled Companion skill:

```sh
curl -s "$COMPANION_API_URL/local-skills/companion" \
  -H "Authorization: Bearer $COMPANION_TOKEN"
```

The response includes `status`, `installedVersion`, `availableVersion`, and `changes`. If
`availableVersion` is equal to the local `metadata.companion_version`, report that this skill is
already current and stop. If `availableVersion` is greater, summarize `changes` and confirm with the
user before replacing local files.

After confirmation, download and stage the latest package in a temporary directory before touching
the installed skill folder:

```sh
tmp="$(mktemp -d)"
curl -fsSL "$COMPANION_API_URL/local-skills/companion/package" \
  -H "Authorization: Bearer $COMPANION_TOKEN" \
  -o "$tmp/companion.zip"
unzip -q "$tmp/companion.zip" -d "$tmp/package"
test -f "$tmp/package/SKILL.md"
```

Read `metadata.companion_version` from `$tmp/package/SKILL.md` and verify it equals the
`availableVersion` returned by `/local-skills/companion`. If it does not match, delete the temporary
directory and stop without changing the installed folder.

If validation passes, replace the existing Companion skill folder with a staged copy. Validate the
target before moving anything: `skill_dir` must be an absolute path, its basename must be
`companion`, and the existing `$skill_dir/SKILL.md` must declare `name: companion`.

```sh
skill_dir="<path-to-installed-companion-skill>"
case "$skill_dir" in
  /*) ;;
  *) echo "skill_dir must be absolute" >&2; exit 1 ;;
esac
test "$(basename "$skill_dir")" = "companion"
test -f "$skill_dir/SKILL.md"
grep -q '^name: companion$' "$skill_dir/SKILL.md"

parent="$(dirname "$skill_dir")"
staged="$(mktemp -d "$parent/.companion-update.XXXXXX")"
cp -R "$tmp/package/." "$staged/"
test -f "$staged/SKILL.md"
grep -q '^name: companion$' "$staged/SKILL.md"

backup="$(mktemp -d "$parent/.companion-backup.XXXXXX")"
rmdir "$backup"
mv "$skill_dir" "$backup"
mv "$staged" "$skill_dir"
echo "Previous Companion skill saved at $backup"
```

Then report the installed version back to the workspace:

```sh
curl -s "$COMPANION_API_URL/local-skills/companion/installed" \
  -H "Authorization: Bearer $COMPANION_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"version":"<availableVersion>","agent":"<your assistant name>"}'
```

Treat `{ "ok": true, "status": "installed" }` as success. If the response says `status: "update"`,
tell the user the workspace still has a newer bundled version available.

## Confirm installation (run once, at the end of install)

The last step of installing **this** skill is to tell the workspace it is present, so the Companion
skills view shows the correct status and version. Report the version from this file's
`metadata.companion_version`:

```sh
curl -s "$COMPANION_API_URL/local-skills/companion/installed" \
  -H "Authorization: Bearer $COMPANION_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"version":"1.1.0","agent":"<your assistant name>"}'
```

A `{ "ok": true, "status": "installed" }` response confirms the workspace now knows this machine has
the Companion skill. Run this again after you install an update so the reported version stays
current.

See `reference/api.md` for the full endpoint list.
