#!/usr/bin/env python3
"""Non-replayable secret retrieval and secure local .env projections.

Plaintext exists only in the in-memory redemption response and the final mode-0600 projection. Local
state records opaque projection ids, slot ids, versions, keys, and paths, never values or grants.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import stat
import tempfile
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

from companion_lib import api_post_json, api_redeem_secret_plan, companion_home, load_json

try:  # Unix/macOS
    import fcntl
except ImportError:  # pragma: no cover - Windows fallback
    fcntl = None  # type: ignore[assignment]

try:  # Windows
    import msvcrt
except ImportError:  # pragma: no cover - Unix path
    msvcrt = None  # type: ignore[assignment]


SAFE_SEGMENT = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
SAFE_ENV_KEY = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def _safe_segment(value: str, label: str) -> str:
    if not SAFE_SEGMENT.fullmatch(value) or value in (".", ".."):
        raise ValueError(f"unsafe {label}")
    return value


def _ensure_secure_dir(path: Path) -> Path:
    """Create a private directory tree and refuse any existing symlink component."""
    path = path.expanduser()
    home = companion_home().expanduser()
    home.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(home, 0o700)
    try:
        relative = path.relative_to(home)
    except ValueError as exc:
        raise ValueError("secret projection path escapes Companion home") from exc
    current = home
    for part in relative.parts:
        # `_manual` is the one fixed internal namespace. User-controlled workspace,
        # skill and profile segments are validated before this helper is called.
        if part != "_manual":
            _safe_segment(part, "projection path")
        current = current / part
        if os.path.lexists(current):
            mode = os.lstat(current).st_mode
            if stat.S_ISLNK(mode) or not stat.S_ISDIR(mode):
                raise ValueError("secret projection path contains a symlink or non-directory")
        else:
            # Another local sync may create the same component between lexists and mkdir.
            current.mkdir(mode=0o700, exist_ok=True)
            mode = os.lstat(current).st_mode
            if stat.S_ISLNK(mode) or not stat.S_ISDIR(mode):
                raise ValueError("secret projection path contains a symlink or non-directory")
        os.chmod(current, 0o700)
    return current


def projection_dir(workspace_id: str, skill: str) -> Path:
    workspace = _safe_segment(workspace_id, "workspace id")
    if skill.startswith("_manual/"):
        profile = _safe_segment(skill.split("/", 1)[1], "manual profile")
        return _ensure_secure_dir(companion_home() / "secrets" / workspace / "_manual" / profile)
    return _ensure_secure_dir(companion_home() / "secrets" / workspace / _safe_segment(skill, "skill slug"))


@contextmanager
def projection_lock(directory: Path) -> Iterator[None]:
    lock_path = directory / ".lock"
    flags = os.O_RDWR | os.O_CREAT
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    fd = os.open(lock_path, flags, 0o600)
    os.chmod(lock_path, 0o600)
    try:
        if fcntl is not None:
            fcntl.flock(fd, fcntl.LOCK_EX)
        elif msvcrt is not None:  # pragma: no cover - Windows
            msvcrt.locking(fd, msvcrt.LK_LOCK, 1)
        yield
    finally:
        if fcntl is not None:
            fcntl.flock(fd, fcntl.LOCK_UN)
        elif msvcrt is not None:  # pragma: no cover - Windows
            msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
        os.close(fd)


def dotenv_quote(value: str) -> str:
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"').replace("\r", "\\r").replace("\n", "\\n") + '"'


def render_projection(items: list[dict[str, Any]]) -> bytes:
    lines: list[str] = []
    seen: set[str] = set()
    for item in sorted(items, key=lambda row: str(row.get("env_key") or "")):
        key = str(item.get("env_key") or "")
        if not SAFE_ENV_KEY.fullmatch(key) or key in seen:
            raise ValueError("redemption contains an invalid or duplicate environment key")
        value = item.get("value")
        if not isinstance(value, str):
            raise ValueError("redemption is missing a secret value")
        seen.add(key)
        lines.append(f"{key}={dotenv_quote(value)}")
    return (("\n".join(lines) + "\n") if lines else "").encode("utf-8")


def _atomic_private_write(path: Path, content: bytes) -> None:
    directory = _ensure_secure_dir(path.parent)
    if os.path.lexists(path) and stat.S_ISLNK(os.lstat(path).st_mode):
        raise ValueError("refusing to replace a symlinked secret projection")
    fd, temp_name = tempfile.mkstemp(prefix=f".{path.name}.staging.", dir=str(directory))
    temp_path = Path(temp_name)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "wb", closefd=True) as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_path, path)
        os.chmod(path, 0o600)
        dir_fd = os.open(directory, os.O_RDONLY)
        try:
            os.fsync(dir_fd)
        finally:
            os.close(dir_fd)
    finally:
        if os.path.lexists(temp_path):
            temp_path.unlink()


def write_projection(workspace_id: str, skill: str, items: list[dict[str, Any]]) -> Path:
    directory = projection_dir(workspace_id, skill)
    path = directory / ".env"
    content = render_projection(items)
    with projection_lock(directory):
        marker = directory / ".transaction.json"
        if marker.exists():
            _recover_transaction(marker)
        _atomic_private_write(path, content)
    return path


def _remove_any(path: Path) -> None:
    if not os.path.lexists(path):
        return
    if path.is_symlink() or path.is_file():
        path.unlink()
    else:
        shutil.rmtree(path)


def _recover_transaction(marker: Path) -> None:
    payload = load_json(marker)
    if not isinstance(payload, dict):
        _remove_any(marker)
        return
    for row in reversed(payload.get("targets", [])):
        if not isinstance(row, dict):
            continue
        if not all(isinstance(row.get(key), str) and row.get(key) for key in ("target", "backup", "staging")):
            continue
        target = Path(row["target"])
        backup = Path(row["backup"])
        staging = Path(row["staging"])
        if os.path.lexists(backup):
            _remove_any(target)
            backup.rename(target)
        elif not row.get("existed") and os.path.lexists(target):
            _remove_any(target)
        _remove_any(staging)
    env_values = [payload.get("envPath"), payload.get("envBackup"), payload.get("envStaging")]
    if all(isinstance(value, str) and value for value in env_values):
        env_path, env_backup, env_staging = (Path(value) for value in env_values)
        if os.path.lexists(env_backup):
            _remove_any(env_path)
            env_backup.rename(env_path)
        elif not payload.get("envExisted") and os.path.lexists(env_path):
            _remove_any(env_path)
        _remove_any(env_staging)
    _remove_any(marker)


def recover_pending_transactions(workspace_id: str) -> None:
    """Restore every interrupted package/projection swap before the next secrets operation."""
    root = _ensure_secure_dir(companion_home() / "secrets" / _safe_segment(workspace_id, "workspace"))
    for current, directories, files in os.walk(root, topdown=True, followlinks=False):
        # Never traverse a link planted anywhere below the private workspace directory.
        directories[:] = [
            name
            for name in directories
            if not stat.S_ISLNK(os.lstat(Path(current) / name).st_mode)
        ]
        if ".transaction.json" not in files:
            continue
        directory = Path(current)
        marker = directory / ".transaction.json"
        with projection_lock(directory):
            if marker.exists():
                _recover_transaction(marker)


def deploy_packages_with_projection(
    package_dir: Path,
    target_dirs: list[Path],
    workspace_id: str,
    skill: str,
    items: list[dict[str, Any]],
    remove_projection_if_empty: bool = False,
) -> Path:
    """Swap all package targets and one projection as a rollback-safe transaction.

    Every staging path is created on the destination filesystem. A private marker lets the next
    attempt restore backups after a process crash; normal exceptions roll back immediately.
    """
    directory = projection_dir(workspace_id, skill)
    env_path = directory / ".env"
    marker = directory / ".transaction.json"
    target_rows: list[dict[str, Any]] = []
    env_fd, env_staging_name = tempfile.mkstemp(prefix="..env.staging.", dir=str(directory))
    env_staging = Path(env_staging_name)
    os.fchmod(env_fd, 0o600)
    with os.fdopen(env_fd, "wb", closefd=True) as handle:
        handle.write(render_projection(items))
        handle.flush()
        os.fsync(handle.fileno())
    env_backup = directory / f"..env.backup.{uuid.uuid4().hex}"

    try:
        for target in target_dirs:
            target.parent.mkdir(parents=True, exist_ok=True)
            staging = Path(tempfile.mkdtemp(prefix=f".{target.name}.companion-staging.", dir=str(target.parent)))
            shutil.rmtree(staging)
            shutil.copytree(package_dir, staging)
            backup = target.parent / f".{target.name}.companion-backup.{uuid.uuid4().hex}"
            target_rows.append({"target": str(target), "staging": str(staging), "backup": str(backup), "existed": os.path.lexists(target)})

        with projection_lock(directory):
            if marker.exists():
                _recover_transaction(marker)
            payload = {
                "targets": target_rows,
                "envPath": str(env_path),
                "envStaging": str(env_staging),
                "envBackup": str(env_backup),
                "envExisted": os.path.lexists(env_path),
            }
            _atomic_private_write(marker, (json.dumps(payload, sort_keys=True) + "\n").encode("utf-8"))
            try:
                for row in target_rows:
                    target = Path(row["target"])
                    backup = Path(row["backup"])
                    staging = Path(row["staging"])
                    if os.path.lexists(target):
                        target.rename(backup)
                    staging.rename(target)
                if os.path.lexists(env_path):
                    if stat.S_ISLNK(os.lstat(env_path).st_mode):
                        raise ValueError("refusing to replace a symlinked secret projection")
                    env_path.rename(env_backup)
                if remove_projection_if_empty and not items:
                    _remove_any(env_staging)
                else:
                    env_staging.rename(env_path)
                    os.chmod(env_path, 0o600)
            except BaseException:
                _recover_transaction(marker)
                raise
            for row in target_rows:
                _remove_any(Path(row["backup"]))
            _remove_any(env_backup)
            _remove_any(marker)
        return env_path
    finally:
        for row in target_rows:
            _remove_any(Path(row["staging"]))
            # A backup is only safe to delete when its target exists (normal committed state).
            backup = Path(row["backup"])
            target = Path(row["target"])
            if os.path.lexists(backup) and os.path.lexists(target):
                _remove_any(backup)
        _remove_any(env_staging)


def remove_projection(workspace_id: str, skill: str) -> Path:
    directory = projection_dir(workspace_id, skill)
    path = directory / ".env"
    with projection_lock(directory):
        marker = directory / ".transaction.json"
        if marker.exists():
            _recover_transaction(marker)
        if os.path.lexists(path):
            if stat.S_ISLNK(os.lstat(path).st_mode):
                raise ValueError("refusing to remove a symlinked secret projection")
            path.unlink()
    return path


def preflight_skills(api_url: str, token: str, skills: list[dict[str, str]], operation_id: str | None = None) -> dict[str, Any]:
    return api_post_json(
        api_url,
        token,
        "/secret-retrievals/preflight",
        {"operation_id": operation_id or str(uuid.uuid4()), "skills": skills, "direct": []},
    )


def preflight_manual(api_url: str, token: str, secret_id: str, env_key: str, profile: str, operation_id: str | None = None) -> dict[str, Any]:
    _safe_segment(profile, "manual profile")
    if not SAFE_ENV_KEY.fullmatch(env_key):
        raise ValueError("invalid environment key")
    return api_post_json(
        api_url,
        token,
        "/secret-retrievals/preflight",
        {"operation_id": operation_id or str(uuid.uuid4()), "skills": [], "direct": [{"secret_id": secret_id, "env_key": env_key, "profile": profile}]},
    )


def redeem_plan(api_url: str, token: str, plan_id: str) -> dict[str, Any]:
    return api_redeem_secret_plan(api_url, token, plan_id)


def state_path() -> Path:
    return companion_home() / "secrets" / "state.json"


def update_projection_state(workspace_id: str, redeemed: dict[str, Any], paths: dict[str, Path]) -> None:
    root = _ensure_secure_dir(companion_home() / "secrets")
    path = state_path()
    # All skills share one value-free state file, so serialize read/merge/write as well as each .env.
    with projection_lock(root):
        current = load_json(path) or {"schemaVersion": 1, "workspaces": {}}
        workspaces = current.setdefault("workspaces", {})
        workspace = workspaces.setdefault(workspace_id, {"projections": {}})
        projections = workspace.setdefault("projections", {})
        for tombstone in redeemed.get("tombstones", []) if isinstance(redeemed, dict) else []:
            if isinstance(tombstone, dict) and tombstone.get("projection_id"):
                projections.pop(str(tombstone["projection_id"]), None)
        for item in redeemed.get("items", []) if isinstance(redeemed, dict) else []:
            if not isinstance(item, dict) or not item.get("projection_id"):
                continue
            skill = str(item.get("skill") or "")
            projections[str(item["projection_id"])] = {
                "skill": skill,
                "slotId": item.get("slot_id"),
                "secretVersion": item.get("secret_version"),
                "envKey": item.get("env_key"),
                "projectionId": item.get("projection_id"),
                "path": str(paths.get(skill) or ""),
            }
        _atomic_private_write(path, (json.dumps(current, indent=2, sort_keys=True) + "\n").encode("utf-8"))
    os.chmod(root, 0o700)


def apply_redeemed_projections(workspace_id: str, redeemed: dict[str, Any]) -> dict[str, Path]:
    recover_pending_transactions(workspace_id)
    grouped: dict[str, list[dict[str, Any]]] = {}
    for item in redeemed.get("items", []) if isinstance(redeemed, dict) else []:
        if isinstance(item, dict):
            grouped.setdefault(str(item.get("skill") or ""), []).append(item)
    tombstone_skills = {
        str(item.get("skill") or "")
        for item in (redeemed.get("tombstones", []) if isinstance(redeemed, dict) else [])
        if isinstance(item, dict)
    }
    paths: dict[str, Path] = {}
    for skill in sorted(grouped):
        paths[skill] = write_projection(workspace_id, skill, grouped[skill])
    for skill in sorted(tombstone_skills - grouped.keys()):
        paths[skill] = remove_projection(workspace_id, skill)
    update_projection_state(workspace_id, redeemed, paths)
    return paths


def redacted_preflight(preflight: dict[str, Any]) -> dict[str, Any]:
    """Return the confirmation-safe server plan (it contains metadata only by contract)."""
    return {
        "planId": preflight.get("plan_id"),
        "expiresAt": preflight.get("expires_at"),
        "blockers": preflight.get("blockers", 0),
        "warnings": preflight.get("warnings", 0),
        "items": preflight.get("items", []),
        "tombstones": preflight.get("tombstones", []),
    }
