#!/usr/bin/env python3
"""Anti-duplication / anti-retargeting preflight guard for Companion skills.

Run this BEFORE creating, updating, installing, or writing the lockfile for a
skill. It builds a local inventory from ~/.companion/skills.lock.json (auto-
migrating the legacy skills.log.json), compares it against the workspace
catalogue, and reports duplication / retargeting conflicts.

It is read-only except for the automatic legacy-log migration, and it NEVER
prints or persists the Companion token. Exit code 0 = clean (warnings allowed),
2 = a blocking conflict or a refused create, 1 = operational error.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from companion_lib import (  # noqa: E402  (path shim must run before the import)
    api_get,
    companion_home,
    compare_semver,
    fail,
    legacy_log_path,
    load_json,
    load_project_inventory,
    lockfile_path,
    print_rows,
    resolve_credentials,
    skill_records_from_lock,
    status_for_local_guarded,
    workspace_lock_entry,
)

# Conflict kinds (stable strings consumed by tests and the agent).
KIND_ID_MULTIPLE_SLUGS = "id_multiple_slugs"
KIND_SLUG_MULTIPLE_IDS = "slug_multiple_ids"
KIND_ID_MISMATCH_ONLINE = "id_mismatch_online"
KIND_DUP_COMPANION_ID = "duplicate_companion_id_manifests"
KIND_LOCK_TWO_SLUGS = "lock_two_slugs_one_id"
KIND_MISSING_OR_ARCHIVED = "missing_or_archived"

# Directories that never contain a sibling skill worth scanning.
SKIP_DIRS = {
    "node_modules", ".git", ".hg", ".svn", "dist", "build", ".next", "out",
    "__pycache__", ".venv", "venv", ".turbo", "coverage", ".cache",
}

# The only fields copied out of the legacy log during migration. Anything else
# (notably a stray token) is dropped on the floor.
MIGRATION_FIELD_ALLOWLIST = {
    "name", "slug", "version", "resolved", "checksum", "path", "installPath",
    "skillId", "workspaceSkillId", "companionSkillId", "env", "secrets",
    "dependencies", "frontmatter", "installedAt", "updatedAt", "addedAt", "source",
}


# --------------------------------------------------------------------------- #
# Online catalogue
# --------------------------------------------------------------------------- #

def _row_id(row: dict[str, Any]) -> str | None:
    if not isinstance(row, dict):
        return None
    metadata = row.get("metadata")
    meta_id = metadata.get("companionSkillId") if isinstance(metadata, dict) else None
    return row.get("id") or meta_id


def build_online_index(api_url: str, token: str) -> dict[str, Any]:
    """Union org + mine + installed (live) and the archived views into lookup indexes."""
    live_lists = [
        api_get(api_url, token, "/skills?lib=org"),
        api_get(api_url, token, "/skills?lib=mine"),
        api_get(api_url, token, "/skills?installed=true"),
    ]
    archived_lists = [
        api_get(api_url, token, "/skills?lib=org&archived=true"),
        api_get(api_url, token, "/skills?lib=mine&archived=true"),
    ]
    if not all(isinstance(value, list) for value in (*live_lists, *archived_lists)):
        fail("skills listing endpoints returned an unexpected response shape")

    live_rows = [row for lst in live_lists for row in lst if isinstance(row, dict) and row.get("slug")]
    archived_rows = [row for lst in archived_lists for row in lst if isinstance(row, dict) and row.get("slug")]

    by_slug: dict[str, dict[str, Any]] = {}
    # Live rows win; among duplicates, prefer the one carrying an id.
    for row in live_rows:
        slug = row["slug"]
        existing = by_slug.get(slug)
        if existing is None or (_row_id(existing) is None and _row_id(row) is not None):
            by_slug[slug] = row
    for row in archived_rows:
        by_slug.setdefault(row["slug"], row)

    by_id: dict[str, set[str]] = {}
    for row in (*live_rows, *archived_rows):
        rid = _row_id(row)
        if rid:
            by_id.setdefault(rid, set()).add(row["slug"])

    archived_slugs = {row["slug"] for row in archived_rows}
    reported_by_slug = {
        row["slug"]: row
        for lst in (live_lists[2],)
        for row in lst
        if isinstance(row, dict) and row.get("slug")
    }
    return {
        "by_slug": by_slug,
        "by_id": {key: sorted(value) for key, value in by_id.items()},
        "archived_slugs": archived_slugs,
        "reported_by_slug": reported_by_slug,
    }


# --------------------------------------------------------------------------- #
# Local inventory
# --------------------------------------------------------------------------- #

def discover_manifest_skills(scan_roots: list[Path]) -> list[dict[str, Any]]:
    """Find local skill folders (SKILL.md + companion.json) one level under each root."""
    seen_dirs: set[str] = set()
    found: list[dict[str, Any]] = []
    for root in scan_roots:
        if not root.exists() or not root.is_dir():
            continue
        candidates = [root]
        for child in sorted(root.iterdir()):
            if child.is_dir() and child.name not in SKIP_DIRS:
                candidates.append(child)
        for candidate in candidates:
            key = str(candidate.resolve())
            if key in seen_dirs:
                continue
            if not (candidate / "SKILL.md").exists() or not (candidate / "companion.json").exists():
                continue
            manifest = load_json(candidate / "companion.json") or {}
            slug = manifest.get("name")
            if not slug:
                continue
            seen_dirs.add(key)
            metadata = manifest.get("metadata") if isinstance(manifest.get("metadata"), dict) else {}
            found.append(
                {
                    "slug": str(slug),
                    "companionSkillId": metadata.get("companionSkillId"),
                    "version": manifest.get("version"),
                    "dir": str(candidate),
                }
            )
    return found


def _lock_records(path: Path, workspace_id: str | None, api_url: str) -> list[dict[str, Any]]:
    raw = load_json(path)
    if raw is None:
        return []
    return skill_records_from_lock(workspace_lock_entry(raw, workspace_id, api_url))


def build_local_inventory(workspace_id: str | None, api_url: str, scan_roots: list[Path]) -> list[dict[str, Any]]:
    """Union lockfile records, any leftover legacy-log records, and scanned manifests."""
    entries: list[dict[str, Any]] = []
    for record in _lock_records(lockfile_path(), workspace_id, api_url):
        entries.append(
            {
                "slug": record.get("slug") or record["name"],
                "skill_id": record.get("skillId"),
                "version": record.get("version"),
                "path": record.get("path"),
                "source": "lockfile",
            }
        )
    # Project-scope installs live in a per-project lockfile, so the guard must inventory the current
    # repo's lockfile too or a project-installed duplicate/retarget could slip past the preflight.
    _project_path, project_records = load_project_inventory(workspace_id, api_url)
    for record in project_records:
        entries.append(
            {
                "slug": record.get("slug") or record["name"],
                "skill_id": record.get("skillId"),
                "version": record.get("version"),
                "path": record.get("path"),
                "source": "project_lockfile",
            }
        )
    # Defensive: migration should have removed the legacy file, but if it is still
    # present we surface its rows rather than silently ignoring them.
    if legacy_log_path().exists():
        for record in _lock_records(legacy_log_path(), workspace_id, api_url):
            entries.append(
                {
                    "slug": record.get("slug") or record["name"],
                    "skill_id": record.get("skillId"),
                    "version": record.get("version"),
                    "path": record.get("path"),
                    "source": "legacy_log",
                }
            )
    for manifest in discover_manifest_skills(scan_roots):
        entries.append(
            {
                "slug": manifest["slug"],
                "skill_id": manifest.get("companionSkillId"),
                "version": manifest.get("version"),
                "path": manifest["dir"],
                "source": f"manifest:{manifest['dir']}",
            }
        )
    return entries


# --------------------------------------------------------------------------- #
# Conflict detection
# --------------------------------------------------------------------------- #

def _evidence(entry: dict[str, Any]) -> dict[str, Any]:
    return {
        "slug": entry.get("slug"),
        "skill_id": entry.get("skill_id"),
        "source": entry.get("source"),
        "path": entry.get("path"),
    }


def detect_conflicts(local_entries: list[dict[str, Any]], online: dict[str, Any]) -> list[dict[str, Any]]:
    conflicts: list[dict[str, Any]] = []
    by_slug = online.get("by_slug", {})
    archived_slugs = online.get("archived_slugs", set())

    # 1. one id -> multiple slugs (across any local source).
    by_id: dict[str, list[dict[str, Any]]] = {}
    for entry in local_entries:
        if entry.get("skill_id"):
            by_id.setdefault(entry["skill_id"], []).append(entry)
    for skill_id, group in by_id.items():
        slugs = sorted({entry["slug"] for entry in group})
        if len(slugs) > 1:
            conflicts.append(
                {
                    "kind": KIND_ID_MULTIPLE_SLUGS,
                    "severity": "block",
                    "slug": None,
                    "skill_id": skill_id,
                    "detail": f"skill id {skill_id} is mapped to multiple slugs: {', '.join(slugs)}",
                    "evidence": [_evidence(entry) for entry in group],
                    "remediation": "rename; one workspace skill id must map to exactly one slug",
                }
            )

    # 2. one slug -> multiple ids.
    by_slug_local: dict[str, list[dict[str, Any]]] = {}
    for entry in local_entries:
        by_slug_local.setdefault(entry["slug"], []).append(entry)
    for slug, group in by_slug_local.items():
        ids = sorted({entry["skill_id"] for entry in group if entry.get("skill_id")})
        if len(ids) > 1:
            conflicts.append(
                {
                    "kind": KIND_SLUG_MULTIPLE_IDS,
                    "severity": "block",
                    "slug": slug,
                    "skill_id": None,
                    "detail": f"slug {slug} is mapped to multiple skill ids: {', '.join(ids)}",
                    "evidence": [_evidence(entry) for entry in group],
                    "remediation": "repair local state; a slug must map to exactly one skill id",
                }
            )

    # 3. local slug published online under a different id (retarget).
    for entry in local_entries:
        slug = entry["slug"]
        local_id = entry.get("skill_id")
        if not local_id:
            continue
        online_row = by_slug.get(slug)
        online_id = _row_id(online_row) if online_row else None
        if online_id and online_id != local_id:
            conflicts.append(
                {
                    "kind": KIND_ID_MISMATCH_ONLINE,
                    "severity": "block",
                    "slug": slug,
                    "skill_id": local_id,
                    "detail": (
                        f"slug {slug} is published online as id {online_id} but tracked locally as {local_id}; "
                        "refusing to retarget"
                    ),
                    "evidence": [_evidence(entry)],
                    "remediation": "rename or re-point; never re-publish to retarget an existing skill",
                }
            )

    # 4. two local manifests sharing one companionSkillId.
    manifest_by_id: dict[str, list[dict[str, Any]]] = {}
    for entry in local_entries:
        if entry["source"].startswith("manifest:") and entry.get("skill_id"):
            manifest_by_id.setdefault(entry["skill_id"], []).append(entry)
    for skill_id, group in manifest_by_id.items():
        dirs = sorted({entry["path"] for entry in group if entry.get("path")})
        if len(dirs) > 1:
            conflicts.append(
                {
                    "kind": KIND_DUP_COMPANION_ID,
                    "severity": "block",
                    "slug": None,
                    "skill_id": skill_id,
                    "detail": f"companionSkillId {skill_id} is declared by multiple local manifests: {', '.join(dirs)}",
                    "evidence": [_evidence(entry) for entry in group],
                    "remediation": "give each skill a distinct companionSkillId",
                }
            )

    # 5. lockfile alone maps one id to two slugs -> repair the lockfile.
    lock_by_id: dict[str, list[dict[str, Any]]] = {}
    for entry in local_entries:
        if entry["source"] == "lockfile" and entry.get("skill_id"):
            lock_by_id.setdefault(entry["skill_id"], []).append(entry)
    for skill_id, group in lock_by_id.items():
        slugs = sorted({entry["slug"] for entry in group})
        if len(slugs) > 1:
            conflicts.append(
                {
                    "kind": KIND_LOCK_TWO_SLUGS,
                    "severity": "block",
                    "slug": None,
                    "skill_id": skill_id,
                    "detail": f"lockfile maps skill id {skill_id} to multiple slugs: {', '.join(slugs)}",
                    "evidence": [_evidence(entry) for entry in group],
                    "remediation": "request repair",
                }
            )

    # 6. locally tracked but missing/archived online (warn, never "current").
    reported: set[str] = set()
    for entry in local_entries:
        if entry["source"].startswith("manifest:"):
            continue  # a not-yet-published local folder is expected to be absent online
        slug = entry["slug"]
        if slug in reported:
            continue
        online_row = by_slug.get(slug)
        is_archived = slug in archived_slugs or (online_row is not None and online_row.get("archived") is True)
        if online_row is None or is_archived:
            reported.add(slug)
            reason = (
                "archived in the workspace but still tracked locally"
                if is_archived
                else "not published or not visible in this workspace"
            )
            conflicts.append(
                {
                    "kind": KIND_MISSING_OR_ARCHIVED,
                    "severity": "warn",
                    "slug": slug,
                    "skill_id": entry.get("skill_id"),
                    "detail": reason,
                    "evidence": [_evidence(entry)],
                    "remediation": "restore the skill or remove the stale lockfile entry",
                }
            )

    return conflicts


# --------------------------------------------------------------------------- #
# Create preflight
# --------------------------------------------------------------------------- #

def create_preflight(
    candidate_slug: str,
    online_by_slug: dict[str, Any],
    lockfile_slugs: set[str],
    legacy_log_slugs: set[str],
    manifest_slugs: set[str],
    archived_slugs: set[str],
) -> dict[str, Any]:
    found_in: list[str] = []
    online_row = online_by_slug.get(candidate_slug)
    if online_row is not None:
        found_in.append(online_row.get("scope") or "online")
    if candidate_slug in lockfile_slugs:
        found_in.append("lockfile")
    if candidate_slug in legacy_log_slugs:
        found_in.append("legacy_log")
    if candidate_slug in manifest_slugs:
        found_in.append("manifest")

    archived = candidate_slug in archived_slugs or (online_row is not None and online_row.get("archived") is True)
    allowed = len(found_in) == 0
    if allowed:
        recommendation = "create"
    elif archived:
        recommendation = "restore"
    elif online_row is not None or candidate_slug in lockfile_slugs or candidate_slug in legacy_log_slugs:
        # The skill already exists online or is tracked locally — update it, don't recreate.
        recommendation = "update"
    else:
        # Collides only with another local skill folder.
        recommendation = "rename"
    return {
        "slug": candidate_slug,
        "allowed": allowed,
        "found_in": found_in,
        "archived": archived,
        "recommendation": recommendation,
    }


# --------------------------------------------------------------------------- #
# Legacy migration
# --------------------------------------------------------------------------- #

def _sanitize_skill(record: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in record.items() if key in MIGRATION_FIELD_ALLOWLIST}


def _normalize_skills_collection(value: Any) -> dict[str, dict[str, Any]]:
    """Coerce a skills collection (dict keyed by slug or list) into a slug-keyed dict."""
    out: dict[str, dict[str, Any]] = {}
    if isinstance(value, dict):
        items: Any = value.items()
    elif isinstance(value, list):
        items = enumerate(value)
    else:
        return out
    for key, item in items:
        if not isinstance(item, dict):
            continue
        slug = item.get("slug") or item.get("name") or (key if isinstance(key, str) else None)
        if not slug:
            continue
        out[str(slug)] = item
    return out


def _atomic_write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    os.replace(tmp, path)


def migrate_legacy_log(workspace_id: str | None, api_url: str) -> dict[str, Any]:
    """Merge ~/.companion/skills.log.json into skills.lock.json, then delete the legacy file.

    Lockfile wins on conflict (legacy only fills empty fields, never downgrades a
    version). Idempotent: a no-op once the legacy file is gone. Never copies secrets.
    """
    legacy = legacy_log_path()
    if not legacy.exists():
        return {"migrated": False, "reason": "no legacy file"}
    if not workspace_id:
        return {"migrated": False, "reason": "cannot resolve workspace id for migration"}

    legacy_raw = load_json(legacy)
    if legacy_raw is None:
        return {"migrated": False, "reason": "legacy file is empty or unreadable"}

    legacy_entry = workspace_lock_entry(legacy_raw, workspace_id, api_url) or {}
    legacy_skills_raw = None
    for key in ("skills", "installedSkills", "installs"):
        if isinstance(legacy_entry.get(key), (dict, list)):
            legacy_skills_raw = legacy_entry[key]
            break
    if legacy_skills_raw is None and any(k in legacy_entry for k in ("name", "slug", "version", "installPath")):
        legacy_skills_raw = [legacy_entry]
    legacy_skills = _normalize_skills_collection(legacy_skills_raw)

    lock_raw = load_json(lockfile_path())
    if not isinstance(lock_raw, dict):
        lock_raw = {"schemaVersion": 2, "activeWorkspaceId": workspace_id, "workspaces": {}}
    lock_raw.setdefault("schemaVersion", 2)
    lock_raw.setdefault("activeWorkspaceId", workspace_id)
    workspaces = lock_raw.setdefault("workspaces", {})
    if not isinstance(workspaces, dict):
        workspaces = {}
        lock_raw["workspaces"] = workspaces
    ws_entry = workspaces.setdefault(workspace_id, {})
    if not isinstance(ws_entry, dict):
        ws_entry = {}
        workspaces[workspace_id] = ws_entry
    if api_url and not ws_entry.get("apiUrl"):
        ws_entry["apiUrl"] = api_url
    existing = _normalize_skills_collection(ws_entry.get("skills"))

    added: list[str] = []
    kept: list[str] = []
    for slug, legacy_skill in legacy_skills.items():
        sanitized = _sanitize_skill(legacy_skill)
        if slug not in existing:
            existing[slug] = sanitized
            added.append(slug)
            continue
        # Lockfile wins; only fill fields that are missing/empty locally, and never
        # downgrade an existing version.
        current = existing[slug]
        for field, value in sanitized.items():
            if field in ("version", "resolved"):
                continue
            if current.get(field) in (None, "", [], {}):
                current[field] = value
        kept.append(slug)

    ws_entry["skills"] = existing
    _atomic_write_json(lockfile_path(), lock_raw)

    # Re-read + validate before deleting the legacy file.
    verify = load_json(lockfile_path())
    if not isinstance(verify, dict) or workspace_id not in verify.get("workspaces", {}):
        return {"migrated": False, "reason": "lockfile verification failed after write"}
    legacy.unlink()
    return {"migrated": True, "added": sorted(added), "kept_lockfile": sorted(kept), "deleted_legacy": True}


# --------------------------------------------------------------------------- #
# Reporting / CLI
# --------------------------------------------------------------------------- #

def has_blocking(conflicts: list[dict[str, Any]]) -> bool:
    return any(conflict.get("severity") == "block" for conflict in conflicts)


def exit_code_for(conflicts: list[dict[str, Any]], create_check: dict[str, Any] | None) -> int:
    if has_blocking(conflicts):
        return 2
    if create_check is not None and not create_check.get("allowed", True):
        return 2
    return 0


def build_report(
    workspace_id: str | None,
    api_url: str,
    migration: dict[str, Any],
    local_entries: list[dict[str, Any]],
    online: dict[str, Any],
    conflicts: list[dict[str, Any]],
    create_check: dict[str, Any] | None,
) -> dict[str, Any]:
    by_slug = online.get("by_slug", {})
    reported_by_slug = online.get("reported_by_slug", {})
    archived_slugs = online.get("archived_slugs", set())
    inventory = []
    for entry in local_entries:
        if entry["source"].startswith("manifest:"):
            status, reason = "local", "local skill folder (not from the lockfile)"
        else:
            status, reason = status_for_local_guarded(
                {"name": entry["slug"], "version": entry.get("version")},
                by_slug,
                reported_by_slug,
                archived_slugs,
            )
        inventory.append(
            {
                "slug": entry["slug"],
                "skill_id": entry.get("skill_id"),
                "version": entry.get("version"),
                "source": entry["source"],
                "status": status,
                "reason": reason,
            }
        )
    return {
        "workspace": workspace_id,
        "api": api_url,
        "migrated": migration,
        "inventory": inventory,
        "conflicts": conflicts,
        "create_check": create_check,
    }


def print_human(report: dict[str, Any]) -> None:
    print(f"Workspace: {report['workspace'] or 'unknown'}")
    print(f"API: {report['api']}")
    migration = report["migrated"]
    if isinstance(migration, dict) and migration.get("migrated"):
        print(f"Migrated legacy skills.log.json: added {migration.get('added')}, kept {migration.get('kept_lockfile')}")

    print_rows(
        "Local inventory",
        [["skill", "id", "version", "source", "status", "reason"]] + [
            [
                row["slug"],
                (row.get("skill_id") or "-"),
                str(row.get("version") or "-"),
                row["source"],
                row["status"],
                row["reason"],
            ]
            for row in report["inventory"]
        ],
    )
    print_rows(
        "Conflicts",
        [["kind", "severity", "slug/id", "detail"]] + [
            [
                conflict["kind"],
                conflict["severity"],
                (conflict.get("slug") or conflict.get("skill_id") or "-"),
                conflict["detail"],
            ]
            for conflict in report["conflicts"]
        ],
    )
    create_check = report["create_check"]
    if create_check is not None:
        verdict = "allowed" if create_check["allowed"] else "REFUSED"
        print(f"\nCreate check for {create_check['slug']}: {verdict}")
        if not create_check["allowed"]:
            print(f"  found in: {', '.join(create_check['found_in'])}")
            print(f"  recommendation: {create_check['recommendation']}")


def parse_args(argv: list[str]) -> dict[str, Any]:
    as_json = False
    create_check: str | None = None
    scan_roots: list[str] = []
    index = 0
    while index < len(argv):
        arg = argv[index]
        if arg == "--json":
            as_json = True
        elif arg == "--create-check":
            index += 1
            if index >= len(argv):
                fail("--create-check requires a slug")
            create_check = argv[index]
        elif arg.startswith("--create-check="):
            create_check = arg.split("=", 1)[1]
        elif arg.startswith("--"):
            fail(f"unknown flag: {arg}")
        else:
            scan_roots.append(arg)
        index += 1
    return {"json": as_json, "create_check": create_check, "scan_roots": scan_roots}


def main(argv: list[str] | None = None) -> int:
    options = parse_args(list(sys.argv[1:] if argv is None else argv))
    api_url, token, workspace_id = resolve_credentials()
    if not workspace_id:
        local_skill = api_get(api_url, token, "/local-skills/companion")
        workspace_id = local_skill.get("workspaceId") if isinstance(local_skill, dict) else None

    migration = migrate_legacy_log(workspace_id, api_url)
    online = build_online_index(api_url, token)

    scan_roots = [Path(root) for root in options["scan_roots"]] or [Path.cwd()]
    local_entries = build_local_inventory(workspace_id, api_url, scan_roots)
    conflicts = detect_conflicts(local_entries, online)

    create_check = None
    if options["create_check"]:
        # Both the user and the per-project lockfile count as existing installs for duplicate detection.
        lockfile_slugs = {e["slug"] for e in local_entries if e["source"] in ("lockfile", "project_lockfile")}
        legacy_slugs = {e["slug"] for e in local_entries if e["source"] == "legacy_log"}
        manifest_slugs = {e["slug"] for e in local_entries if e["source"].startswith("manifest:")}
        create_check = create_preflight(
            options["create_check"],
            online["by_slug"],
            lockfile_slugs,
            legacy_slugs,
            manifest_slugs,
            online["archived_slugs"],
        )

    report = build_report(workspace_id, api_url, migration, local_entries, online, conflicts, create_check)
    if options["json"]:
        print(json.dumps(report, indent=2, sort_keys=True))
    else:
        print_human(report)
    return exit_code_for(conflicts, create_check)


if __name__ == "__main__":
    raise SystemExit(main())
