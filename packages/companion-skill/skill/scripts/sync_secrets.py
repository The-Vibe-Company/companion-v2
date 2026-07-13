#!/usr/bin/env python3
"""Sync secure .env projections for installed skills or retrieve one explicit manual profile."""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from companion_lib import (  # noqa: E402
    load_json,
    lockfile_path,
    resolve_credentials,
    workspace_lock_entry,
)
from secrets_runtime import (  # noqa: E402
    apply_redeemed_projections,
    preflight_manual,
    preflight_skills,
    recover_pending_transactions,
    redacted_preflight,
    redeem_plan,
    state_path,
)


def installed_slugs(workspace_id: str | None, api_url: str) -> list[str]:
    raw = load_json(lockfile_path()) or {}
    entry = workspace_lock_entry(raw, workspace_id, api_url)
    skills = entry.get("skills") if isinstance(entry, dict) else {}
    return sorted(str(slug) for slug in skills if isinstance(slug, str)) if isinstance(skills, dict) else []


def offline_summary(workspace_id: str, slugs: list[str]) -> dict[str, Any]:
    raw = load_json(state_path()) or {}
    workspaces = raw.get("workspaces") if isinstance(raw, dict) else {}
    workspace = workspaces.get(workspace_id) if isinstance(workspaces, dict) else {}
    projections = workspace.get("projections") if isinstance(workspace, dict) else {}
    known = {
        str(row.get("skill"))
        for row in projections.values()
        if isinstance(projections, dict) and isinstance(row, dict) and row.get("path") and Path(str(row["path"])).exists()
    }
    skipped = [{"slug": slug, "reason": "offline: using the last coherent local projection; it may be stale"} for slug in slugs if slug in known]
    errors = [{"slug": slug, "error": "offline and no coherent local projection is available"} for slug in slugs if slug not in known]
    return {"updated": [], "skipped": skipped, "errors": errors, "offline": True, "revocationInstant": False}


def sync(api_url: str, token: str, workspace_id: str, slugs: list[str], confirmed: bool) -> dict[str, Any]:
    summary: dict[str, Any] = {"updated": [], "skipped": [], "errors": [], "offline": False}
    for slug in slugs:
        try:
            preflight = preflight_skills(api_url, token, [{"slug": slug}])
            if int(preflight.get("blockers") or 0) > 0:
                summary["skipped"].append({"slug": slug, "reason": "required configuration is missing", "preflight": redacted_preflight(preflight)})
                continue
            if not confirmed:
                summary["skipped"].append({"slug": slug, "reason": "confirmation required", "preflight": redacted_preflight(preflight)})
                continue
            redeemed = redeem_plan(api_url, token, str(preflight["plan_id"]))
            paths = apply_redeemed_projections(workspace_id, redeemed)
            summary["updated"].append({"slug": slug, "projections": {name: str(path) for name, path in paths.items()}, "warnings": int(preflight.get("warnings") or 0)})
        except (OSError, RuntimeError, ValueError, SystemExit) as exc:
            summary["errors"].append({"slug": slug, "error": str(exc)})
    return summary


def main() -> None:
    parser = argparse.ArgumentParser(description="Sync Companion secret projections")
    subparsers = parser.add_subparsers(dest="command", required=True)
    sync_parser = subparsers.add_parser("sync", help="sync one or more installed skills")
    sync_parser.add_argument("slugs", nargs="*")
    sync_parser.add_argument("--all", action="store_true", help="sync every skill in the active workspace lockfile")
    sync_parser.add_argument("--confirm", action="store_true", help="confirm the metadata-only preflights and redeem grants")
    sync_parser.add_argument("--offline", action="store_true", help="keep and report the last coherent projections without contacting Companion")
    sync_parser.add_argument("--json", action="store_true")
    manual = subparsers.add_parser("manual", help="retrieve one secret outside a skill")
    manual.add_argument("profile")
    manual.add_argument("secret_id")
    manual.add_argument("env_key")
    manual.add_argument("--confirm", action="store_true")
    manual.add_argument("--json", action="store_true")
    args = parser.parse_args()

    api_url, token, workspace_id = resolve_credentials()
    if not workspace_id:
        raise SystemExit("error: COMPANION_WORKSPACE_ID is required for secret projections")
    recover_pending_transactions(workspace_id)

    if args.command == "sync":
        slugs = list(dict.fromkeys([*args.slugs, *(installed_slugs(workspace_id, api_url) if args.all else [])]))
        if not slugs:
            raise SystemExit("error: provide a skill slug or --all")
        result = offline_summary(workspace_id, slugs) if args.offline else sync(api_url, token, workspace_id, slugs, args.confirm)
    else:
        preflight = preflight_manual(api_url, token, args.secret_id, args.env_key, args.profile)
        if not args.confirm:
            result = {"updated": [], "skipped": [{"profile": args.profile, "reason": "confirmation required", "preflight": redacted_preflight(preflight)}], "errors": []}
        else:
            redeemed = redeem_plan(api_url, token, str(preflight["plan_id"]))
            paths = apply_redeemed_projections(workspace_id, redeemed)
            result = {"updated": [{"profile": args.profile, "path": str(paths.get(f"_manual/{args.profile}") or "")}], "skipped": [], "errors": []}

    if args.json:
        print(json.dumps(result, indent=2, sort_keys=True))
    else:
        print(f"updated: {len(result['updated'])} · skipped: {len(result['skipped'])} · errors: {len(result['errors'])}")
        for row in result["updated"]:
            print(f"  updated  {row.get('slug') or row.get('profile')}")
        for row in result["skipped"]:
            print(f"  skipped  {row.get('slug') or row.get('profile')}: {row.get('reason')}")
        for row in result["errors"]:
            print(f"  error    {row.get('slug') or row.get('profile')}: {row.get('error')}")
    if result["errors"]:
        raise SystemExit(1)
    if result["skipped"] and not result["updated"]:
        raise SystemExit(2)


if __name__ == "__main__":
    main()
