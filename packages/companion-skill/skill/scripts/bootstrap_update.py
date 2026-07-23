#!/usr/bin/env python3
"""Companion self-update helpers for the local bootstrap."""

from __future__ import annotations

import os
import shutil
import tempfile
import zipfile
from pathlib import Path, PurePosixPath
from typing import Any

from bootstrap_integrity import (
    compare_integrity,
    official_file_hashes,
    local_companion_version,
    read_json,
    validate_integrity_baseline,
    validate_official_package_hashes,
)
from companion_lib import (
    api_download_bytes,
    api_post_json,
    compare_semver,
    fail,
    load_tool_registry,
    resolve_target_dir,
)


def download_package(base: str, token: str, destination: Path) -> None:
    destination.write_bytes(api_download_bytes(base, token, "/local-skills/companion/package"))


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


def leave_target_cwds(target_dirs: list[Path]) -> Path | None:
    """Move outside every target before a multi-target swap.

    A self-update may replace the directory containing the running script. Keeping
    the process cwd inside any target makes renames unreliable on some hosts.
    """
    original = Path.cwd()
    for target_dir in target_dirs:
        if path_contains(target_dir, original):
            os.chdir(target_dir.parent)
            return original
    return None


def remove_swap_path(path: Path) -> None:
    """Remove a transient swap path whether it is a directory, file, or symlink."""
    if not os.path.lexists(path):
        return
    if path.is_symlink() or path.is_file():
        path.unlink()
        return
    shutil.rmtree(path)


def companion_install_targets(skill_dir: Path) -> list[dict[str, Any]]:
    """Return every existing user-global Companion installation.

    The current folder is always included. Registered tool locations are included
    only when a Companion folder already exists, so self-update repairs copies
    without silently installing Companion into a new host. Physical paths are
    de-duplicated so shared/symlinked Agent Skills locations are swapped once.
    """
    registry = load_tool_registry()
    candidates: list[tuple[str, Path]] = [("current", skill_dir)]
    for tool in sorted(registry):
        target = resolve_target_dir(tool, "user", "companion", registry=registry)
        if os.path.lexists(target):
            candidates.append((tool, target))

    targets: dict[str, dict[str, Any]] = {}
    for tool, candidate in candidates:
        physical = candidate.resolve()
        key = str(physical)
        row = targets.setdefault(key, {"path": physical, "tools": []})
        if tool not in row["tools"]:
            row["tools"].append(tool)
    return list(targets.values())


def companion_target_statuses(
    skill_dir: Path,
    local_skill: dict[str, Any],
    available_version: str | None,
) -> list[dict[str, Any]]:
    """Inspect all existing Companion copies against their own official baseline."""
    rows: list[dict[str, Any]] = []
    for target in companion_install_targets(skill_dir):
        path = target["path"]
        version = local_companion_version(path)
        integrity = compare_integrity(path, local_skill)
        comparison = compare_semver(version, available_version) if version and available_version else None
        rows.append(
            {
                "path": str(path),
                "tools": sorted(target["tools"]),
                "version": version,
                "integrity": integrity.get("status"),
                "integritySource": integrity.get("source"),
                "blockingFiles": integrity.get("blockingFiles") or [],
                "needsUpdate": comparison is not None and comparison < 0,
                "ahead": comparison is not None and comparison > 0,
            }
        )
    return rows


def _stage_companion_package(package: Path, target_dir: Path, available_version: str, official_files: dict[str, str]) -> Path:
    target_dir.parent.mkdir(parents=True, exist_ok=True)
    staged = Path(tempfile.mkdtemp(prefix=".companion-update.", dir=str(target_dir.parent)))
    shutil.copytree(package, staged, dirs_exist_ok=True)
    validate_companion_dir(staged, available_version, require_folder_name=False, require_integrity=True)
    validate_official_package_hashes(staged, official_files)
    return staged


def _rollback_swaps(swapped: list[tuple[Path, Path]]) -> list[tuple[Path, Path, str]]:
    failures: list[tuple[Path, Path, str]] = []
    for target, backup in reversed(swapped):
        try:
            if os.path.lexists(target):
                remove_swap_path(target)
            if os.path.lexists(backup):
                backup.rename(target)
        except BaseException as exc:  # preserve every rollback attempt before failing
            failures.append((target, backup, str(exc)))
    return failures


def _swap_staged_target(target: Path, staged: Path, backup: Path) -> None:
    target.rename(backup)
    try:
        staged.rename(target)
    except BaseException:
        if not target.exists() and backup.exists():
            backup.rename(target)
        raise


def _validate_update_target(target: Path, available_version: str) -> str:
    validate_companion_dir(target)
    target_version = local_companion_version(target)
    if not target_version:
        fail(f"{target / 'companion.json'} has no installed version")
    validate_integrity_baseline(target, target_version)
    if compare_semver(target_version, available_version) > 0:
        fail(
            f"{target} has newer Companion version {target_version}; "
            f"refusing to replace it with {available_version}"
        )
    return target_version


def install_companion_update(
    api_url: str,
    token: str,
    skill_dir: Path,
    available_version: str,
    agent: str,
    official_files: dict[str, str],
    target_dirs: list[Path] | None = None,
) -> dict[str, Any]:
    # The runtime folder is normally named ``companion``. Allow the checked-in
    # package root (commonly ``.../companion-skill/skill``) to drive a repair as
    # long as its frontmatter and integrity are valid; installed targets below
    # still require the canonical folder name.
    validate_companion_dir(skill_dir, require_folder_name=False)
    targets = target_dirs or [skill_dir]
    targets = list(dict.fromkeys(path.resolve() for path in targets))
    for target in targets:
        _validate_update_target(target, available_version)

    tmp = Path(tempfile.mkdtemp(prefix="companion-bootstrap-"))
    staged: dict[Path, Path] = {}
    backups: dict[Path, Path] = {}
    swapped: list[tuple[Path, Path]] = []
    preserved_backups: set[Path] = set()
    restore_cwd: Path | None = None
    try:
        archive = tmp / "companion.zip"
        package = tmp / "package"
        download_package(api_url, token, archive)
        with zipfile.ZipFile(archive) as zf:
            safe_extract_zip(zf, package)
        validate_companion_dir(package, available_version, require_folder_name=False, require_integrity=True)
        validate_official_package_hashes(package, official_files)

        for target in targets:
            staged[target] = _stage_companion_package(package, target, available_version, official_files)
            backup = Path(tempfile.mkdtemp(prefix=".companion-backup.", dir=str(target.parent)))
            backup.rmdir()
            backups[target] = backup

        # Revalidate immediately before mutation so a concurrent local edit cannot
        # slip between preflight and the transaction.
        for target in targets:
            _validate_update_target(target, available_version)

        restore_cwd = leave_target_cwds(targets)
        try:
            for target in targets:
                # Earlier targets may take time to swap. Recheck this exact target
                # at its mutation boundary so a concurrent edit or updater cannot
                # be overwritten based on the earlier bulk preflight.
                _validate_update_target(target, available_version)
                backup = backups[target]
                _swap_staged_target(target, staged[target], backup)
                swapped.append((target, backup))
        except BaseException:
            rollback_failures = _rollback_swaps(swapped)
            if rollback_failures:
                preserved_backups.update(backup for _target, backup, _error in rollback_failures)
                details = "; ".join(
                    f"{target}: {error}; original preserved at {backup}"
                    for target, backup, error in rollback_failures
                )
                fail("Companion multi-tool rollback failed: " + details)
            raise

        report = api_post_json(api_url, token, "/local-skills/companion/installed", {"version": available_version, "agent": agent})
        return {
            "applied": True,
            "version": available_version,
            "targets": [
                {"path": str(target), "version": available_version, "status": "installed"}
                for target in targets
            ],
            "backupPath": str(backups[targets[0]]),
            "backupPaths": [str(backups[target]) for target in targets],
            "backupDeleted": True,
            "report": report,
        }
    finally:
        if restore_cwd and restore_cwd.exists():
            os.chdir(restore_cwd)
        for target, staging in staged.items():
            if os.path.lexists(staging):
                remove_swap_path(staging)
            backup = backups.get(target)
            if backup and os.path.lexists(backup):
                if backup in preserved_backups:
                    continue
                if not os.path.lexists(target):
                    backup.rename(target)
                else:
                    remove_swap_path(backup)
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
    target_statuses = companion_target_statuses(skill_dir, local_skill, available_version)
    integrity_blocking_targets = [
        row
        for row in target_statuses
        if row.get("integrity") != "official" or row.get("blockingFiles")
    ]
    ahead_targets = [row for row in target_statuses if row.get("ahead")]
    if integrity_blocking_targets or ahead_targets:
        blocking_files = [
            f"{row['path']}:{path}"
            for row in integrity_blocking_targets
            for path in (row.get("blockingFiles") or ["integrity unavailable"])
        ]
        if integrity_blocking_targets:
            reason = (
                "local_customizations"
                if any(row.get("blockingFiles") for row in integrity_blocking_targets)
                else "integrity_unavailable"
            )
        else:
            reason = "local_version_ahead"
        return {
            "requested": True,
            "applied": False,
            "blocked": True,
            "reason": reason,
            "files": blocking_files,
            "aheadTargets": [
                {"path": row["path"], "version": row.get("version")}
                for row in ahead_targets
            ],
            "targets": target_statuses,
        }

    outdated_targets = [Path(row["path"]) for row in target_statuses if row.get("needsUpdate")]
    if not outdated_targets:
        return {
            "requested": True,
            "applied": False,
            "blocked": False,
            "reason": "current",
            "targets": target_statuses,
        }

    result = install_companion_update(
        api_url,
        token,
        skill_dir,
        available_version,
        agent,
        official_file_hashes(local_skill),
        target_dirs=outdated_targets,
    )
    result["requested"] = True
    return result
