#!/usr/bin/env python3
"""Companion self-update helpers for the local bootstrap."""

from __future__ import annotations

import json
import os
import shutil
import tempfile
import urllib.error
import urllib.request
import zipfile
from pathlib import Path, PurePosixPath
from typing import Any

from bootstrap_integrity import (
    official_file_hashes,
    local_companion_version,
    read_json,
    validate_integrity_baseline,
    validate_official_package_hashes,
)
from companion_lib import fail


def api_post_json(base: str, token: str, path: str, body: dict[str, Any]) -> Any:
    url = f"{base.rstrip('/')}{path}"
    data = json.dumps(body).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=data,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        text = exc.read().decode("utf-8", errors="replace")
        fail(f"POST {url} failed with HTTP {exc.code}: {text}")
    except urllib.error.URLError as exc:
        fail(f"POST {url} failed: {exc.reason}")


def download_package(base: str, token: str, destination: Path) -> None:
    url = f"{base.rstrip('/')}/local-skills/companion/package"
    request = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            destination.write_bytes(response.read())
    except urllib.error.HTTPError as exc:
        text = exc.read().decode("utf-8", errors="replace")
        fail(f"GET {url} failed with HTTP {exc.code}: {text}")
    except urllib.error.URLError as exc:
        fail(f"GET {url} failed: {exc.reason}")


def frontmatter_name(skill_md: Path) -> str | None:
    try:
        text = skill_md.read_text(encoding="utf-8")
    except FileNotFoundError:
        return None
    if not text.startswith("---"):
        return None
    for line in text.splitlines()[1:]:
        if line.strip() == "---":
            return None
        if line.startswith("name:"):
            return line.split(":", 1)[1].strip().strip('"').strip("'")
    return None


def validate_companion_dir(
    path: Path,
    expected_version: str | None = None,
    require_folder_name: bool = True,
    require_integrity: bool = False,
) -> None:
    if require_folder_name and path.name != "companion":
        fail(f"Companion skill folder must be named companion: {path}")
    if frontmatter_name(path / "SKILL.md") != "companion":
        fail(f"{path / 'SKILL.md'} does not declare name: companion")
    version = local_companion_version(path)
    if expected_version and version != expected_version:
        fail(f"{path / 'companion.json'} version {version or 'missing'} does not match {expected_version}")
    if require_integrity and expected_version:
        validate_integrity_baseline(path, expected_version)


def safe_extract_zip(zf: zipfile.ZipFile, destination: Path) -> None:
    for info in zf.infolist():
        name = info.filename
        parts = PurePosixPath(name).parts
        if not name or name.startswith(("/", "\\")) or "\\" in name or any(part in ("", ".", "..") for part in parts):
            fail(f"downloaded Companion package contains an unsafe path: {name}")
    zf.extractall(destination)


def path_contains(parent: Path, child: Path) -> bool:
    try:
        child.resolve().relative_to(parent.resolve())
        return True
    except ValueError:
        return False


def leave_skill_cwd(skill_dir: Path) -> Path | None:
    original = Path.cwd()
    if path_contains(skill_dir, original):
        os.chdir(skill_dir.parent)
        return original
    return None


def install_companion_update(
    api_url: str,
    token: str,
    skill_dir: Path,
    available_version: str,
    agent: str,
    official_files: dict[str, str],
) -> dict[str, Any]:
    validate_companion_dir(skill_dir)
    parent = skill_dir.parent
    tmp = Path(tempfile.mkdtemp(prefix="companion-bootstrap-"))
    staged: Path | None = None
    backup: Path | None = None
    restore_cwd: Path | None = None
    try:
        archive = tmp / "companion.zip"
        package = tmp / "package"
        download_package(api_url, token, archive)
        with zipfile.ZipFile(archive) as zf:
            safe_extract_zip(zf, package)
        validate_companion_dir(package, available_version, require_folder_name=False, require_integrity=True)
        validate_official_package_hashes(package, official_files)

        staged = Path(tempfile.mkdtemp(prefix=".companion-update.", dir=str(parent)))
        shutil.copytree(package, staged, dirs_exist_ok=True)
        validate_companion_dir(staged, available_version, require_folder_name=False, require_integrity=True)
        validate_official_package_hashes(staged, official_files)

        restore_cwd = leave_skill_cwd(skill_dir)
        backup = Path(tempfile.mkdtemp(prefix=".companion-backup.", dir=str(parent)))
        backup.rmdir()
        skill_dir.rename(backup)
        try:
            staged.rename(skill_dir)
        except BaseException:
            if not skill_dir.exists() and backup.exists():
                backup.rename(skill_dir)
            raise

        report = api_post_json(api_url, token, "/local-skills/companion/installed", {"version": available_version, "agent": agent})
        backup_path = str(backup)
        shutil.rmtree(backup)
        backup = None
        return {"applied": True, "version": available_version, "backupPath": backup_path, "backupDeleted": True, "report": report}
    finally:
        if restore_cwd and restore_cwd.exists():
            os.chdir(restore_cwd)
        if staged and staged.exists():
            shutil.rmtree(staged, ignore_errors=True)
        shutil.rmtree(tmp, ignore_errors=True)


def companion_auto_update_result(
    api_url: str,
    token: str,
    skill_dir: Path,
    local_skill: dict[str, Any],
    available_version: str,
    integrity: dict[str, Any],
    agent: str,
) -> dict[str, Any]:
    blocking = integrity["blockingFiles"]
    integrity_status = integrity.get("status")
    integrity_comparable = integrity.get("comparable") is True
    if not integrity_comparable or blocking or integrity_status != "official":
        return {
            "requested": True,
            "applied": False,
            "blocked": True,
            "reason": "local_customizations" if blocking else "integrity_unavailable",
            "files": blocking,
        }

    return install_companion_update(
        api_url,
        token,
        skill_dir,
        available_version,
        agent,
        official_file_hashes(local_skill),
    )
