#!/usr/bin/env python3
"""Shared helpers for the local Companion skill scripts.

This module is imported by ``bootstrap.py``, ``check_updates.py``, and ``skill_guard.py``. It
holds credential resolution, the workspace API client, semver comparison, and
lockfile parsing. It NEVER prints or persists the Companion token.
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any


def fail(message: str) -> None:
    raise SystemExit(f"error: {message}")


def load_json(path: Path) -> dict[str, Any] | None:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None
    except json.JSONDecodeError as exc:
        fail(f"{path} is not valid JSON: {exc}")


def api_get(base: str, token: str, path: str) -> Any:
    url = f"{base.rstrip('/')}{path}"
    request = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        fail(f"GET {url} failed with HTTP {exc.code}: {body}")
    except urllib.error.URLError as exc:
        fail(f"GET {url} failed: {exc.reason}")


def companion_home() -> Path:
    """Return ~/.companion, honoring COMPANION_HOME for tests and overrides."""
    override = os.environ.get("COMPANION_HOME")
    if override:
        return Path(override)
    return Path.home() / ".companion"


def resolve_credentials() -> tuple[str, str, str | None]:
    api_url = os.environ.get("COMPANION_API_URL")
    token = os.environ.get("COMPANION_TOKEN")
    workspace_id = os.environ.get("COMPANION_WORKSPACE_ID")
    if api_url and token:
        return api_url, token, workspace_id

    credentials_path = companion_home() / "credentials.json"
    credentials = load_json(credentials_path)
    if not credentials:
        fail("missing Companion credentials; set COMPANION_API_URL and COMPANION_TOKEN or refresh ~/.companion/credentials.json")

    if credentials.get("schemaVersion") == 2 and isinstance(credentials.get("workspaces"), dict):
        active = credentials.get("activeWorkspaceId")
        if not active:
            fail("credentials.json has no activeWorkspaceId")
        entry = credentials["workspaces"].get(active)
        if not isinstance(entry, dict):
            fail(f"credentials.json has no workspace entry for {active}")
        api_url = entry.get("apiUrl")
        token = entry.get("token")
        if not api_url or not token:
            fail(f"credentials entry {active} is missing apiUrl or token")
        return str(api_url), str(token), str(active)

    api_url = credentials.get("apiUrl")
    token = credentials.get("token")
    if api_url and token:
        return str(api_url), str(token), workspace_id
    fail("credentials.json is missing apiUrl or token")


def parse_semver(version: str | None) -> tuple[int, int, int, list[str]] | None:
    if not version:
        return None
    without_build = version.strip().split("+", 1)[0]
    core, prerelease_sep, prerelease = without_build.partition("-")
    parts = core.split(".")
    if len(parts) != 3 or not all(part.isdigit() for part in parts):
        return None
    prerelease_parts = prerelease.split(".") if prerelease_sep else []
    return int(parts[0]), int(parts[1]), int(parts[2]), prerelease_parts


def compare_prerelease(left: list[str], right: list[str]) -> int:
    if not left and not right:
        return 0
    if not left:
        return 1
    if not right:
        return -1
    for index in range(max(len(left), len(right))):
        if index >= len(left):
            return -1
        if index >= len(right):
            return 1
        left_part = left[index]
        right_part = right[index]
        left_numeric = left_part.isdigit()
        right_numeric = right_part.isdigit()
        if left_numeric and right_numeric:
            left_num = int(left_part)
            right_num = int(right_part)
            if left_num != right_num:
                return -1 if left_num < right_num else 1
        elif left_numeric != right_numeric:
            return -1 if left_numeric else 1
        elif left_part != right_part:
            return -1 if left_part < right_part else 1
    return 0


def compare_semver(left: str | None, right: str | None) -> int:
    parsed_left = parse_semver(left)
    parsed_right = parse_semver(right)
    if not parsed_left and not parsed_right:
        return 0 if left == right else (-1 if str(left) < str(right) else 1)
    if not parsed_left:
        return -1
    if not parsed_right:
        return 1

    for left_part, right_part in zip(parsed_left[:3], parsed_right[:3]):
        if left_part != right_part:
            return -1 if left_part < right_part else 1
    return compare_prerelease(parsed_left[3], parsed_right[3])


def is_older(local: str | None, current: str | None) -> bool:
    if not local or not current:
        return False
    return compare_semver(local, current) < 0


def lockfile_path() -> Path:
    return companion_home() / "skills.lock.json"


def legacy_log_path() -> Path:
    return companion_home() / "skills.log.json"


def lockfile_candidates() -> list[Path]:
    return [lockfile_path(), legacy_log_path()]


def workspace_lock_entry(raw: dict[str, Any], workspace_id: str | None, api_url: str) -> dict[str, Any] | None:
    workspaces = raw.get("workspaces")
    if isinstance(workspaces, dict):
        keys = [workspace_id, raw.get("activeWorkspaceId"), api_url]
        for key in keys:
            if key and isinstance(workspaces.get(key), dict):
                return workspaces[key]
    return raw


def skill_records_from_lock(entry: dict[str, Any] | None) -> list[dict[str, Any]]:
    if not entry:
        return []
    source = None
    for key in ("skills", "installedSkills", "installs"):
        value = entry.get(key)
        if isinstance(value, (dict, list)):
            source = value
            break
    if source is None and any(key in entry for key in ("name", "version", "resolved", "installPath")):
        source = [entry]
    if source is None:
        return []

    items = source.items() if isinstance(source, dict) else enumerate(source)
    records: list[dict[str, Any]] = []
    for key, value in items:
        if not isinstance(value, dict):
            continue
        name = value.get("name") or value.get("slug") or (key if isinstance(key, str) else None)
        if not name:
            continue
        records.append(
            {
                "name": str(name),
                # `slug` and `companionSkillId` are surfaced distinctly (in addition to the
                # legacy `name`/`skillId` aliases) so the guard can reason about identity.
                "slug": str(value.get("slug") or name),
                "version": value.get("version") or value.get("resolved") or value.get("installedVersion"),
                "checksum": value.get("checksum"),
                "path": value.get("installPath") or value.get("path"),
                "skillId": value.get("skillId") or value.get("workspaceSkillId") or value.get("companionSkillId"),
                "companionSkillId": value.get("companionSkillId"),
            }
        )
    return sorted(records, key=lambda row: row["name"])


def load_local_inventory(workspace_id: str | None, api_url: str) -> tuple[Path | None, list[dict[str, Any]]]:
    for path in lockfile_candidates():
        raw = load_json(path)
        if raw is None:
            continue
        entry = workspace_lock_entry(raw, workspace_id, api_url)
        return path, skill_records_from_lock(entry)
    return None, []


def status_for_local(row: dict[str, Any], workspace_by_slug: dict[str, dict[str, Any]], reported_by_slug: dict[str, dict[str, Any]]) -> tuple[str, str]:
    slug = row["name"]
    workspace = workspace_by_slug.get(slug)
    if not workspace:
        return "missing", "not published or not visible in this workspace"
    current = workspace.get("current_version")
    local_version = row.get("version")
    if not local_version:
        return "unknown", "local version is missing from the lockfile"
    if is_older(str(local_version), current):
        return "update", f"newer published version {current}"
    reported = reported_by_slug.get(slug)
    if reported and reported.get("install_status") == "update":
        return "update", "reported install or dependency closure is behind"
    return "current", "up to date"


def status_for_local_guarded(
    row: dict[str, Any],
    workspace_by_slug: dict[str, dict[str, Any]],
    reported_by_slug: dict[str, dict[str, Any]],
    archived_slugs: set[str],
) -> tuple[str, str]:
    """Like status_for_local, but an archived or absent skill can never read as ``current``."""
    slug = row["name"]
    workspace = workspace_by_slug.get(slug)
    if not workspace or slug in archived_slugs or workspace.get("archived") is True:
        if slug in archived_slugs or (workspace and workspace.get("archived") is True):
            return "missing_or_archived", "archived in the workspace but still tracked locally"
        return "missing_or_archived", "not published or not visible in this workspace"
    return status_for_local(row, workspace_by_slug, reported_by_slug)


def print_rows(title: str, rows: list[list[str]]) -> None:
    print(f"\n{title}")
    if not rows:
        print("  none")
        return
    widths = [max(len(row[i]) for row in rows) for i in range(len(rows[0]))]
    for row in rows:
        print("  " + "  ".join(value.ljust(widths[i]) for i, value in enumerate(row)))
