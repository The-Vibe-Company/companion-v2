#!/usr/bin/env python3
"""Discover untracked local skills for Companion's guided onboarding.

The scan is intentionally bounded to the three agent roots declared by tools.json
for the current user and current project. It never searches parent projects or
the rest of the filesystem.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import stat
from typing import Any

import companion_lib

ONBOARDING_TOOLS = ("claude-code", "codex", "opencode")
COMPANION_SLUG = "companion"
COMPANION_MANIFEST = Path(__file__).resolve().parent.parent / "companion.json"
MAX_SKILL_FILES = 2_000
MAX_SKILL_ENTRIES = 4_000
MAX_REGISTRY_ENTRIES = 5_000
MAX_SKILL_TOTAL_BYTES = 64 * 1024 * 1024
MAX_SKILL_FILE_BYTES = 16 * 1024 * 1024
MAX_SKILL_DEPTH = 16
READ_CHUNK_BYTES = 1024 * 1024


class ScanLimitError(ValueError):
    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


class UnsafeSkillDirectory(ValueError):
    pass


def _absolute(path: Path) -> Path:
    return Path(os.path.abspath(str(path.expanduser())))


def _absolute_project_arg(raw: str) -> Path:
    path = Path(raw).expanduser()
    if not path.is_absolute():
        raise argparse.ArgumentTypeError("--project must be an absolute project or workspace root")
    return path


def _candidate_slug(path: Path) -> tuple[str, str | None]:
    manifest = companion_lib.load_json(path / "companion.json")
    if isinstance(manifest, dict):
        name = manifest.get("name")
        metadata = manifest.get("metadata")
        skill_id = metadata.get("companionSkillId") if isinstance(metadata, dict) else None
        if isinstance(name, str) and name.strip():
            return name.strip(), str(skill_id) if skill_id else None

    skill_md = path / "SKILL.md"
    try:
        for line in skill_md.read_text(encoding="utf-8").splitlines()[:40]:
            if line.startswith("name:"):
                name = line.partition(":")[2].strip().strip("\"'")
                if name:
                    return name, None
    except (OSError, UnicodeError):
        pass
    return path.name, None


def _bundled_companion_skill_id() -> str | None:
    manifest = companion_lib.load_json(COMPANION_MANIFEST)
    if not isinstance(manifest, dict):
        return None
    metadata = manifest.get("metadata")
    if not isinstance(metadata, dict):
        return None
    skill_id = metadata.get("companionSkillId")
    return str(skill_id) if skill_id else None


def _bounded_skill_files(path: Path, root: Path) -> list[tuple[str, Path, int]]:
    """Return a safe, deterministic manifest without walking or buffering unbounded trees."""
    try:
        physical_root = root.resolve(strict=True)
        if root.is_symlink() or path.is_symlink() or not path.is_dir():
            raise UnsafeSkillDirectory("symbolic or missing skill directory")
        physical_path = path.resolve(strict=True)
        if physical_path != physical_root and physical_root not in physical_path.parents:
            raise UnsafeSkillDirectory("skill directory escapes its registry root")
    except OSError as exc:
        raise UnsafeSkillDirectory("skill directory cannot be resolved") from exc

    files: list[tuple[str, Path, int]] = []
    entry_count = 0
    total_bytes = 0
    pending = [(path, 0)]
    while pending:
        current, depth = pending.pop()
        if depth > MAX_SKILL_DEPTH:
            raise ScanLimitError("depth_limit")
        try:
            with os.scandir(current) as iterator:
                entries = []
                for entry in iterator:
                    entry_count += 1
                    if entry_count > MAX_SKILL_ENTRIES:
                        raise ScanLimitError("entry_count_limit")
                    entries.append(entry)
            entries.sort(key=lambda entry: entry.name)
        except OSError as exc:
            raise UnsafeSkillDirectory("skill directory cannot be read") from exc
        for entry in entries:
            if entry.is_symlink():
                raise UnsafeSkillDirectory("symbolic links are not scanned")
            try:
                entry_stat = entry.stat(follow_symlinks=False)
            except OSError as exc:
                raise UnsafeSkillDirectory("skill entry cannot be inspected") from exc
            entry_path = Path(entry.path)
            if stat.S_ISDIR(entry_stat.st_mode):
                pending.append((entry_path, depth + 1))
                continue
            if not stat.S_ISREG(entry_stat.st_mode):
                raise UnsafeSkillDirectory("non-regular files are not scanned")
            if entry_stat.st_size > MAX_SKILL_FILE_BYTES:
                raise ScanLimitError("file_size_limit")
            total_bytes += entry_stat.st_size
            if total_bytes > MAX_SKILL_TOTAL_BYTES:
                raise ScanLimitError("total_size_limit")
            files.append((entry_path.relative_to(path).as_posix(), entry_path, entry_stat.st_size))
            if len(files) > MAX_SKILL_FILES:
                raise ScanLimitError("file_count_limit")
    return sorted(files, key=lambda row: row[0])


def _bounded_registry_children(root: Path) -> list[Path]:
    """Keep a maliciously wide tool registry root from being materialized unboundedly."""
    try:
        with os.scandir(root) as iterator:
            children = []
            for entry in iterator:
                if len(children) >= MAX_REGISTRY_ENTRIES:
                    raise ScanLimitError("registry_entry_limit")
                children.append(Path(entry.path))
    except OSError as exc:
        raise UnsafeSkillDirectory("registry root cannot be read") from exc
    return sorted(children, key=lambda item: item.name)


def _bounded_dir_checksum(path: Path, root: Path) -> str:
    """Match compute_dir_checksum for normal packages while enforcing onboarding scan limits."""
    digest = hashlib.sha256()
    total_read = 0
    for relative_path, file_path, expected_size in _bounded_skill_files(path, root):
        digest.update(relative_path.encode("utf-8"))
        digest.update(b"\0")
        flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
        try:
            descriptor = os.open(file_path, flags)
        except OSError as exc:
            raise UnsafeSkillDirectory("skill file cannot be opened safely") from exc
        try:
            opened_stat = os.fstat(descriptor)
            if not stat.S_ISREG(opened_stat.st_mode) or opened_stat.st_size != expected_size:
                raise UnsafeSkillDirectory("skill file changed during the scan")
            while True:
                chunk = os.read(descriptor, READ_CHUNK_BYTES)
                if not chunk:
                    break
                total_read += len(chunk)
                if total_read > MAX_SKILL_TOTAL_BYTES:
                    raise ScanLimitError("total_size_limit")
                digest.update(chunk)
        finally:
            os.close(descriptor)
        digest.update(b"\0")
    return f"sha256:{digest.hexdigest()}"


def registry_roots(
    registry: dict[str, Any],
    *,
    home: Path,
    project_root: Path,
) -> list[tuple[str, str, Path]]:
    roots: list[tuple[str, str, Path]] = []
    for tool in ONBOARDING_TOOLS:
        spec = registry.get(tool)
        if not isinstance(spec, dict):
            continue
        dirs = spec.get("skillsDir")
        if not isinstance(dirs, dict):
            continue
        user_dir = dirs.get("user")
        project_dir = dirs.get("project")
        if isinstance(user_dir, str):
            expanded = user_dir.replace("~", str(home), 1) if user_dir.startswith("~") else user_dir
            roots.append((tool, "user", _absolute(Path(expanded))))
        if isinstance(project_dir, str):
            roots.append((tool, "project", _absolute(project_root / project_dir)))
    return roots


def _all_lock_records(path: Path) -> list[dict[str, Any]]:
    raw = companion_lib.load_json(path)
    if not isinstance(raw, dict):
        return []
    records: list[dict[str, Any]] = []
    workspaces = raw.get("workspaces")
    if isinstance(workspaces, dict):
        for entry in workspaces.values():
            if isinstance(entry, dict):
                records.extend(companion_lib.skill_records_from_lock(entry))
        return records
    return companion_lib.skill_records_from_lock(raw)


def _tracked_inventory(
    lockfiles: list[tuple[Path, Path | None]],
) -> tuple[set[Path], set[tuple[str, str]]]:
    paths: set[Path] = set()
    slug_checksums: set[tuple[str, str]] = set()
    for lockfile, relative_to in lockfiles:
        for record in _all_lock_records(lockfile):
            slug = str(record.get("slug") or record.get("name") or "")
            record_checksum = record.get("checksum")
            if slug and isinstance(record_checksum, str):
                slug_checksums.add((slug, record_checksum))
            for target in record.get("targets") or []:
                target_path = target.get("path")
                if isinstance(target_path, str) and target_path:
                    expanded = Path(target_path).expanduser()
                    if relative_to is not None and not expanded.is_absolute():
                        expanded = relative_to / expanded
                    paths.add(_absolute(expanded))
                checksum = target.get("checksum")
                if slug and isinstance(checksum, str):
                    slug_checksums.add((slug, checksum))
    return paths, slug_checksums


def scan(
    *,
    registry_path: Path,
    home: Path,
    project_root: Path,
    user_lockfile: Path,
    project_lockfile: Path,
    companion_skill_id: str | None = None,
) -> dict[str, Any]:
    registry = companion_lib.load_tool_registry(registry_path)
    tracked_paths, tracked_slug_checksums = _tracked_inventory(
        [(user_lockfile, None), (project_lockfile, project_root)]
    )
    grouped: dict[tuple[str, str], list[dict[str, str]]] = {}
    blocked: list[dict[str, Any]] = []

    for tool, scope, root in registry_roots(registry, home=home, project_root=project_root):
        if not root.is_dir() or root.is_symlink():
            continue
        try:
            root_children = _bounded_registry_children(root)
        except ScanLimitError as exc:
            blocked.append(
                {
                    "slug": root.name,
                    "copies": [{
                        "tool": tool,
                        "scope": scope,
                        "path": str(root),
                    }],
                    "status": "blocked",
                    "reason": exc.reason,
                }
            )
            continue
        except UnsafeSkillDirectory:
            continue
        for path in root_children:
            if not (path / "SKILL.md").is_file():
                continue
            try:
                checksum = _bounded_dir_checksum(path, root)
            except ScanLimitError as exc:
                blocked.append(
                    {
                        "slug": path.name,
                        "copies": [{
                            "tool": tool,
                            "scope": scope,
                            "path": str(_absolute(path)),
                        }],
                        "status": "blocked",
                        "reason": exc.reason,
                    }
                )
                continue
            except UnsafeSkillDirectory:
                continue
            slug, manifest_skill_id = _candidate_slug(path)
            if slug == COMPANION_SLUG or (
                companion_skill_id and manifest_skill_id == companion_skill_id
            ):
                continue
            absolute_path = _absolute(path)
            if absolute_path in tracked_paths or (slug, checksum) in tracked_slug_checksums:
                continue
            grouped.setdefault((slug, checksum), []).append(
                {
                    "tool": tool,
                    "scope": scope,
                    "path": str(absolute_path),
                }
            )

    checksums_by_slug: dict[str, set[str]] = {}
    for slug, checksum in grouped:
        checksums_by_slug.setdefault(slug, set()).add(checksum)

    candidates = [
        {
            "slug": slug,
            "checksum": checksum,
            "copies": sorted(copies, key=lambda row: (row["tool"], row["scope"], row["path"])),
            "status": "conflict" if len(checksums_by_slug[slug]) > 1 else "candidate",
        }
        for (slug, checksum), copies in grouped.items()
    ]
    candidates.sort(key=lambda row: (row["slug"], row["checksum"]))
    blocked.sort(key=lambda row: (row["slug"], row["copies"][0]["path"]))
    return {"candidates": candidates, "blocked": blocked}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--project",
        type=_absolute_project_arg,
        required=True,
        help="absolute root of the user's current project or workspace",
    )
    parser.add_argument("--home", type=Path, default=Path.home())
    parser.add_argument("--registry", type=Path, default=companion_lib.tool_registry_path())
    parser.add_argument("--user-lockfile", type=Path)
    parser.add_argument("--project-lockfile", type=Path)
    parser.add_argument("--companion-skill-id")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    project_root = _absolute(args.project)
    home = _absolute(args.home)
    result = scan(
        registry_path=args.registry,
        home=home,
        project_root=project_root,
        user_lockfile=args.user_lockfile or home / ".companion" / "skills.lock.json",
        project_lockfile=args.project_lockfile
        or project_root / ".companion" / "skills.lock.json",
        companion_skill_id=args.companion_skill_id or _bundled_companion_skill_id(),
    )
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
