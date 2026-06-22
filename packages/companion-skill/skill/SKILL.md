---
name: companion
description: "Use when managing local SKILL.md packages with Companion: validate, publish, update, resolve skill dependencies, declare the secrets and environment variables a skill needs, install updates, audit skills, check workspace versions, or self-update this Companion skill through the Companion workspace API."
license: MIT
metadata:
  companion_version: 1.6.0
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

## Companion manifest (analyze, then sync companion.json)

A skill may require other skills, setup variables, and product-facing display copy. Persist those
Companion-specific declarations in an optional `companion.json` at the package root:

```json
{
  "display": {
    "name": "Incident summary",
    "summary": "Generate clean incident handoffs from raw notes.",
    "description": "Longer human-readable description shown in Companion."
  },
  "requirements": [
    {
      "key": "OPENAI_API_KEY",
      "type": "secret",
      "required": true,
      "note": "Create this in your model gateway or ask an org admin."
    }
  ],
  "dependencies": ["log-parser", "markdown-report"]
}
```

Dependencies are **un-versioned**: they are plain skill→skill links. Do not add version ranges, and
do not put dependencies, required env vars, secrets, or rich display copy in `SKILL.md` frontmatter
— keep them in `companion.json`. `SKILL.md.description` stays the standard Agent Skills fallback;
`display.summary` is the short Companion listing text, and `display.description` is the longer human
description shown in the workspace.

Always **analyze the whole skill package before you validate, publish, or update**, even when
`companion.json` already exists. Treat `companion.json` as the persisted declaration to verify, not
as enough evidence by itself:

1. Read `companion.json` if present and collect declared dependencies, requirements, and display
   fields.
2. Build a local skill index from sibling skill folders and any skill folders the user explicitly
   gave you. A skill folder is a directory with `SKILL.md`; use that file's frontmatter `name` as the
   slug. Do not scan the whole machine.
3. Scan every text file in the target skill package except `companion.json` (include `SKILL.md`,
   references, scripts, and docs; skip binaries and dependency/build directories) for exact
   references to indexed skill slugs or names. Exclude the target skill itself.
4. Compare declared vs inferred dependencies and present the diff:
   - matching — declared and found by analysis;
   - inferred only — found by analysis but missing from `companion.json`, with brief evidence such as
     the file path and referenced slug/name;
   - declared only — present in `companion.json` but not found by analysis.
5. If the diff is non-empty, ask the user to confirm the final dependency list, then create or
   update `companion.json` so it matches that confirmed list before validation/upload. If the user
   declines synchronizing `companion.json`, stop before upload; the server reads `companion.json`
   from the archive, so a stale file would override removals.

Package the skill only after `companion.json` matches the confirmed list. New clients do not need
extra upload parameters for dependencies; legacy `dependency=` query parameters are only a fallback
when a package has no `companion.json`. The server records the graph and blocks a publish whose
dependencies are missing, cyclic, or less visible than the skill itself.

## Capabilities

### Manage your skills

Work from the skill folders on this machine: each is a directory with a `SKILL.md` at its root. List
those folders and read each one's frontmatter `metadata` (`companion_skill_id`, `companion_version`)
to know which workspace skill it maps to and which version it is at. This inventory is local and
needs no network call — your token is for publishing and version checks, not for browsing the whole
workspace catalog (that listing is session-only in the web app).

### Validate a skill

Always validate before you publish. First run the full manifest analysis above, compare it with
`companion.json`, and get confirmation for the final dependency list and any setup requirements if
there is a mismatch. The server runs the same package checks without writing anything, and also
returns the dependency preflight:

```sh
cd <skill-folder> && zip -r -q ../skill.zip . \
  && curl -s "$COMPANION_API_URL/skills?action=validate" \
       -H "Authorization: Bearer $COMPANION_TOKEN" \
       -H "Content-Type: application/zip" \
       --data-binary @../skill.zip
```

The response is `{ "result": <validation>, "dependency_plan": <plan> }`. Report the local dependency
analysis summary, the validation checklist, and the server dependency plan back to the user. If any
check fails, fix it and re-validate; do not publish. Then analyze `dependency_plan` before
publishing — see the next section.

### Resolve dependencies before publishing

The local dependency analysis chooses the final list of slugs to write in `companion.json`. The
`dependency_plan` from validate then tells you exactly what will change in the workspace dependency
graph:

- `ready` — declared dependencies already published in the workspace. Nothing to do.
- `upload` — declared but **not** in the registry. The new version stays unresolved until each is
  published. For each, look for a local skill folder whose `SKILL.md` `name` matches the slug,
  run the same full dependency analysis for that dependency, validate it, and (after the user
  confirms) publish it **first**. Publish in topological order: dependencies before the skills that
  require them.
- `removed` — required by the previous version and dropped from this one (update only).
- `archive_candidates` — removed dependencies that no published skill references anymore. After the
  main publish, offer to archive each one (`POST /skills/$SLUG/archive`); never archive automatically.
- `blocked` — dependencies that are missing, cyclic (`A → B → A`), or less visible than the skill
  (e.g. an Everyone skill that requires a Private one). **Stop**: a publish with blockers is rejected
  with 422 and this same plan. Explain the blockers and help the user fix them before retrying.

Present the plan to the user as a short summary (local diff / confirmed dependencies / already
published / must upload too / removed / archival candidates / blocked) and get confirmation before
any upload.

### Declare required secrets and environment variables

Before you publish or update, work out what the skill needs to run and record it so the workspace can
show clear setup notes. Many skills need credentials or configuration — an API key, a service
endpoint, a token (for example, an image-generation skill needs an Azure OpenAI key). Capture these
as a `requirements` list in the skill's `companion.json`.

Analyze **only the skill's own files** (its `SKILL.md` body, scripts, `reference/`, examples, and any
config it ships) for references to credentials or environment variables. Look for:

- environment variable names, usually ALL_CAPS (e.g. `AZURE_OPENAI_API_KEY`, `OPENAI_BASE_URL`);
- code that reads them: `process.env.X`, `os.environ["X"]` / `getenv("X")`, `$VAR` / `${VAR}`;
- mentions of credential files or named services (Azure OpenAI, OpenAI, Anthropic, AWS, GitHub, …).

Never scan anything outside the skill folder, and never read, copy, or write an actual secret value —
you record **declarations and instructions only**, never the secret itself.

From what you find, draft a `requirements` list. Each entry is:

- `key` — the environment variable / secret name (e.g. `AZURE_OPENAI_API_KEY`).
- `type` — `secret` for sensitive credentials (API keys, tokens) or `env` for plain configuration.
- `required` — `true` if the skill cannot run without it, `false` if it is optional.
- `note` — a short, human explanation of how to obtain it: who to ask in the organization, or a link
  to where it is created.

Show the proposed list to the user and let them edit, add, remove, or confirm it. Then write the
confirmed block into the skill's `companion.json` and **re-validate** before publishing:

```json
{
  "requirements": [
    {
      "key": "AZURE_OPENAI_API_KEY",
      "type": "secret",
      "required": true,
      "note": "Azure OpenAI key. Ask your org admin to provision an Azure OpenAI resource, or create one at https://portal.azure.com."
    },
    {
      "key": "OPENAI_BASE_URL",
      "type": "env",
      "required": false,
      "note": "Optional override for the model gateway; defaults to the shared endpoint."
    }
  ]
}
```

The workspace displays these as the skill's setup notes. When you install a skill that declares
requirements, surface them to the user so they can set the secrets and environment variables before
running it. Requirements travel inside `companion.json` — there are no extra upload parameters.

### Publish a skill

After a clean validation **and** a resolved dependency plan, and after the user confirms, publish a
brand-new skill. If the local analysis found dependencies that differ from `companion.json`, create
or update `companion.json` with the confirmed final list before packaging; do not upload a package
with a stale dependency manifest. If the plan listed dependencies under `upload`, analyze and
publish those first (topological order). Ask the user where the skill should be owned and who should
be able to read it before you upload. Do not ask for a raw team slug first: fetch upload options and
propose the available choices.

```sh
curl -s "$COMPANION_API_URL/skills/upload-options" \
  -H "Authorization: Bearer $COMPANION_TOKEN"
```

The response contains `defaults` and `teams`. Present:

- Owner choices: "Personal" plus teams where `canOwn=true`.
- Visibility choices: "Private", "Everyone", and optional team shares from `teams`.

Keep the current defaults unless the user chooses otherwise. For a brand-new publish, default to the
response defaults: personal owner (`owner_team` omitted) and Private (`everyone=false`, no `team`).

Ownership is separate from visibility:

- `owner_team=<team-slug>` uploads the skill under that team. A user can do this only when they are
  an organization Owner/Admin, or an Admin/Editor of that team. Team Readers cannot upload or update
  skills for that team.
- Omit `owner_team` to keep the skill personally owned by the user.
- `everyone=false` with no `team` values means Private.
- `everyone=true` means every member of the current workspace can read the skill.
- `team=<team-slug>` shares read visibility with a team. Team visibility does **not** grant edit
  rights; only direct ownership, owner-team Admin/Editor, or org Owner/Admin can modify a skill.

Make sure `companion.json.dependencies` contains the same confirmed dependencies you validated with
so the dependency graph is recorded:

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
from the folder's `metadata`). Keep existing settings as the default: first read the current
published settings, present them to the user, and only change them when the user explicitly asks.

```sh
curl -s "$COMPANION_API_URL/skills/$SLUG/download" \
  -H "Authorization: Bearer $COMPANION_TOKEN"
```

Use the returned `visibility` as the default visibility and include it in the upload query. Do not
omit `everyone`/`team` on updates: omitted visibility fields mean Private (`everyone=false`, no
team shares), not "preserve existing". Omit `owner_team` by default so the current owner stays
unchanged. If you pass `owner_team`, it must be the skill's current owner team, or the server
rejects the upload.

```sh
curl -s "$COMPANION_API_URL/skills?expect_slug=$SLUG&expect_skill_id=$SKILL_ID&owner_team=platform&everyone=true&team=research" \
  -H "Authorization: Bearer $COMPANION_TOKEN" \
  -H "Content-Type: application/zip" \
  --data-binary @../skill.zip
```

Run the full dependency analysis on updates too. Write the confirmed final list to
`companion.json.dependencies`; omitting a dependency drops it from the new version. Re-run validate
first to get a fresh `dependency_plan`: its `removed` list shows
dependencies dropped since the previous version, and `archive_candidates` shows removed dependencies
no longer referenced by any published skill. After the update publishes, offer to archive each
candidate (`POST /skills/$SLUG/archive`) — only with the user's confirmation, and never if another
skill still requires it. The server assigns the next version unless you pass an explicit `version=`.
Summarize what changed and confirm before sending.

### Change a skill's visibility

Use this to re-share an already-published skill without uploading a new version. It changes who can
read the skill, never its ownership or contents.

```sh
curl -s -X PUT "$COMPANION_API_URL/skills/$SLUG/visibility" \
  -H "Authorization: Bearer $COMPANION_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"everyone":true,"teams":[],"cascade":false}'
```

The JSON body is the target visibility plus a cascade flag:

- `everyone` — `true` makes every workspace member able to read the skill.
- `teams` — array of team **slugs** to share read access with (combine with `everyone` or use alone).
  Omitting both `everyone` and `teams` makes the skill Private. As with updates, omitted fields are
  not "preserve existing": send the full target visibility every time.
- `cascade` — see below; defaults to `false`.

A skill must never be more visible than the skills it depends on, or someone could install it but not
its sub-skills. So:

- **Broadening** a skill (e.g. team → Everyone) while it requires a less-visible dependency is
  **rejected** unless you pass `"cascade": true`. With `cascade`, the server also raises every
  (transitive) dependency to at least the skill's new audience, in one atomic change.
- **Narrowing** a skill (e.g. Everyone → team, or team → Private) that a more-visible skill depends
  on is **rejected** unless you pass `"cascade": true`. With `cascade`, the server reduces every
  (transitive) dependent to fit the skill's new audience. A dependent owned by a team that would
  still see it cannot be reduced, so that narrow is rejected even with `cascade`.

Either way the response lists what it changed: `{ "ok": true, "cascaded": ["log-parser"] }`, and the
cascade is rejected as a whole if the caller lacks permission to change any affected skill.

Always confirm the change with the user before sending, and tell them which other skills the cascade
will make more (or less) visible. Inspect the graph first with `GET /skills/$SLUG/dependencies` if you
are unsure what the skill pulls in or what depends on it.

### Manage skill API calls

Use the workspace API only for skills-management tasks. Do not use this skill to manage workspace
members, teams, invitations, org settings, or tokens.

Allowed skills API tasks:

- Fetch upload owner/visibility choices with `GET /skills/upload-options` using a `skills:write`
  token.
- Validate, publish, or update a skill with `POST /skills` after full local analysis and a synced
  `companion.json`. Use `dependency=` parameters only for old packages that have no manifest yet.
- Inspect a skill's dependency graph with `GET /skills/$SLUG/dependencies`.
- Archive or restore a skill with `POST /skills/$SLUG/archive` and `POST /skills/$SLUG/restore`
  (same permissions as modifying the skill).
- Read current published metadata with `GET /skills/$SLUG/download` (its `dependencies` array lists
  the current version's required slugs).
- Download packages with `GET /skills/$SLUG/versions/$VERSION/package`.
- Browse version files with `GET /skills/$SLUG/versions/$VERSION/files`.
- Change a skill's visibility with `PUT /skills/$SLUG/visibility` (see "Change a skill's
  visibility"). Works with a `skills:write` token.
- Read or write skill comments and stars only when the caller has a valid signed-in session for
  those routes. Do not assume a `cmp_pat_...` token can call session-only endpoints. A comment may
  carry up to six image attachments: add them by sending `POST /skills/$SLUG/comments` as
  `multipart/form-data` (a `body` field plus `image` files), and read a stored image from the
  `url` on each entry of the comment's `images` array.

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
  -d '{"version":"1.4.0","agent":"<your assistant name>"}'
```

A `{ "ok": true, "status": "installed" }` response confirms the workspace now knows this machine has
the Companion skill. Run this again after you install an update so the reported version stays
current.

See `reference/api.md` for the full endpoint list.
