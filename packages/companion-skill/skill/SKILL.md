---
name: companion
description: "Use when managing local SKILL.md packages with Companion: validate, publish, update, resolve skill dependencies, declare the secrets and environment variables a skill needs, install updates, audit skills, check workspace versions, or self-update this Companion skill through the Companion workspace API."
license: MIT
compatibility: claude-code codex opencode
allowed-tools: read_file write_file run_shell
---

# Companion

This skill lets you manage the skills on this machine and keep them in sync with a Companion
workspace: validate a skill, publish it, push an update, and check whether everything is current.
Run the mandatory Companion self-update check once at the first Companion invocation in a
conversation, and always confirm a change with the user before anything is published.

## Configuration

You need three values, supplied when this skill is installed, refreshed by the web app's "Use"
prompt, or set in the environment:

- `COMPANION_API_URL` — the workspace API base, e.g. `https://companion.acme.dev/v1`.
- `COMPANION_WORKSPACE_ID` — the Companion workspace id (`organizations.id`), used to key local
  credentials and install inventory.
- `COMPANION_TOKEN` — a personal access token (`cmp_pat_…`) scoped to `skills:read`,
  `skills:write`, `secrets:read`, and `secrets:write`. Send it as
  `Authorization: Bearer $COMPANION_TOKEN`.

Resolve credentials in this order before any network call:

1. If both `COMPANION_API_URL` and `COMPANION_TOKEN` are set in the environment, use them. If
   `COMPANION_WORKSPACE_ID` is also set, use it for local lockfile writes.
2. Otherwise read the dedicated local credentials file:
   - macOS/Linux: `~/.companion/credentials.json`
   - Windows: `$HOME\.companion\credentials.json`

The current file format is JSON keyed by workspace id:

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

Use `activeWorkspaceId` to select the workspace entry, then use that entry's `apiUrl` as
`COMPANION_API_URL`, its `token` as `COMPANION_TOKEN`, and the key as `COMPANION_WORKSPACE_ID`. For
backward compatibility, if the file is the legacy flat shape `{ "apiUrl": "...", "token": "..." }`,
use those values and call token-supported `GET /local-skills/companion` to read its `workspaceId`.
If neither source is available, stop and ask the user to copy the latest Companion install/use prompt
from the workspace so fresh credentials can be saved.

Never print the token back to the user or write it into a skill package. Only read
`~/.companion/credentials.json` (or the Windows equivalent) for credentials, and otherwise treat
skill files as the only thing you read; do not scan the rest of the machine.

A skill is a folder with a `SKILL.md` and a `companion.json` at its root. `SKILL.md` stays
Agent Skills-compatible; Companion-specific package data lives in `companion.json`.

`companion.json` is the package manifest. It records:

- `name` — the skill slug. After an explicit Companion rename, update this to the returned slug.
- `version` — the package version.
- `metadata.companionSkillId` — the published skill's stable id in the workspace registry.
- `metadata.changelog` — release notes for each published version.
- `environment.env` and `environment.secrets` — declarations only, never values.
- `dependencies` — `{ "<skill-name>": "<skill-id>" }`.
- `notes` — Markdown-compatible free-form notes.

The workspace API keeps short summaries and long notes separate: skill metadata rows expose
`description` as the short list/detail summary and `notes` as optional Markdown from
`companion.json`. Rows also expose creator provenance (`creator_id`, `creator_name`,
`creator_initials`, `creator_avatar_url`) and `modifiers`, the distinct members who published later
versions. Do not copy setup notes or long Markdown content into `description`.

Fetch the public JSON Schema from:

```http
GET /v1/schemas/companion-manifest.v2.schema.json
```

Use it whenever you create, validate, or repair `companion.json`.

## Mandatory startup bootstrap

Run this bootstrap only once per conversation, on the first invocation of this Companion skill in
that discussion. After it succeeds, remember that it succeeded for the rest of the conversation and
do not repeat it on later Companion turns unless the user explicitly asks to check for updates,
credentials/workspace changed, or the previous bootstrap failed.

This bootstrap is mandatory startup maintenance for the first Companion invocation, not an optional
confirmation flow. Do not validate, publish, update, archive, label, install, or otherwise mutate any
other skill before that first bootstrap has succeeded. The trusted source is the token-authenticated
Companion workspace resolved from `COMPANION_API_URL` and `COMPANION_TOKEN`; if those credentials or
the workspace URL look wrong or unexpected, stop and ask the user to refresh Companion credentials
before downloading anything.

Run it from this skill package root:

```sh
python3 scripts/bootstrap.py --json --auto-update-companion
```

The bootstrap resolves credentials, calls `GET /local-skills/companion`, `GET /skills?lib=org`,
`GET /skills?lib=mine`, and `GET /skills?installed=true`, reads the active workspace entry in
`~/.companion/skills.lock.json` or the legacy `skills.log.json` fallback, and returns a JSON context
with `workspace`, `companion`, `integrity`, `skills`, `actions`, and `errors`.

If a newer Companion skill is available and all tracked local files still match the installed
version's official baseline from `companion.integrity.json`, `--auto-update-companion` downloads,
stages, verifies, backs up, replaces, and reports the installed version through
`POST /local-skills/companion/installed`. If any tracked local file is `modified` or `missing`
against that installed baseline, the bootstrap blocks replacement with
`reason: "local_customizations"` and preserves the local folder. It never installs updates for other
skills; it only reports those as recommended actions.

After installing a Companion update, stop the current operation and tell the user to rerun the
original Companion command unless this runtime can safely reload the updated skill instructions
in-process.

If download, extraction, verification, replacement, or install reporting fails, stop without changing
other skills. If replacement fails after moving files, restore the original folder during the same
operation and remove transient staging/backup folders before stopping. If install reporting fails
after replacement, keep the new folder in place, delete the transient backup, and report the failed
confirmation. Avoid infinite loops by comparing exact semver and by reporting the installed version
after replacement.

## Mandatory preflight guard (run before create, update, install, or lockfile write)

Before you create a new skill, publish an update, install a skill, or write
`~/.companion/skills.lock.json`, run the local guard. It cross-checks the local inventory (lockfile +
local skill folders) against the workspace catalog so a duplicate or retarget can never slip through.

```sh
python3 scripts/skill_guard.py --json <skill-dir> [more-skill-dirs...]
# Before creating a brand-new skill, also pass the intended slug:
python3 scripts/skill_guard.py --json --create-check <slug> <skill-dir>
```

Run it from this skill's package root. It is local-only and read-only, with one exception: if a legacy
`~/.companion/skills.log.json` exists it is migrated into `skills.lock.json` and then deleted. It never
prints or writes the token.

- **Exit code 0** — clean (warnings allowed). **Exit code 2** — a blocking conflict or a refused
  create; **stop** and surface the findings to the user. **Exit code 1** — could not run (credentials
  or API error).
- Blocking conflict kinds: `id_multiple_slugs` (one workspace skill id mapped to two slugs),
  `slug_multiple_ids`, `id_mismatch_online` (a local slug published online under a different id —
  a retarget), `duplicate_companion_id_manifests` (two local manifests share one `companionSkillId`
  under different slugs), and `lock_two_slugs_one_id` (repair the lockfile).
- Warning conflict kinds: `duplicate_local_skill_name` means the same `SKILL.md` `name` is visible
  from multiple local paths with the same `companionSkillId` or with missing ids. Surface the paths
  to the user so they can remove or archive stale local copies manually; do not delete anything
  automatically.
- A locally tracked skill that is gone or archived in the workspace is reported `missing_or_archived`,
  never `current` — never assume a close-named skill replaced it.
- `--create-check <slug>` searches the exact slug across org, My Skills, installed, the lockfile, the
  legacy log, and local folders. If it is found anywhere, do not create a second skill: update the
  existing one, restore it if it is archived, or pick a different slug.

Never infer that one skill replaces another because their names are similar. Identity is the workspace
skill id (`companion.json metadata.companionSkillId`), not the slug text. If the user wants to rename
an existing skill, use the explicit rename endpoint; do not publish the old `companionSkillId` under a
new package name.

## Companion manifest (analyze, then sync companion.json)

A skill may require other skills, setup variables, and product-facing display copy. Persist all
Companion-specific declarations in `companion.json` at the package root:

```json
{
  "$schema": "https://thecompanion.sh/schemas/companion-manifest.v2.schema.json",
  "name": "incident-summary",
  "version": "1.2.0",
  "title": "Incident summary",
  "description": "Generate clean incident handoffs from raw notes.",
  "notes": "## Notes\n\nMarkdown-compatible notes for humans and agents.",
  "metadata": {
    "companionSkillId": "84d8bee1-5ad3-4676-8c16-730e2a15ba70",
    "changelog": [
      {
        "version": "1.2.0",
        "date": "2026-06-24",
        "changes": ["Improve the handoff structure."]
      }
    ]
  },
  "environment": {
    "env": {
      "OPENAI_BASE_URL": {
        "required": false,
        "description": "Optional model gateway override."
      }
    },
    "secrets": {
      "OPENAI_API_KEY": {
        "slotId": "7fb1656b-240f-47c6-8728-6103b6f1044f",
        "required": true,
        "description": "Create this in your model gateway or ask an org admin."
      }
    }
  },
  "dependencies": {
    "markdown-report": "84d8bee1-5ad3-4676-8c16-730e2a15ba70"
  },
  "commands": [],
  "checks": {
    "updates": {
      "runtime": "python",
      "script": "scripts/bootstrap.py",
      "timeoutSeconds": 30
    }
  }
}
```

Dependencies are **un-versioned**: they map a readable skill name to that skill's stable workspace id.
Do not add version ranges. To know whether a dependency changed, compare the workspace registry
checksum/current version with the local `~/.companion/skills.lock.json` snapshot.

Do not put dependencies, required env vars, secrets, changelog, package version, Companion skill id,
or rich display copy in `SKILL.md` frontmatter. Keep them in `companion.json`.

Always **analyze the whole skill package before you validate, publish, or update**, even when
`companion.json` already exists. Treat `companion.json` as the persisted declaration to verify, not
as enough evidence by itself:

1. Read `companion.json` if present and collect declared dependencies, environment declarations,
   changelog, commands, local checks, notes, and display fields.
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
5. If the diff is non-empty, ask the user to confirm the final dependency list, resolve each
   dependency name to its workspace skill id, then create or update `companion.json` so it matches
   that confirmed map before validation/upload. If the user
   declines synchronizing `companion.json`, stop before upload; the server reads `companion.json`
   from the archive, so a stale file would override removals.

Package the skill only after `companion.json` matches the confirmed list. New clients do not need
extra upload parameters for dependencies; legacy `dependency=` query parameters are only a fallback
when a package has no `companion.json`. Dependency preflight follows the workspace access model:
org skills are visible to every member, while personal skills are visible only to their creator. The
server records the graph and blocks a publish whose dependencies are missing or cyclic.

## Capabilities

### Manage your skills

Work from the skill folders on this machine and the local lockfile:

- macOS/Linux: `~/.companion/skills.lock.json`
- Windows: `$HOME\.companion\skills.lock.json`

The canonical lockfile is keyed by workspace id, not by Companion URL. Each workspace record includes
`apiUrl` metadata plus installed skill paths, workspace ids, versions, checksums, declared
env/secrets, and dependency snapshots. It must never contain `COMPANION_TOKEN` or any other secret.
Prefer it for audits, then fall back to reading pointed-at skill folders. This inventory is local and
can be combined with the token-readable workspace catalog to explain what is published, what is
reported installed, and what is actually tracked on this machine.

If a legacy `~/.companion/skills.log.json` exists, it is migrated into `skills.lock.json` and then
deleted — the preflight guard does this automatically (lockfile entries win on conflict; secrets are
never copied). Write all future state to `skills.lock.json`. If the lockfile uses the old URL-keyed
`workspaces` shape, migrate entries to `workspaces[COMPANION_WORKSPACE_ID]` on the next write and keep
`apiUrl` as metadata under that workspace entry. A lockfile entry whose skill is archived or no longer
visible in the workspace is `missing_or_archived`, not "up to date" — keep it flagged, do not silently
treat a close-named skill as its replacement.

**A skill can be installed into several tools at once.** Each lockfile skill record carries a
`targets[]` array — one entry per install location, `{ tool, scope, path, checksum }`. A pre-multi-tool
record that only has a single `installPath` is read as one `claude-code`/`user` target. There are two
lockfile levels, same shape:

- **User-scope** installs (`~/.claude/skills`, `~/.codex/skills`, `~/.agents/skills` for OpenCode) live in `~/.companion/skills.lock.json`.
- **Project-scope** installs (`.claude/skills`, `.codex/skills`, `.agents/skills` for OpenCode inside a repo) live in a **per-project**
  `<repo>/.companion/skills.lock.json`, one per project, with repo-relative paths so it can optionally
  be committed to share the project's skill set. Never write the token to this lockfile either.

The set of tools this machine uses is recorded in `~/.companion/config.json`
(`{ "schemaVersion": 1, "tools": ["claude-code", "codex", "opencode"] }` — never any secret). The supported tools
and their on-disk skill directories are declared in this skill's `scripts/tools.json` registry, which
is extensible: adding a tool there is enough to make it an install target. The OpenCode target uses
the shared Agent Skills paths (`~/.agents/skills` and `.agents/skills`) so the same installed package
is discoverable by OpenCode's agent-compatible loader. `scripts/tools.schema.json`
is its JSON Schema (referenced via `$schema`) describing the registry shape.

### List workspace and local skills

Use the token-supported list endpoint to inspect the workspace catalog:

```sh
curl -s "$COMPANION_API_URL/skills?lib=org" -H "Authorization: Bearer $COMPANION_TOKEN"
curl -s "$COMPANION_API_URL/skills?lib=mine" -H "Authorization: Bearer $COMPANION_TOKEN"
curl -s "$COMPANION_API_URL/skills?installed=true" -H "Authorization: Bearer $COMPANION_TOKEN"
```

`lib=org` lists the org library. `lib=mine` lists the caller's My Skills: authored personal skills
plus org skills reported as installed. `installed=true` narrows any list to skills with a
`skill_installs` record for the current user, which means "reported installed to Companion"; it does
not prove the files still exist on disk. Skill rows include `share_token`; for live org skills only,
use it to build a clean public preview URL such as `/s/$share_token`.

### Free and Pro workspace gates

Self-hosted workspaces keep the full skills API. A managed SaaS workspace may enforce Free
entitlements. The billing overview is session-only and PATs must not call it, so detect a gate from
the skills API's structured HTTP 403 response and explain it instead of retrying:

```json
{
  "code": "upgrade_required",
  "feature": "personal_skills",
  "message": "Personal skills are available on Pro.",
  "effectivePlan": "free",
  "upgradeUrl": "/settings?view=billing"
}
```

The other codes are `org_skill_limit_reached` and `catalog_frozen`; quota responses can include
`limit` and `current`. On Free:

- `GET /skills?lib=mine` returns installed org skills only. Authored personal skills remain stored
  but hidden; personal folder routes and Share are locked.
- The org library includes up to 20 skills, counting active and archived rows. A new org publish can
  be refused at the limit. If a legacy catalog is already above 20, publish, rename, restore, and
  Share stay frozen; reading, installing, downloading, and archiving remain available.
- Only the current version is exposed. Requests for an older package, file list, or file preview
  return `upgrade_required` for `skill_history`.

Do not work around a gate by switching scope, renaming, restoring, or retrying another endpoint. Tell
the user what remains available and direct a signed-in Owner/Admin to `upgradeUrl`. Never request or
use Billing routes with `COMPANION_TOKEN`.

### Public org-skill preview links

Org skills have an anyone-with-the-link metadata preview. Personal skills do not; the user must first
preview the mandatory private dependency migration with `GET /skills/{slug}/share-plan`, then share a
personal skill to the org with `POST /skills/{slug}/share`. The share is atomic and includes owned
private dependencies automatically; the response includes `shared_dependencies`. The preview exposes
only display metadata and never exposes package content, files, downloads, requirements, secrets, labels, `id`,
`org_id`, or `creator_id`.

```http
GET /public/skills/{share_token}
```

The endpoint is public and does not use `COMPANION_TOKEN`. A 200 response contains
`display_name`, `slug`, `description`, `current_version`, `creator_name`, `creator_initials`,
`star_count`, and `updated_at`; personal, archived, or unknown tokens return 404. When helping a user
copy or share a skill link, prefer the web URL `/s/{share_token}` for org skills. The signed-in web app
uses a separate session-only resolver so it can switch to the token's workspace before opening the
slug-keyed detail route; agents normally do not need to call that resolver.

For real local inventory, read the active workspace entry in `~/.companion/skills.lock.json` and
fall back to `~/.companion/skills.log.json` only when the lockfile is absent. The bundled update
check does this for you:

```sh
python3 scripts/bootstrap.py --summary
```

Run that script from this skill's package root. It only reads local Companion state and calls the
skills API with `skills:read`; it does not write files, publish, install, or update anything.

### Install a skill into your tools (Claude Code, Codex, OpenCode, …)

Installing a skill deploys its package into **every tool the user works with**, not just the one in
use right now. Resolve the target tools, confirm with the user, then fan out:

1. **Resolve the tool set.** Read `~/.companion/config.json`. If it is missing or empty, auto-detect
   present tools (`python3 scripts/install_skill.py` reports what it found, or call
   `detect_tools` from `companion_lib`), **propose the detected set to the user for confirmation**
   (they can add or remove tools), then persist it to `config.json`. Reuse it on later installs.
2. **Ask the user where to install — always.** Before installing, ask whether they want it **global**
   (user-scope, available in every project) or **for this project only** (project-scope in the current
   repo), or both. Never silently pick a scope. Use a structured choice if the runtime offers one.
   `user` maps to global, `project` to the current repo; pass `--scope user|project|both` accordingly.
   There can be many projects on the machine, so project-scope installs are tracked per repo in
   `<repo>/.companion/skills.lock.json`. For a project-scope install, confirm the current repo is the
   intended one (project scope requires a repo root).
3. **Let the installer resolve dependencies and preflight everything.** `install_skill.py` resolves
   the requested version and its dependency closure, then calls the server secret preflight before
   any package download or local mutation. Required missing bindings block only this install;
   optional missing bindings are warnings. Show the metadata-only plan once, get one global user
   confirmation, then pass `--confirm-secrets`. Never ask the user to paste or reveal a value.
   The legacy `--confirm-required-secrets` flag is rejected and never authorizes plaintext retrieval;
   confirmation must be explicit with `--confirm-secrets`. Legacy flat credentials remain usable
   for package-only installs, but any secret-bearing install stops before grant creation and asks for
   a credential refresh so a stable workspace id is available for the projection path.

   ```sh
   python3 scripts/install_skill.py <slug> --scope user            # all configured tools, user-global
   python3 scripts/install_skill.py <slug> --scope both            # user-global + the current repo
   python3 scripts/install_skill.py <slug> --tools claude-code,codex,opencode --json
   python3 scripts/install_skill.py <slug> --confirm-secrets --report
   ```

   After confirmation it creates and immediately redeems a one-time grant, keeps values in memory,
   downloads and prepares the complete package set, then swaps each package with its `.env`
   projection. Projections live under `~/.companion/secrets/<workspace>/<skill>/.env` with private
   directory/file permissions, an exclusive lock, same-filesystem staging, and rollback markers.
   Every later secrets operation first recovers interrupted markers across the workspace and removes
   transient plaintext backups, including tombstone-only syncs.
   Lockfiles store only projection ids, slots, versions, keys, and paths, never values. A target whose
   folder was customized locally remains untouched unless `--force` is explicit.
4. **Report once.** After the dependency-first fan-out, send a single aggregate
   `POST /skills/{slug}/install` for the requested root skill with the
   installed version and an `agent` label listing the tools (for example `"Claude Code, Codex, OpenCode"`). The
   workspace tracks installs per user, not per tool, so this stays one call even across multiple tools
   and projects. (`install_skill.py --report` can send it for you.)

To **update** installed skills across tools, `python3 scripts/bootstrap.py --summary` lists every local
skill with its per-tool `targets`; re-run `install_skill.py <slug>` to bring the behind targets up to
the current published version, then re-report once.

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
- `blocked` — dependencies that are missing or cyclic (`A → B → A`). **Stop**: a publish with
  blockers is rejected with 422 and this same plan. Explain the blockers and help the user fix them
  before retrying.

Present the plan to the user as a short summary (local diff / confirmed dependencies / already
published / must upload too / removed / archival candidates / blocked) and get confirmation before
any upload.

### Declare required secrets and environment variables

Before you publish or update, work out what the skill needs to run and record it so the workspace can
show clear setup notes. Many skills need credentials or configuration — an API key, a service
endpoint, a token (for example, an image-generation skill needs an Azure OpenAI key). Capture these
under `environment.env` and `environment.secrets` in the skill's `companion.json`.

Analyze **only the skill's own files** (its `SKILL.md` body, scripts, `reference/`, examples, and any
config it ships) for references to credentials or environment variables. Look for:

- environment variable names, usually ALL_CAPS (e.g. `AZURE_OPENAI_API_KEY`, `OPENAI_BASE_URL`);
- code that reads them: `process.env.X`, `os.environ["X"]` / `getenv("X")`, `$VAR` / `${VAR}`;
- mentions of credential files or named services (Azure OpenAI, OpenAI, Anthropic, AWS, GitHub, …).

Never scan anything outside the skill folder, and never read, copy, or write an actual secret value —
you record **declarations and instructions only**, never the secret itself.

From what you find, draft an `environment` block:

- `environment.env` — non-sensitive configuration.
- `environment.secrets` — API keys, tokens, passwords, and other sensitive values.
- Each key has `required` and `description`.
- `description` is a short, human explanation of how to obtain it: who to ask in the organization, or a link
  to where it is created.

Show the proposed list to the user and let them edit, add, remove, or confirm it. Then write the
confirmed block into the skill's `companion.json` and **re-validate** before publishing:

```json
{
  "environment": {
    "env": {
      "OPENAI_BASE_URL": {
        "required": false,
        "description": "Optional override for the model gateway; defaults to the shared endpoint."
      }
    },
    "secrets": {
      "AZURE_OPENAI_API_KEY": {
        "slotId": "f52ad9f7-f4f0-4d98-8b13-a1ee4a93b021",
        "required": true,
        "description": "Azure OpenAI key. Ask your org admin to provision an Azure OpenAI resource."
      }
    }
  }
}
```

The workspace displays these as the skill's setup notes. When you install or update a skill that
declares environment entries, surface them to the user so they can set the secrets and environment
variables before running it. Declarations travel inside `companion.json` — there are no extra upload
parameters and never any secret values.

Every secret declaration has a stable `slotId`. Preserve it when renaming an environment key; omit it
only for a genuinely new slot. Historical packages without ids are normalized by the server using a
deterministic id derived from the workspace skill id and original key.

To create a vault entry, confirm its name, environment key, audience, and (for `restricted`) exact
recipients with the user, then run `python3 scripts/create_secret.py --name <name> --key <ENV_KEY>`.
Use `--audience personal|restricted|organization` and repeat `--recipient <user-id>` for restricted
access. Let the helper prompt privately for the value, or pipe exact stdin with `--value-stdin`;
never place the value in a command argument, chat response, log, manifest, or lockfile. The
`secrets:write` response is value-free. Rotation, deletion, ACL changes, bindings, and suggestions
still require the browser.

Before install/update/sync, call `POST /secret-retrievals/preflight` for the requested root skill and
version. The server resolves the exact dependency closure and returns metadata-only statuses. A
required missing binding blocks before any mutation; an optional missing binding is a warning. After
one global confirmation, create a 60-second grant and redeem it once. A rotation keeps the exact
version planned; an ACL/membership/revocation change invalidates the whole redemption and requires a
new preflight. Never print the grant or returned values.

Use `python3 scripts/sync_secrets.py sync <slug> --confirm` after rotations, binding changes, slot
renames/removals, or tombstones. `sync --all --confirm` continues across skipped/failed skills and
reports `updated / skipped / errors`. `sync --all --offline` preserves the last coherent local copy
and explicitly marks it potentially stale; offline mode cannot promise immediate revocation. For an
explicit retrieval outside a skill, use
`python3 scripts/sync_secrets.py manual <profile> <secret-id> <ENV_KEY> --confirm`; it writes under
`~/.companion/secrets/<workspace>/_manual/<profile>/.env`.

### Publish a skill

After a clean validation **and** a resolved dependency plan, publish a brand-new skill only after the
user has explicitly chosen where it will live. If the local analysis found dependencies that differ
from `companion.json`, create or update `companion.json` with the confirmed final list before
packaging; do not upload a package with a stale dependency manifest. If the plan listed dependencies
under `upload`, analyze and publish those first (topological order).

Before proposing or finalizing a slug, package name, or folder placement for a brand-new skill, read
the workspace's naming convention:

```http
GET /orgs/current/skill-naming-policy
```

This endpoint is token-readable with `skills:read` and returns `{ "policy": string | null }`. If
`policy` is a string, apply that convention when naming the skill and when filing it into folders.
If `policy` is `null`, do not impose a naming or filing convention of your own.

First confirm the slug is actually new: run `python3 scripts/skill_guard.py --json --create-check
<slug>` (or check that `GET /skills/{slug}/download` returns 404). If the slug already exists online or
locally, this is not a brand-new skill — update the existing one, restore it if it is archived, or pick
a different slug. Never publish a second skill over an existing slug.

A skill lives in one of two libraries (`scope`). An **org** skill is visible to every member of the
workspace, and any member can read, edit, archive, or delete it — organized with org-wide **labels**
(folders). A **personal** skill is private to its creator (the My Skills library), organized with that
person's own **personal folders**. `GET /skills/{slug}/share-plan` previews the owned private
dependencies that must move with a personal skill, and `POST /skills/{slug}/share` moves the root plus
those private dependencies into the org library atomically (owner-only, one-way).

Before any real `POST /skills` upload for a brand-new skill, ask the user these placement questions.
Use the runtime harness UI when it exists; if a structured user-input tool is available, use it
instead of a plain text question. Do not auto-resolve these decisions.

1. Ask which library to publish into:
   - **Personal / My Skills** — private to the user.
   - **Org / everyone** — visible to the whole workspace.
2. Fetch the matching folder tree:
   - Personal: `GET /personal-labels`.
   - Org: `GET /labels`.
3. Ask how to file the skill:
   - Use an existing folder/label.
   - Create/use a new folder/label.
   - No folder/label.
4. If the user chooses existing folders, present available paths when the harness supports choices;
   otherwise ask for exact paths. If the user chooses a new folder, ask for the desired path and
   validate it before upload.

A folder path is slash-separated, lower-case kebab segments:
`[a-z0-9]+(?:-[a-z0-9]+)*(\/[a-z0-9]+(?:-[a-z0-9]+)*)*`. It has no leading, trailing, or empty
segment. Label routes may also carry an optional human-facing `displayName` such as `Dev`; the path
remains the canonical identifier (`dev`). URL-encode slashes (`%2F`) when passing `label` as a query
parameter.

Make sure `companion.json.dependencies` contains the same confirmed dependencies you validated with
so the dependency graph is recorded. Always include `scope=personal` or `scope=org` explicitly for a
new skill; never rely on API defaults. Do not send legacy `owner_team`, `everyone`, `team`, `teams`,
`visibility`, or `private` parameters, and a skill must not declare `scope` or `visibility` in its
`SKILL.md` frontmatter.

For an org skill filed under folders at publish time, pass `scope=org` and repeat `label`:

```sh
curl -s "$COMPANION_API_URL/skills?scope=org&label=marketing&label=marketing%2Fseo" \
  -H "Authorization: Bearer $COMPANION_TOKEN" \
  -H "Content-Type: application/zip" \
  --data-binary @../skill.zip
```

For a personal skill, pass `scope=personal`. If the API supports personal folder assignment at
publish time, pass the confirmed paths as `label` values; otherwise publish first, then immediately
file the returned slug with `POST /skills/{slug}/personal-labels` using the already-confirmed path.

```sh
curl -s "$COMPANION_API_URL/skills?scope=personal" \
  -H "Authorization: Bearer $COMPANION_TOKEN" \
  -H "Content-Type: application/zip" \
  --data-binary @../skill.zip
```

To publish without filing it under any folder, still send the explicit scope and no `label`:

```sh
curl -s "$COMPANION_API_URL/skills?scope=personal" \
  -H "Authorization: Bearer $COMPANION_TOKEN" \
  -H "Content-Type: application/zip" \
  --data-binary @../skill.zip
```

The response contains the assigned `id`, `version`, and `checksum`. Write the returned id into
`companion.json.metadata.companionSkillId`, write the returned version into `companion.json.version`,
and add a matching `metadata.changelog` entry for that version so the folder stays linked to the
workspace skill.

After a successful publish from this Companion skill, treat the skill as installed for the current
user:

- If the published skill is an org skill, immediately call `POST /skills/{slug}/install` with
  `{ "version": "<published-version>", "source": "agent", "agent": "<agent-name>" }`.
- If the published skill is personal, do not call the install endpoint; personal skills already live
  in the author's My Skills library.
- Update `~/.companion/skills.lock.json` under `workspaces[COMPANION_WORKSPACE_ID]` with the
  workspace id, `apiUrl`, skill id, name, version, checksum, the install `targets[]` (one per
  tool/scope), declared env/secrets, resolved dependencies, and install time. Never write the token to
  this lockfile.
- If the install report fails after publish succeeds, keep the publish result, warn the user, and
  suggest retrying the install report. Do not republish just to repair install state.

### Update a skill

When the user changed a skill that already exists in the workspace, bind the upload to that exact
skill so an edit can never retarget another one. Always pass `expect_slug` and `expect_skill_id` (read
them from `companion.json.name` and `companion.json.metadata.companionSkillId`) — the server now
**requires** both on any update and rejects the upload otherwise. `companionSkillId` is the stable,
immutable identity: if it points at a different workspace skill than the slug you are updating, the
server refuses the publish (`refusing to retarget`). If `companion.json.metadata.companionSkillId`
contradicts the skill published under that slug, stop and tell the user this looks like a different
skill instead of forcing the update.

Do not ask Personal vs Org for updates, because a skill's scope is immutable on re-publish. A
re-publish never changes the skill's existing labels: it does not move, add, or remove folders. Ask
only whether the user wants to add folder labels after the update. If yes, publish the new version
first, then use the library already known from the current workflow: `/skills/{slug}/labels` for org
skills or `/skills/{slug}/personal-labels` for personal skills. If the library is not known from the
current context, do not guess or try both routes; publish the update without folder changes and ask
the user to run a separate organize/folder command from the skill's library context. To remove a
skill from a folder, use the same label routes rather than a re-publish, and only after explicit user
confirmation.

After a successful re-publish of an org skill, refresh the caller's install record with
`POST /skills/{slug}/install` and the published version, then refresh the local lockfile entry. A
personal skill still needs no install report.

After any successful publish or re-publish, include a skill link in the final chat response. Resolve
`webBase` by removing the trailing `/v1` from `COMPANION_API_URL`. For org skills, fetch
`GET /skills?lib=org`, find the row whose `slug` matches the published skill, and use its
`share_token` to build the public preview link: `Skill link: ${webBase}/s/{share_token}`. For
personal skills, explain that there is no public link until the owner shares it to the org, and use
the signed-in detail link instead: `Skill link: ${webBase}/skills?skill={slug}`. If a publish
succeeded but the org row or `share_token` cannot be retrieved, do not publish again; report the
successful publish and fall back to the signed-in detail link, using `lib=org` when you know the
skill is org-scoped.

```sh
curl -s "$COMPANION_API_URL/skills?expect_slug=$SLUG&expect_skill_id=$SKILL_ID" \
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

### Organize skills with labels

Labels (folders) organize skills inside a library; they do not change a skill's `scope` or access.
Org skills use the org-wide, **shared** label tree under `/labels`. Personal skills use the creator's
private folder tree under `/personal-labels`. A folder is a slash-separated, lower-case kebab path
such as `marketing/seo`, with an optional human-facing `displayName` such as `SEO`. A skill can hold
several labels at once, and folders may be empty.

The path is always sent in the **request body or query**, never as a URL path segment, so that the
slashes inside a path survive routing. Confirm any rename or delete with the user first, because both
cascade across descendant folders for the relevant library.

List the org folder tree (roll-up counts plus each path's display name, color, and icon):

```sh
curl -s "$COMPANION_API_URL/labels" -H "Authorization: Bearer $COMPANION_TOKEN"
```

List the caller's personal folder tree:

```sh
curl -s "$COMPANION_API_URL/personal-labels" -H "Authorization: Bearer $COMPANION_TOKEN"
```

The response is `{ "tree": [...], "flat": [...] }`: `tree` is the nested folder hierarchy with a
roll-up `count` per node (skills at that path or any descendant, de-duplicated), and `flat` is the
list of canonical `{ path, displayName, color, icon }` rows. `displayName` is nullable and falls back
to the path leaf when absent.

Create a folder (it may stay empty), optionally with a display name, color, and icon:

```sh
curl -s -X POST "$COMPANION_API_URL/labels" \
  -H "Authorization: Bearer $COMPANION_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"path":"marketing/seo","displayName":"SEO","color":null,"icon":null}'
```

File a skill into a folder (or remove it) without uploading a new version:

```sh
curl -s -X POST "$COMPANION_API_URL/skills/$SLUG/labels" \
  -H "Authorization: Bearer $COMPANION_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"path":"marketing/seo"}'

curl -s -X DELETE "$COMPANION_API_URL/skills/$SLUG/labels" \
  -H "Authorization: Bearer $COMPANION_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"path":"marketing/seo"}'
```

Rename, recolor, or set the icon of a folder (rename and delete cascade to every descendant; a rename
is rejected if it collides with an existing path):

```sh
curl -s -X PUT "$COMPANION_API_URL/labels/rename" \
  -H "Authorization: Bearer $COMPANION_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"from":"marketing","to":"growth","displayName":"Growth"}'

curl -s -X PUT "$COMPANION_API_URL/labels/color" \
  -H "Authorization: Bearer $COMPANION_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"path":"growth/seo","color":"oklch(0.72 0.18 145)"}'

curl -s -X PUT "$COMPANION_API_URL/labels/icon" \
  -H "Authorization: Bearer $COMPANION_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"path":"growth/seo","icon":"rocket"}'
```

Delete a folder (and every descendant) for the whole org:

```sh
curl -s -X DELETE "$COMPANION_API_URL/labels" \
  -H "Authorization: Bearer $COMPANION_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"path":"growth/seo"}'
```

### Rename a skill

When the user explicitly wants to change a skill's slug while keeping the same workspace skill id, use
the dedicated rename API. Do not upload a package with the old `companionSkillId` and a new
`companion.json.name`; the normal publish endpoint rejects that as a retarget.

```http
POST /skills/{oldSlug}/rename
Content-Type: application/json

{ "newSlug": "skill-creator-and-eval", "title": "Skill Creator and Eval" }
```

The response includes the unchanged `id`, `old_slug`, new `slug`, and nullable `title`. Versions,
labels, installs, stars, comments, share token, dependency links, checksums, and historical package
archives remain attached to the same skill id. Public `/s/{share_token}` links continue to work and
resolve to the new slug.

After success, update the local skill folder before any future publish: change `SKILL.md` frontmatter
`name` and `companion.json.name` to the returned `slug`, keep
`companion.json.metadata.companionSkillId` unchanged, and use the returned slug for future
`expect_slug` values.

Personal folder routes mirror the org routes under `/personal-labels` and
`/skills/$SLUG/personal-labels`; use them only for authored personal skills. Each label mutation
returns `{ "ok": true }`. Deleting a folder only unfiles its skills; it never deletes a skill.
Inspect a skill's dependency graph with `GET /skills/$SLUG/dependencies` if you are unsure what it
pulls in or what depends on it — dependencies are independent of labels. Dependency reads use the
stable target skill id when available, so a renamed dependency remains valid and appears under its
current slug. The response includes direct `requires[]`, deduplicated `transitive[]` dependencies with
`via` provenance, and per-dependency `install_status` so agents can spot dependencies that need an
update.

### Manage skill API calls

Use the workspace API only for skills-management tasks. Do not use this skill to manage workspace
members, invitations, org settings mutation, or tokens. The only org-settings read this skill uses is
`GET /orgs/current/skill-naming-policy`.

Allowed skills API tasks:

- List workspace skills with `GET /skills?lib=org`, `GET /skills?lib=mine`, and
  `GET /skills?installed=true` using a `skills:read` token. Use `installed=true` for Companion's
  reported install state; use the local lockfile for disk inventory.
- Read the workspace skill naming policy with `GET /orgs/current/skill-naming-policy` before naming
  or filing a brand-new skill.
- Read a public org-skill preview with `GET /public/skills/{share_token}` without a token when the
  user wants a share/unfurl link. Use only the `share_token` from an org skill row and prefer the web
  URL `/s/{share_token}` for sharing.
- Validate, publish, or update a skill with `POST /skills` after full local analysis and a synced
  `companion.json`. Use `dependency=` parameters only for old packages that have no manifest yet.
  For new skills, send explicit `scope=personal` or `scope=org` after the user chooses the library;
  repeat `label=<path>` only for confirmed new-skill folder placement. For existing skills, add or
  remove folders with the label routes after the update.
- Rename a skill with `POST /skills/$SLUG/rename` only after explicit user confirmation. After
  success, update local `SKILL.md` and `companion.json.name` to the returned slug while preserving
  `metadata.companionSkillId`.
- Inspect a skill's dependency graph with `GET /skills/$SLUG/dependencies`, including transitive
  dependencies and dependency update status.
- Archive or restore a skill with `POST /skills/$SLUG/archive` and `POST /skills/$SLUG/restore`
  (any member can do this).
- Read current published metadata with `GET /skills/$SLUG/download` (its `dependencies` array lists
  the current version's required slugs).
- Download packages with `GET /skills/$SLUG/versions/$VERSION/package`.
- Browse version files with `GET /skills/$SLUG/versions/$VERSION/files`.
- Preview one browser-native file with
  `GET /skills/$SLUG/versions/$VERSION/files/content?path=$PATH` when the file list marks it as
  text, image, or PDF. Unsupported files return 415; download the package to inspect them.
- Create a write-only secret with `secrets:write` through `scripts/create_secret.py`; the helper reads
  the value from a private prompt or exact stdin, never from an argument, and never prints it. It can
  create `personal`, `restricted`, or `organization` audiences after the user explicitly confirms
  the audience and recipients. Rotation, deletion, ACL changes, bindings, and suggestions remain
  browser-session-only.
- Read authorized secret metadata and skill configuration, then run preflight/grant/redemption with
  `secrets:read`. Use retrieval routes only through `install_skill.py` or `sync_secrets.py`; never log
  or persist the grant/redemption response.
- Organize skills with labels: list the org tree with `GET /labels` or the personal tree with
  `GET /personal-labels`; create, rename, recolor, set the icon, or delete folders with the matching
  label routes; file or unfile a skill with `POST` / `DELETE /skills/$SLUG/labels` for org skills or
  `POST` / `DELETE /skills/$SLUG/personal-labels` for personal skills. All work with a `skills:write`
  token and the path always travels in the body or query (see "Organize skills with labels").
- Read or write skill comments and stars only when the caller has a valid signed-in session for
  those routes. Do not assume a `cmp_pat_...` token can call session-only endpoints. A comment may
  carry up to six image attachments: add them by sending `POST /skills/$SLUG/comments` as
  `multipart/form-data` (a `body` field plus `image` files), and read a stored image from the
  `url` on each entry of the comment's `images` array.

For token-authenticated automation, prefer the documented read/write package endpoints in
`reference/api.md`.

### Check for updates

For a full audit, run the local-only manifest-declared update check from this skill package:

```sh
python3 scripts/check_updates.py
```

This Python script executes only on the user's machine. The Companion API validates and serves the
manifest declaration but never runs skill scripts in the control plane. The script resolves
credentials, calls `GET /skills?lib=mine`, `GET /skills?lib=org`, and `GET /skills?installed=true`,
then compares those workspace rows with the active workspace entry in
`~/.companion/skills.lock.json` (or the legacy `skills.log.json` fallback).
Use `python3 scripts/check_updates.py` only as a compatibility alias; it delegates to the same
bootstrap implementation.

For a targeted manual check of one installed skill, read its local `companion.json.version`, then ask
the workspace for the current published version of that slug:

```sh
curl -s "$COMPANION_API_URL/skills/$SLUG/download" -H "Authorization: Bearer $COMPANION_TOKEN"
```

The response includes the current `version` and `checksum`. If that `version` is greater than the
folder's `companion.json.version`, the folder is **out of date**. Present a short, plain list: up to date,
out of date, or not published yet (a `404` means the slug is not in this workspace).

### Install updates

For an out-of-date folder, re-run the same server preflight and atomic install workflow rather than
unzipping over the folder manually:

```sh
python3 scripts/install_skill.py "$SLUG" --version "$VERSION" --confirm-secrets --report
```

The installer prepares the complete package set before mutation and commits each package with its
projection. On a swap failure it restores both; after an interrupted process, the private transaction
marker restores the previous coherent pair on the next attempt.

### Update this Companion skill

This is the detailed replacement flow used by the mandatory startup bootstrap above. It applies only
to **the Companion skill itself**. This is the built-in local skill shown in the workspace's
**Companion skills** section, so never use the generic `/skills/$SLUG/download` or
`/skills/$SLUG/versions/$VERSION/package` endpoints for it.

Prefer the bootstrap command; it performs the integrity check and replacement flow:

```sh
python3 scripts/bootstrap.py --json --auto-update-companion
```

The bootstrap reads the local `companion.json.version`, compares it with `availableVersion` from
`GET /local-skills/companion`, compares tracked files against the installed
`companion.integrity.json` baseline, downloads `GET /local-skills/companion/package`, verifies
`SKILL.md`, the staged `companion.json.version`, and the staged integrity baseline, backs up the
current folder, replaces it, and reports the install with
`POST /local-skills/companion/installed`. Treat a JSON result with
`companion.autoUpdate.applied: true` as success. If the result has
`companion.autoUpdate.blocked: true` and `reason: "local_customizations"`, do not overwrite the local
folder; report the modified or missing files and ask the user whether to merge or reinstall the
official package manually.

Backups are transient implementation details. After replacement, delete the backup folder created for
that self-update whether or not the install report succeeds:

```sh
rm -rf "$backup"
echo "Deleted transient Companion self-update backup at $backup"
```

If install reporting fails after replacement, keep the newly installed folder in place, delete the
transient backup, and report that confirmation failed. Any older `companion.backup-*`,
`.companion-backup.*`, `*.companion-backup*`, or `*.backup-*` folder containing `SKILL.md` is stale
local state and should be deleted rather than kept as a rollback copy.

## Confirm installation (run once, at the end of install)

The last step of installing **this** skill is to tell the workspace it is present, so the Companion
skills view shows the correct status and version. Report the version from this skill's
`companion.json.version`:

```sh
curl -s "$COMPANION_API_URL/local-skills/companion/installed" \
  -H "Authorization: Bearer $COMPANION_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"version":"1.20.0","agent":"<your assistant name>"}'
```

A `{ "ok": true, "status": "installed" }` response confirms the workspace now knows this machine has
the Companion skill. Run this again after you install an update so the reported version stays
current.

See `reference/api.md` for the full endpoint list.
