#!/usr/bin/env python3
"""Integrity helpers for the local Companion bootstrap."""

from __future__ import annotations

import json
import re
from hashlib import sha256
from pathlib import Path
from typing import Any

from companion_lib import fail

INTEGRITY_BASELINE_FILE = "companion.integrity.json"
SHA256_DIGEST_RE = re.compile(r"^sha256:[0-9a-f]{64}$")


def sha256_file(path: Path) -> str:
    h = sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            h.update(chunk)
    return f"sha256:{h.hexdigest()}"


def read_json(path: Path) -> dict[str, Any] | None:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None
    except json.JSONDecodeError:
        return None
    return value if isinstance(value, dict) else None


def is_safe_integrity_path(value: str) -> bool:
    parts = value.split("/")
    return (
        bool(value)
        and not value.startswith(("/", "\\"))
        and "\\" not in value
        and all(part and part not in {".", ".."} for part in parts)
    )


def is_sha256_digest(value: str) -> bool:
    return bool(SHA256_DIGEST_RE.match(value))


def local_companion_version(skill_dir: Path) -> str | None:
    manifest = read_json(skill_dir / "companion.json")
    version = manifest.get("version") if manifest else None
    return str(version) if version else None


def official_file_hashes(local_skill: dict[str, Any]) -> dict[str, str]:
    integrity = local_skill.get("integrity")
    if not isinstance(integrity, dict):
        return {}
    files = integrity.get("files")
    if not isinstance(files, dict):
        return {}
    return {
        path: digest
        for path, digest in files.items()
        if isinstance(path, str) and isinstance(digest, str) and is_safe_integrity_path(path) and is_sha256_digest(digest)
    }


def local_integrity_baseline(skill_dir: Path, local_version: str | None) -> tuple[dict[str, str], str | None, bool]:
    baseline_path = skill_dir / INTEGRITY_BASELINE_FILE
    baseline_exists = baseline_path.exists()
    baseline = read_json(baseline_path)
    if not baseline:
        return {}, "local-baseline-invalid" if baseline_exists else None, baseline_exists
    if local_version and baseline.get("version") != local_version:
        return {}, "local-baseline-version-mismatch", True
    files = baseline.get("files")
    if not isinstance(files, dict):
        return {}, "local-baseline-invalid", True
    hashes = {}
    for path, digest in files.items():
        if not isinstance(path, str) or not isinstance(digest, str) or not is_safe_integrity_path(path) or not is_sha256_digest(digest):
            return {}, "local-baseline-invalid", True
        hashes[path] = digest
    return hashes, "local-baseline", True


def expected_integrity(skill_dir: Path, local_skill: dict[str, Any]) -> tuple[dict[str, str], str, bool]:
    local_version = local_companion_version(skill_dir)
    available_version = local_skill.get("availableVersion")
    baseline, source, baseline_present = local_integrity_baseline(skill_dir, local_version)
    if baseline:
        return baseline, source or "local-baseline", True
    if baseline_present:
        return {}, source or "local-baseline-invalid", True
    if local_version and available_version and local_version == available_version:
        official = official_file_hashes(local_skill)
        if official:
            return official, "workspace-current", True
    return {}, "unavailable", False


def compare_integrity(skill_dir: Path, local_skill: dict[str, Any]) -> dict[str, Any]:
    official, source, comparable = expected_integrity(skill_dir, local_skill)
    paths = sorted(official.keys())
    files: list[dict[str, Any]] = []
    counts = {"official": 0, "modified": 0, "missing": 0, "unknown": 0}

    for rel_path in paths:
        expected = official.get(rel_path)
        target = skill_dir / rel_path
        if not target.exists():
            status = "missing" if expected else "unknown"
            actual = None
        else:
            actual = sha256_file(target)
            status = "unknown" if not expected else ("official" if actual == expected else "modified")
        counts[status] += 1
        files.append({"path": rel_path, "status": status, "expected": expected, "actual": actual})

    blocking = [row["path"] for row in files if row["status"] in {"modified", "missing"}]
    return {
        "status": "customized" if blocking else ("unknown" if counts["unknown"] or not paths else "official"),
        "blockingFiles": blocking,
        "files": files,
        "counts": counts,
        "packageChecksum": (local_skill.get("integrity") or {}).get("packageChecksum") if isinstance(local_skill.get("integrity"), dict) else None,
        "source": source,
        "comparable": comparable,
    }


def validate_integrity_baseline(path: Path, expected_version: str) -> None:
    baseline = read_json(path / INTEGRITY_BASELINE_FILE)
    if not baseline:
        fail(f"{path / INTEGRITY_BASELINE_FILE} is missing or invalid")
    if baseline.get("version") != expected_version:
        fail(f"{path / INTEGRITY_BASELINE_FILE} version {baseline.get('version') or 'missing'} does not match {expected_version}")
    files = baseline.get("files")
    if not isinstance(files, dict) or not files:
        fail(f"{path / INTEGRITY_BASELINE_FILE} files must be a non-empty object")
    mismatched = []
    for rel_path, expected in sorted(files.items()):
        if not isinstance(rel_path, str) or not is_safe_integrity_path(rel_path):
            fail(f"{path / INTEGRITY_BASELINE_FILE} contains an unsafe path: {rel_path}")
        if not isinstance(expected, str) or not is_sha256_digest(expected):
            fail(f"{path / INTEGRITY_BASELINE_FILE} contains an invalid digest for: {rel_path}")
        target = path / rel_path
        if not target.exists() or sha256_file(target) != expected:
            mismatched.append(rel_path)
    if mismatched:
        fail(f"{path / INTEGRITY_BASELINE_FILE} does not match package files: {', '.join(mismatched)}")


def validate_official_package_hashes(path: Path, official_files: dict[str, str]) -> None:
    if not official_files:
        fail("workspace did not provide official Companion integrity hashes")
    mismatched = []
    for rel_path, expected in sorted(official_files.items()):
        if not isinstance(rel_path, str) or not is_safe_integrity_path(rel_path):
            fail(f"workspace provided an unsafe integrity path: {rel_path}")
        if not isinstance(expected, str) or not is_sha256_digest(expected):
            fail(f"workspace provided an invalid integrity digest for: {rel_path}")
        target = path / rel_path
        if not target.exists() or sha256_file(target) != expected:
            mismatched.append(rel_path)
    if mismatched:
        fail(f"downloaded Companion package does not match workspace integrity hashes: {', '.join(mismatched)}")
