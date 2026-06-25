#!/usr/bin/env python3
"""List Companion workspace skills, reported installs, and local lockfile status."""

from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from companion_lib import (  # noqa: E402  (path shim must run before the import)
    api_get,
    fail,
    load_local_inventory,
    print_rows,
    resolve_credentials,
    status_for_local,
)


def main() -> None:
    api_url, token, workspace_id = resolve_credentials()
    if not workspace_id:
        local_skill = api_get(api_url, token, "/local-skills/companion")
        workspace_id = local_skill.get("workspaceId")

    org_skills = api_get(api_url, token, "/skills?lib=org")
    mine_skills = api_get(api_url, token, "/skills?lib=mine")
    installed_skills = api_get(api_url, token, "/skills?installed=true")
    if not all(isinstance(value, list) for value in (org_skills, mine_skills, installed_skills)):
        fail("skills listing endpoints returned an unexpected response shape")

    workspace_by_slug = {row["slug"]: row for row in [*org_skills, *mine_skills] if isinstance(row, dict) and row.get("slug")}
    reported_by_slug = {row["slug"]: row for row in installed_skills if isinstance(row, dict) and row.get("slug")}
    lock_path, local_rows = load_local_inventory(workspace_id, api_url)

    print(f"Workspace: {workspace_id or 'unknown'}")
    print(f"API: {api_url}")
    print(f"Local inventory: {lock_path if lock_path else 'none'}")

    print_rows(
        "Workspace skills",
        [["skill", "library", "current", "installed"]] + [
            [
                row.get("slug", "-"),
                row.get("source") or row.get("scope") or "-",
                row.get("current_version") or "-",
                row.get("install_status") or "none",
            ]
            for row in sorted(workspace_by_slug.values(), key=lambda item: item.get("slug", ""))
        ],
    )
    print_rows(
        "Reported installed skills",
        [["skill", "installed", "current", "status"]] + [
            [
                row.get("slug", "-"),
                row.get("installed_version") or "unknown",
                row.get("current_version") or "-",
                row.get("install_status") or "none",
            ]
            for row in sorted(installed_skills, key=lambda item: item.get("slug", ""))
        ],
    )
    print_rows(
        "Local lockfile skills",
        [["skill", "local", "status", "reason"]] + [
            [row["name"], str(row.get("version") or "unknown"), *status_for_local(row, workspace_by_slug, reported_by_slug)]
            for row in local_rows
        ],
    )


if __name__ == "__main__":
    main()
