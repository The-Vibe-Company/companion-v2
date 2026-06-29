#!/usr/bin/env python3
"""Fast local Companion bootstrap and health check.

The bootstrap gathers the context an agent needs at startup: workspace status,
Companion self-update status, local integrity, reported installs, and local
lockfile drift. With ``--auto-update-companion`` it may update only this
Companion skill, and only when tracked local files still match an official
integrity baseline for the installed version.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from datetime import datetime, timezone
from functools import cmp_to_key
from pathlib import Path
from typing import Any

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from bootstrap_integrity import INTEGRITY_BASELINE_FILE, compare_integrity, local_companion_version, sha256_file  # noqa: E402,F401
from bootstrap_update import companion_auto_update_result, install_companion_update  # noqa: E402
from companion_lib import (  # noqa: E402
    api_get,
    compare_semver,
    load_local_inventory,
    load_project_inventory,
    resolve_credentials,
    status_for_local,
)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def installed_skill_dir() -> Path:
    override = os.environ.get("COMPANION_SKILL_DIR")
    if override:
        return Path(override).expanduser().resolve()
    return Path(__file__).resolve().parents[1]


def redact_error(value: BaseException | str) -> str:
    text = str(value)
    return re.sub(r"cmp_pat_[A-Za-z0-9._-]+", "cmp_pat_[redacted]", text)


def workspace_skill_rows(org_skills: Any, mine_skills: Any, installed_skills: Any) -> tuple[dict[str, dict[str, Any]], dict[str, dict[str, Any]]]:
    workspace_by_slug = {
        row["slug"]: row
        for row in [*(org_skills if isinstance(org_skills, list) else []), *(mine_skills if isinstance(mine_skills, list) else [])]
        if isinstance(row, dict) and row.get("slug")
    }
    reported_by_slug = {
        row["slug"]: row for row in (installed_skills if isinstance(installed_skills, list) else []) if isinstance(row, dict) and row.get("slug")
    }
    return workspace_by_slug, reported_by_slug


def build_skill_context(
    workspace_id: str | None,
    api_url: str,
    org_skills: Any,
    mine_skills: Any,
    installed_skills: Any,
) -> dict[str, Any]:
    workspace_by_slug, reported_by_slug = workspace_skill_rows(org_skills, mine_skills, installed_skills)
    lock_path, local_rows = load_local_inventory(workspace_id, api_url)

    # Fold in project-scope installs from the current repo's lockfile so the inventory is
    # multi-project aware: each skill shows every install location (user-global + this project),
    # merged by slug so the same skill installed at both scopes lists all of its targets.
    project_lock_path, project_rows = load_project_inventory(workspace_id, api_url)
    if project_rows:
        by_name = {row["name"]: row for row in local_rows}
        for row in project_rows:
            existing = by_name.get(row["name"])
            if existing is None:
                local_rows.append(row)
                by_name[row["name"]] = row
                continue
            existing.setdefault("targets", [])
            existing["targets"] = [*(existing.get("targets") or []), *(row.get("targets") or [])]
            # Effective version is the OLDEST across user + project targets so a behind project
            # target makes the merged skill read as "update", not "current".
            versions = [t.get("version") for t in existing["targets"] if t.get("version")]
            candidates = [v for v in (existing.get("version"), row.get("version"), *versions) if v]
            if candidates:
                existing["version"] = min(candidates, key=cmp_to_key(compare_semver))

    local = []
    counts = {"current": 0, "update": 0, "missing": 0, "unknown": 0}
    for row in local_rows:
        status, reason = status_for_local(row, workspace_by_slug, reported_by_slug)
        counts[status] = counts.get(status, 0) + 1
        local.append(
            {
                "slug": row["name"],
                "version": row.get("version"),
                "status": status,
                "reason": reason,
                "path": row.get("path"),
                # Every install location for this skill (Claude Code, Codex, OpenCode, …) at its scope level.
                # A legacy single-path lockfile folds into one user-scope Claude Code target.
                "targets": row.get("targets") or [],
                "skillId": row.get("skillId"),
                "checksum": row.get("checksum"),
            }
        )

    updates = [
        {
            "slug": row.get("slug"),
            "installedVersion": row.get("installed_version"),
            "currentVersion": row.get("current_version"),
            "status": row.get("install_status"),
        }
        for row in (installed_skills if isinstance(installed_skills, list) else [])
        if isinstance(row, dict) and row.get("install_status") == "update"
    ]

    return {
        "lockfile": str(lock_path) if lock_path else None,
        "projectLockfile": str(project_lock_path) if project_lock_path else None,
        "workspaceCount": len(workspace_by_slug),
        "reportedInstalledCount": len(reported_by_slug),
        "localCount": len(local),
        "counts": counts,
        "updates": updates,
        "local": local,
    }


def collect_context(auto_update: bool = False, agent: str = "companion-bootstrap") -> dict[str, Any]:
    skill_dir = installed_skill_dir()
    context: dict[str, Any] = {
        "schemaVersion": 1,
        "checkedAt": now_iso(),
        "workspace": {"id": None, "apiUrl": None},
        "companion": {
            "key": "companion",
            "skillDir": str(skill_dir),
            "localVersion": local_companion_version(skill_dir),
            "availableVersion": None,
            "status": "unknown",
            "changes": [],
            "autoUpdate": {"requested": auto_update, "applied": False, "blocked": False, "reason": None},
        },
        "integrity": {"status": "unknown", "blockingFiles": [], "files": [], "counts": {}, "packageChecksum": None},
        "skills": {"lockfile": None, "projectLockfile": None, "workspaceCount": 0, "reportedInstalledCount": 0, "localCount": 0, "counts": {}, "updates": [], "local": []},
        "actions": [],
        "errors": [],
    }

    try:
        api_url, token, workspace_id = resolve_credentials()
        context["workspace"] = {"id": workspace_id, "apiUrl": api_url}
        local_skill = api_get(api_url, token, "/local-skills/companion")
        if not workspace_id:
            workspace_id = local_skill.get("workspaceId")
            context["workspace"]["id"] = workspace_id

        context["companion"].update(
            {
                "availableVersion": local_skill.get("availableVersion"),
                "status": local_skill.get("status") or "unknown",
                "reportedInstalledVersion": local_skill.get("installedVersion"),
                "changes": local_skill.get("changes") if isinstance(local_skill.get("changes"), list) else [],
            }
        )
        context["integrity"] = compare_integrity(skill_dir, local_skill)

        local_version = context["companion"]["localVersion"]
        available_version = context["companion"]["availableVersion"]
        update_available = compare_semver(local_version, available_version) < 0 if available_version else False
        if update_available:
            context["actions"].append({"kind": "update_companion", "version": available_version})

        if auto_update and update_available:
            result = companion_auto_update_result(api_url, token, skill_dir, local_skill, str(available_version), context["integrity"], agent)
            context["companion"]["autoUpdate"].update(result)
            if result.get("applied"):
                applied_version = str(result.get("version") or available_version)
                context["companion"]["localVersion"] = applied_version
                context["companion"]["reportedInstalledVersion"] = applied_version
                context["companion"]["status"] = result.get("report", {}).get("status", "installed")
                context["integrity"] = compare_integrity(skill_dir, local_skill)
                context["actions"] = [action for action in context["actions"] if action.get("kind") != "update_companion"]

        try:
            org_skills = api_get(api_url, token, "/skills?lib=org")
            mine_skills = api_get(api_url, token, "/skills?lib=mine")
            installed_skills = api_get(api_url, token, "/skills?installed=true")
            if not all(isinstance(value, list) for value in (org_skills, mine_skills, installed_skills)):
                raise RuntimeError("skills listing endpoints returned an unexpected response shape")
            context["skills"] = build_skill_context(workspace_id, api_url, org_skills, mine_skills, installed_skills)
            if context["skills"]["updates"]:
                context["actions"].append({"kind": "review_skill_updates", "count": len(context["skills"]["updates"])})
        except BaseException as exc:
            context["errors"].append({"message": redact_error(exc)})
    except SystemExit as exc:
        context["errors"].append({"message": redact_error(exc)})
    except BaseException as exc:  # keep bootstrap output useful even on unexpected local failures
        context["errors"].append({"message": redact_error(exc)})

    return context


def print_summary(context: dict[str, Any]) -> None:
    companion = context["companion"]
    integrity = context["integrity"]
    skills = context["skills"]
    print(f"Workspace: {context['workspace'].get('id') or 'unknown'}")
    print(f"API: {context['workspace'].get('apiUrl') or 'unknown'}")
    print(
        "Companion: "
        f"local {companion.get('localVersion') or 'unknown'} / "
        f"available {companion.get('availableVersion') or 'unknown'} / "
        f"{companion.get('status') or 'unknown'}"
    )
    print(f"Integrity: {integrity.get('status')} ({len(integrity.get('blockingFiles') or [])} blocking file(s))")
    print(f"Local inventory: {skills.get('lockfile') or 'none'}")
    print(f"Skills: {skills.get('localCount', 0)} local, {skills.get('reportedInstalledCount', 0)} reported installed")
    if skills.get("updates"):
        print(f"Skill updates: {len(skills['updates'])}")
    if context.get("actions"):
        print("Actions:")
        for action in context["actions"]:
            print(f"  - {action.get('kind')}: {action}")
    if context.get("errors"):
        print("Errors:")
        for error in context["errors"]:
            print(f"  - {error.get('message')}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Fast Companion bootstrap health check")
    parser.add_argument("--json", action="store_true", help="print machine-readable context only")
    parser.add_argument("--summary", action="store_true", help="print a human summary")
    parser.add_argument("--auto-update-companion", action="store_true", help="install a newer Companion skill when local tracked files are official")
    parser.add_argument("--agent", default=os.environ.get("COMPANION_AGENT", "companion-bootstrap"), help="agent label for install reporting")
    args = parser.parse_args()

    context = collect_context(auto_update=args.auto_update_companion, agent=args.agent)
    if args.json:
        print(json.dumps(context, indent=2, sort_keys=True))
    if args.summary or not args.json:
        print_summary(context)
    if context["errors"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
