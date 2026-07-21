#!/usr/bin/env python3
"""Install (or update) a published workspace skill into every local tool at once.

This is the deterministic fan-out behind multi-tool installs. Given a skill slug it downloads the
package once and deploys it into each configured tool (Claude Code, Codex, OpenCode, …) at the requested
scope (user-global and/or the current project), then records every install location in the right
lockfile so updates and audits stay tool-aware:

  - user-scope targets   -> ~/.companion/skills.lock.json
  - project-scope targets -> <repo>/.companion/skills.lock.json  (one per project)

The tool set comes from ~/.companion/config.json (see `detect_tools`), overridable with --tools.
A target whose on-disk folder was locally customized (its checksum diverges from the lockfile) is
skipped unless --force, so a multi-tool update never clobbers local edits. The aggregate install
report (POST /skills/:slug/install) stays a single call; pass --report to send it from here.
"""

from __future__ import annotations

import argparse
import io
import itertools
import json
import os
import shutil
import sys
import tempfile
import zipfile
from pathlib import Path
from typing import Any

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from companion_lib import (  # noqa: E402
    api_download_bytes,
    api_get,
    compute_dir_checksum,
    config_path,
    detect_tools,
    fail,
    find_project_root,
    load_json,
    load_tool_config,
    load_tool_registry,
    lockfile_path,
    normalize_targets,
    project_lockfile_path,
    resolve_additional_discovery_dirs,
    remove_skill_lock_targets,
    resolve_credentials,
    resolve_target_dir,
    upsert_skill_lock_record,
    workspace_lock_entry,
)
from secrets_runtime import (  # noqa: E402
    deploy_packages_with_projection,
    preflight_skills,
    recover_pending_transactions,
    redacted_preflight,
    redeem_plan,
    update_projection_state,
)

import urllib.error  # noqa: E402
import urllib.parse  # noqa: E402
import urllib.request  # noqa: E402


def api_quote(value: str) -> str:
    return urllib.parse.quote(str(value), safe="")


def extract_package(zip_bytes: bytes, dest: Path) -> Path:
    """Extract a skill zip into `dest` and return the folder that holds SKILL.md at its root.

    Validates every member stays under `dest` first: a package is untrusted content, so a crafted entry
    like ``../../.ssh/config`` or an absolute path must never escape the extraction directory (zip-slip).
    """
    dest = dest.resolve()
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as archive:
        for member in archive.namelist():
            resolved = (dest / member).resolve()
            if resolved != dest and dest not in resolved.parents:
                fail(f"refusing package with unsafe path entry: {member!r}")
        archive.extractall(dest)
    if (dest / "SKILL.md").exists():
        return dest
    # Some archives wrap everything in a single top-level folder.
    children = [child for child in dest.iterdir() if child.is_dir()]
    for child in children:
        if (child / "SKILL.md").exists():
            return child
    fail("downloaded package has no SKILL.md at its root")


def remove_swap_path(path: Path) -> None:
    """Remove a transient swap path whether it is a directory, file, or symlink."""
    if not os.path.lexists(path):
        return
    if path.is_symlink() or path.is_file():
        path.unlink()
        return
    shutil.rmtree(path)


def deploy_to_target(package_dir: Path, target_dir: Path) -> None:
    """Replace `target_dir` with a fresh copy of the package using transient swap folders.

    The backup folder exists only during the swap. It is restored if the new folder fails to land, and
    otherwise deleted before this function returns so local skill scanners never discover stale copies.
    """
    target_dir.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=f".{target_dir.name}.companion-staging.", dir=str(target_dir.parent)))
    shutil.rmtree(staging)
    backup = Path(tempfile.mkdtemp(prefix=f".{target_dir.name}.companion-backup.", dir=str(target_dir.parent)))
    backup.rmdir()
    try:
        shutil.copytree(package_dir, staging)
        if target_dir.exists():
            target_dir.rename(backup)
        try:
            staging.rename(target_dir)
        except OSError:
            if backup.exists() and not target_dir.exists():
                backup.rename(target_dir)  # restore the previous folder
            raise
    finally:
        if os.path.lexists(staging):
            remove_swap_path(staging)
        if os.path.lexists(backup):
            if not target_dir.exists():
                backup.rename(target_dir)
            else:
                remove_swap_path(backup)


def plan_target_tools(tools: list[str], registry: dict[str, Any]) -> list[str]:
    """Choose the smallest install-root set that covers every requested tool exactly once.

    Some agents intentionally discover another agent's compatible skill directory. Installing into
    every configured root would therefore surface the same skill name twice. The registry's
    ``discovers`` matrix lets the planner reuse one physical copy without losing tool coverage.
    """
    requested = list(dict.fromkeys(tools))
    for tool in requested:
        discovered = registry[tool].get("discovers") or [tool]
        unknown = [key for key in discovered if key not in registry]
        if unknown:
            fail(f"tool {tool!r} discovers unknown install target(s): {', '.join(unknown)}")

    for size in range(1, len(requested) + 1):
        for candidate in itertools.combinations(requested, size):
            if all(
                len(set(candidate).intersection(registry[tool].get("discovers") or [tool])) == 1
                for tool in requested
            ):
                return list(candidate)
    fail("configured tools have no duplicate-free skill install plan; update scripts/tools.json discovery metadata")


def plan_targets(
    tools: list[str],
    scopes: list[str],
    project_root: Path | None,
    registry: dict[str, Any],
) -> list[tuple[str, str]]:
    target_tools = plan_target_tools(tools, registry)
    plan: list[tuple[str, str]] = []
    for scope in scopes:
        if scope == "project" and project_root is None:
            fail("project scope requested but no project root was found (run inside a repo or pass --project)")
        for tool in target_tools:
            plan.append((tool, scope))
    return plan


def duplicate_target_tools(tools: list[str], planned_tools: list[str], registry: dict[str, Any]) -> list[str]:
    """Return discoverable install roots that would create a second visible copy."""
    discovered = {
        target
        for tool in tools
        for target in (registry[tool].get("discovers") or [tool])
    }
    return [tool for tool in registry if tool in discovered and tool not in set(planned_tools)]


def normalized_target_path(path: str | Path, project_root: Path | None) -> Path:
    """Return an absolute lexical path without following symlinks."""
    candidate = Path(path).expanduser()
    if not candidate.is_absolute():
        if project_root is None:
            return candidate
        candidate = project_root / candidate
    return Path(os.path.abspath(os.path.normpath(str(candidate))))


def physical_target_path(path: str | Path) -> Path:
    """Resolve existing parent symlinks so two lexical roots cannot alias the same folder."""
    return Path(path).expanduser().resolve(strict=False)


def existing_target(
    lock_records: dict[str, Any],
    skill_name: str,
    tool: str,
    scope: str,
    expected_path: Path,
    project_root: Path | None,
) -> tuple[bool, str | None]:
    """Return (is_tracked, folder_checksum) for a (tool, scope) target in the prior lockfile.

    `is_tracked` distinguishes "Companion has a record for this target" from a hand-placed folder.
    `folder_checksum` is the comparable compute_dir_checksum baseline, or None for a legacy record
    whose stored checksum is the package checksum (not a folder checksum) — so callers update a tracked
    legacy install instead of false-flagging it as customized.
    """
    record = lock_records.get(skill_name)
    if not isinstance(record, dict):
        return (False, None)
    for target in normalize_targets(record):
        recorded_path = target.get("path")
        if (
            target.get("tool") == tool
            and target.get("scope") == scope
            and recorded_path
            and normalized_target_path(recorded_path, project_root) == normalized_target_path(expected_path, project_root)
        ):
            return (True, target.get("checksum"))
    return (False, None)


def target_conflict(
    skill_name: str,
    tool: str,
    scope: str,
    registry: dict[str, Any],
    project_root: Path | None,
    prior_user: dict[str, Any],
    prior_project: dict[str, Any],
    force: bool,
    include_checksum: bool,
) -> tuple[Path | None, dict[str, Any] | None]:
    """Classify whether a target can be safely replaced under the shared install policy."""
    try:
        target_dir = resolve_target_dir(tool, scope, skill_name, project_root, registry)
    except SystemExit as exc:
        row: dict[str, Any] = {"tool": tool, "scope": scope, "status": "error", "reason": str(exc), "path": None}
        if include_checksum:
            row["checksum"] = None
        return None, row

    if force or not target_dir.exists():
        return target_dir, None

    prior = prior_user if scope == "user" else prior_project
    tracked, recorded = existing_target(prior, skill_name, tool, scope, target_dir, project_root)
    if not tracked:
        row = {
            "tool": tool,
            "scope": scope,
            "status": "skipped_untracked",
            "reason": "an existing folder not tracked in the lockfile; pass --force to replace it",
            "path": str(target_dir),
        }
        if include_checksum:
            row["checksum"] = compute_dir_checksum(target_dir)
        return target_dir, row

    if recorded is not None:
        current_checksum = compute_dir_checksum(target_dir)
        if current_checksum != recorded:
            row = {
                "tool": tool,
                "scope": scope,
                "status": "skipped_customized",
                "reason": "local_customizations: on-disk folder diverges from the lockfile; pass --force to overwrite",
                "path": str(target_dir),
            }
            if include_checksum:
                row["checksum"] = current_checksum
            return target_dir, row

    return target_dir, None


def target_preflight_conflicts(
    skill_name: str,
    plan: list[tuple[str, str]],
    registry: dict[str, Any],
    project_root: Path | None,
    prior_user: dict[str, Any],
    prior_project: dict[str, Any],
    force: bool,
) -> list[dict[str, Any]]:
    """Return blocking local target conflicts without mutating the target folders."""
    conflicts: list[dict[str, Any]] = []
    for tool, scope in plan:
        _target_dir, conflict = target_conflict(
            skill_name, tool, scope, registry, project_root, prior_user, prior_project, force, include_checksum=False
        )
        if conflict:
            conflicts.append(conflict)
    return conflicts


def target_alias_conflicts(
    nodes: list[dict[str, Any]],
    plan: list[tuple[str, str]],
    registry: dict[str, Any],
    project_root: Path | None,
) -> list[dict[str, Any]]:
    """Block planned targets that resolve through symlinks to the same physical folder."""
    conflicts: list[dict[str, Any]] = []
    for node in nodes:
        by_physical_path: dict[Path, list[dict[str, str]]] = {}
        for tool, scope in plan:
            target_dir = resolve_target_dir(tool, scope, node["skill"]["name"], project_root, registry)
            by_physical_path.setdefault(physical_target_path(target_dir), []).append(
                {"tool": tool, "scope": scope, "path": str(target_dir)}
            )
        for aliases in by_physical_path.values():
            if len(aliases) < 2:
                continue
            for alias in aliases:
                conflicts.append(
                    {
                        "slug": node["slug"],
                        "version": node["version"],
                        **alias,
                        "status": "target_path_alias",
                        "reason": "multiple planned skill roots resolve to the same physical folder through a symlink; remove the alias or choose one target",
                    }
                )
    return conflicts


def fan_out_install(
    package_dir: Path,
    skill_name: str,
    plan: list[tuple[str, str]],
    registry: dict[str, Any],
    project_root: Path | None,
    prior_user: dict[str, Any],
    prior_project: dict[str, Any],
    force: bool,
) -> list[dict[str, Any]]:
    """Deploy `package_dir` into each planned (tool, scope) target. Returns one result row each."""
    results: list[dict[str, Any]] = []
    for tool, scope in plan:
        target_dir, conflict = target_conflict(
            skill_name, tool, scope, registry, project_root, prior_user, prior_project, force, include_checksum=True
        )
        if conflict:
            results.append(conflict)
            continue
        if target_dir is None:
            results.append({"tool": tool, "scope": scope, "status": "error", "reason": "target directory could not be resolved", "path": None, "checksum": None})
            continue

        # Isolate each target: a copy/remove/rename failure on one must not abort the fan-out, so every
        # successful target is still returned and recorded in the lockfile (no untracked partial installs).
        try:
            deploy_to_target(package_dir, target_dir)
            checksum = compute_dir_checksum(target_dir)
        except OSError as exc:
            results.append({"tool": tool, "scope": scope, "status": "error", "reason": str(exc), "path": str(target_dir), "checksum": None})
            continue
        results.append(
            {
                "tool": tool,
                "scope": scope,
                "status": "installed",
                "reason": None,
                "path": str(target_dir),
                "checksum": checksum,
            }
        )
    return results


def skill_from_row(skill_row: dict[str, Any], version_override: str | None = None) -> dict[str, Any]:
    if not isinstance(skill_row, dict) or not skill_row.get("slug"):
        fail("skill row is missing a slug")
    slug = str(skill_row["slug"])
    version = version_override or skill_row.get("current_version")
    if not version:
        fail(f"skill {slug!r} has no published version to install")
    version = str(version)
    current_version = skill_row.get("current_version")
    record_checksum = skill_row.get("checksum") if current_version is not None and version == str(current_version) else None
    metadata = skill_row.get("metadata") if isinstance(skill_row.get("metadata"), dict) else {}
    return {
        "name": slug,
        "slug": slug,
        "skillId": skill_row.get("id"),
        "companionSkillId": metadata.get("companionSkillId"),
        "version": version,
        "checksum": record_checksum,
    }


def fetch_skill_node(api_url: str, token: str, slug: str, version_override: str | None = None) -> dict[str, Any]:
    skill_row = api_get(api_url, token, f"/skills/{api_quote(slug)}")
    if not isinstance(skill_row, dict) or not skill_row.get("slug"):
        fail(f"skill {slug!r} not found in this workspace")
    skill = skill_from_row(skill_row, version_override)
    return {"slug": skill["slug"], "version": skill["version"], "skill": skill}


def dependency_path(slug: str, version: str | None = None) -> str:
    path = f"/skills/{api_quote(slug)}/dependencies"
    if version:
        path += f"?version={api_quote(version)}"
    return path


def build_install_plan(api_url: str, token: str, root_slug: str, root_version: str | None = None) -> dict[str, Any]:
    """Return dependency-first install nodes and blockers for the root skill.

    Dependencies are un-versioned in Companion. The requested root may use an explicit old version,
    while dependencies are resolved and installed at their current published versions.
    """
    nodes: list[dict[str, Any]] = []
    blockers: list[dict[str, Any]] = []
    visited: set[str] = set()
    visiting: list[str] = []

    def visit(slug: str, version_override: str | None, required_by: str | None) -> None:
        if slug in visited:
            return
        if slug in visiting:
            blockers.append(
                {
                    "slug": slug,
                    "requiredBy": required_by,
                    "status": "cycle",
                    "note": "local dependency traversal found a cycle",
                    "canOpen": True,
                }
            )
            return

        visiting.append(slug)
        node = fetch_skill_node(api_url, token, slug, version_override)
        deps = api_get(api_url, token, dependency_path(node["slug"], version_override))
        requires = deps.get("requires") if isinstance(deps, dict) else []
        for dep in sorted((row for row in requires if isinstance(row, dict)), key=lambda row: str(row.get("slug") or "")):
            dep_slug = str(dep.get("slug") or "")
            status = str(dep.get("status") or "missing")
            can_open = bool(dep.get("can_open"))
            if status != "satisfied" or not can_open:
                blockers.append(
                    {
                        "slug": dep_slug,
                        "requiredBy": node["slug"],
                        "status": status,
                        "note": dep.get("note"),
                        "canOpen": can_open,
                    }
                )
                continue
            visit(dep_slug, None, node["slug"])

        visiting.pop()
        visited.add(node["slug"])
        nodes.append(node)

    visit(root_slug, root_version, None)
    root = next((node for node in nodes if node["slug"] == root_slug), None)
    return {"root": root, "nodes": nodes, "blockers": blockers}


def required_secret_names(manifest: dict[str, Any]) -> list[str]:
    environment = manifest.get("environment") if isinstance(manifest, dict) else {}
    secrets = environment.get("secrets") if isinstance(environment, dict) else {}
    if not isinstance(secrets, dict):
        return []
    names: list[str] = []
    for name, spec in secrets.items():
        required = spec is not False if not isinstance(spec, dict) else spec.get("required", True) is True
        if required:
            names.append(str(name))
    return sorted(names)


def fetch_required_secrets(api_url: str, token: str, node: dict[str, Any]) -> list[dict[str, str]]:
    files_response = api_get(api_url, token, f"/skills/{api_quote(node['slug'])}/versions/{api_quote(node['version'])}/files")
    files = files_response.get("files") if isinstance(files_response, dict) else []
    companion_file = next((file for file in files if isinstance(file, dict) and file.get("path") == "companion.json"), None)
    if not companion_file:
        return []
    content = companion_file.get("content")
    if content is None:
        fail(f"cannot inspect companion.json for {node['slug']} {node['version']}: content was not returned")
    try:
        manifest = json.loads(str(content))
    except json.JSONDecodeError as exc:
        fail(f"cannot inspect companion.json for {node['slug']} {node['version']}: invalid JSON: {exc}")
    return [{"slug": node["slug"], "version": node["version"], "secret": name} for name in required_secret_names(manifest)]


def collect_required_secrets(api_url: str, token: str, nodes: list[dict[str, Any]]) -> list[dict[str, str]]:
    required: list[dict[str, str]] = []
    for node in nodes:
        required.extend(fetch_required_secrets(api_url, token, node))
    return required


def preflight_target_conflicts(
    nodes: list[dict[str, Any]],
    plan: list[tuple[str, str]],
    registry: dict[str, Any],
    project_root: Path | None,
    prior_user: dict[str, Any],
    prior_project: dict[str, Any],
    force: bool,
) -> list[dict[str, Any]]:
    conflicts: list[dict[str, Any]] = []
    for node in nodes:
        for conflict in target_preflight_conflicts(node["skill"]["name"], plan, registry, project_root, prior_user, prior_project, force):
            conflicts.append({"slug": node["slug"], "version": node["version"], **conflict})
    return conflicts


def preflight_duplicate_targets(
    nodes: list[dict[str, Any]],
    duplicate_tools: list[str],
    planned_tools: list[str],
    auto_prune_tools: set[str],
    scopes: list[str],
    registry: dict[str, Any],
    project_root: Path | None,
    prior_user: dict[str, Any],
    prior_project: dict[str, Any],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Classify extra visible copies as blocking or safely removable.

    Only Companion-tracked folders whose current checksum still matches the lockfile are eligible for
    automatic pruning. Untracked, customized, or legacy-unverifiable copies block before download.
    """
    conflicts: list[dict[str, Any]] = []
    prunable: list[dict[str, Any]] = []
    for node in nodes:
        skill_name = node["skill"]["name"]
        for scope in scopes:
            prior = prior_user if scope == "user" else prior_project
            for tool in duplicate_tools:
                target_dir = resolve_target_dir(tool, scope, skill_name, project_root, registry)
                planned_physical_paths = {
                    physical_target_path(
                        resolve_target_dir(planned, planned_scope, skill_name, project_root, registry)
                    )
                    for planned in planned_tools
                    for planned_scope in scopes
                }
                tracked, recorded = existing_target(
                    prior, skill_name, tool, scope, target_dir, project_root
                )
                if physical_target_path(target_dir) in planned_physical_paths:
                    conflicts.append(
                        {
                            "slug": node["slug"],
                            "version": node["version"],
                            "tool": tool,
                            "scope": scope,
                            "path": str(target_dir),
                            "status": "duplicate_path_alias",
                            "reason": "the redundant root resolves to a selected install target through a symlink and cannot be pruned safely",
                        }
                    )
                    continue
                if not target_dir.exists() and (not tracked or tool not in auto_prune_tools):
                    continue
                base = {
                    "slug": node["slug"],
                    "version": node["version"],
                    "tool": tool,
                    "scope": scope,
                    "path": str(target_dir),
                    "physicalPath": str(physical_target_path(target_dir)),
                    "plannedPhysicalPaths": sorted(str(path) for path in planned_physical_paths),
                }
                if tool not in auto_prune_tools:
                    conflicts.append({
                        **base,
                        "status": "duplicate_outside_scope",
                        "reason": "a second visible copy belongs to a tool outside this install request; include that tool or resolve the copy explicitly",
                    })
                    continue
                if not target_dir.exists():
                    prunable.append({**base, "checksum": recorded, "missing": True})
                    continue
                if not tracked:
                    conflicts.append({
                        **base,
                        "status": "duplicate_untracked",
                        "reason": "a second visible skill folder is not tracked by Companion; remove or archive it explicitly",
                    })
                    continue
                if not recorded:
                    conflicts.append({
                        **base,
                        "status": "duplicate_unverifiable",
                        "reason": "the redundant tracked folder has no comparable checksum and cannot be removed safely",
                    })
                    continue
                current = compute_dir_checksum(target_dir)
                if current != recorded:
                    conflicts.append({
                        **base,
                        "status": "duplicate_customized",
                        "reason": "the redundant tracked folder has local customizations and cannot be removed safely",
                    })
                    continue
                prunable.append({**base, "checksum": recorded})
    return conflicts, prunable


def preflight_additional_discovery_targets(
    nodes: list[dict[str, Any]],
    tools: list[str],
    scopes: list[str],
    registry: dict[str, Any],
    project_root: Path | None,
) -> tuple[list[dict[str, Any]], list[str]]:
    """Block unmanaged native/legacy roots that would remain visible beside an install target."""
    conflicts: list[dict[str, Any]] = []
    checked: list[str] = []
    seen: set[tuple[str, str]] = set()
    for node in nodes:
        skill_name = node["skill"]["name"]
        for scope in scopes:
            for tool in tools:
                for target_dir in resolve_additional_discovery_dirs(
                    tool, scope, skill_name, project_root, registry
                ):
                    key = (scope, str(target_dir))
                    if key in seen:
                        continue
                    seen.add(key)
                    checked.append(str(target_dir))
                    if target_dir.exists():
                        conflicts.append(
                            {
                                "slug": node["slug"],
                                "version": node["version"],
                                "tool": tool,
                                "scope": scope,
                                "path": str(target_dir),
                                "status": "duplicate_unmanaged_root",
                                "reason": "a second visible skill folder exists in a native or legacy root that Companion does not manage; remove or archive it explicitly",
                            }
                        )
    return conflicts, checked


def prune_duplicate_targets(
    rows: list[dict[str, Any]],
    workspace_id: str | None,
    api_url: str,
    project_root: Path | None,
) -> list[dict[str, Any]]:
    """Delete still-verified redundant folders, then remove their lockfile target rows."""
    results: list[dict[str, Any]] = []
    removed_by_lock: dict[tuple[Path, str], set[tuple[str, str]]] = {}
    for row in rows:
        target = Path(row["path"])
        current_physical_path = physical_target_path(target)
        expected_physical_path = row.get("physicalPath")
        planned_physical_paths = set(row.get("plannedPhysicalPaths") or [])
        if (
            (expected_physical_path and str(current_physical_path) != expected_physical_path)
            or str(current_physical_path) in planned_physical_paths
        ):
            results.append(
                {
                    **row,
                    "status": "error",
                    "reason": "redundant root changed physical path after preflight or now aliases a selected install target",
                }
            )
            continue
        if not target.exists():
            results.append({**row, "status": "already_absent"})
            lock_path = lockfile_path() if row["scope"] == "user" else project_lockfile_path(project_root)  # type: ignore[arg-type]
            removed_by_lock.setdefault((lock_path, row["slug"]), set()).add((row["tool"], row["scope"]))
            continue
        try:
            current = compute_dir_checksum(target)
        except OSError as exc:
            results.append({**row, "status": "error", "reason": f"cannot verify redundant folder: {exc}"})
            continue
        if current != row["checksum"]:
            results.append({**row, "status": "error", "reason": "redundant folder changed after preflight"})
            continue
        try:
            remove_swap_path(target)
        except OSError as exc:
            results.append({**row, "status": "error", "reason": str(exc)})
            continue
        lock_path = lockfile_path() if row["scope"] == "user" else project_lockfile_path(project_root)  # type: ignore[arg-type]
        removed_by_lock.setdefault((lock_path, row["slug"]), set()).add((row["tool"], row["scope"]))
        results.append({**row, "status": "removed", "reason": None})
    for (path, slug), target_keys in removed_by_lock.items():
        remove_skill_lock_targets(path, workspace_id, api_url, slug, target_keys)
    return results


def format_dependency_blockers(blockers: list[dict[str, Any]]) -> str:
    lines = ["dependency preflight failed:"]
    for blocker in blockers:
        required_by = f" required by {blocker.get('requiredBy')}" if blocker.get("requiredBy") else ""
        note = f" ({blocker.get('note')})" if blocker.get("note") else ""
        lines.append(f"  - {blocker.get('slug')}{required_by}: {blocker.get('status')}{note}")
    return "\n".join(lines)


def format_required_secrets(required: list[dict[str, str]]) -> str:
    lines = ["required secrets must be confirmed before install:"]
    for row in required:
        lines.append(f"  - {row['slug']} {row['version']}: {row['secret']}")
    lines.append("rerun after confirmation with --confirm-required-secrets")
    return "\n".join(lines)


def format_target_conflicts(conflicts: list[dict[str, Any]]) -> str:
    lines = ["local target preflight failed:"]
    for conflict in conflicts:
        lines.append(
            f"  - {conflict.get('slug')} {conflict.get('tool')} ({conflict.get('scope')}): "
            f"{conflict.get('status')} {conflict.get('path') or ''} {conflict.get('reason') or ''}".rstrip()
        )
    return "\n".join(lines)


def fail_preflight(json_output: bool, message: str, **payload: Any) -> None:
    if json_output:
        print(json.dumps({"ok": False, "error": message, **payload}, indent=2, sort_keys=True))
        raise SystemExit(2)
    print(f"error: {message}", file=sys.stderr)
    raise SystemExit(2)


def install_node(
    api_url: str,
    token: str,
    workspace_id: str | None,
    node: dict[str, Any],
    plan: list[tuple[str, str]],
    registry: dict[str, Any],
    project_root: Path | None,
    prior_user: dict[str, Any],
    prior_project: dict[str, Any],
    force: bool,
    secret_context: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    zip_bytes = api_download_bytes(api_url, token, f"/skills/{api_quote(node['slug'])}/versions/{api_quote(node['version'])}/package")
    with tempfile.TemporaryDirectory(prefix="companion-install-") as tmp:
        package_dir = extract_package(zip_bytes, Path(tmp))
        return install_prepared_node(api_url, workspace_id, node, package_dir, plan, registry, project_root, prior_user, prior_project, force, secret_context)


def install_prepared_node(
    api_url: str,
    workspace_id: str | None,
    node: dict[str, Any],
    package_dir: Path,
    plan: list[tuple[str, str]],
    registry: dict[str, Any],
    project_root: Path | None,
    prior_user: dict[str, Any],
    prior_project: dict[str, Any],
    force: bool,
    secret_context: dict[str, Any] | None,
) -> list[dict[str, Any]]:
    preflight = secret_context.get("preflight", {}) if isinstance(secret_context, dict) else {}
    redeemed = secret_context.get("redeemed", {}) if isinstance(secret_context, dict) else {}
    preflight_skills_set = {
        str(row.get("skill") or "")
        for row in [*(preflight.get("items", []) or []), *(preflight.get("tombstones", []) or [])]
        if isinstance(row, dict)
    }
    projection_items = [
        row for row in (redeemed.get("items", []) or [])
        if isinstance(row, dict) and row.get("skill") == node["slug"]
    ]
    active_preflight_items = [
        row for row in (preflight.get("items", []) or [])
        if isinstance(row, dict) and row.get("skill") == node["slug"]
    ]
    if workspace_id and node["slug"] in preflight_skills_set:
        target_dirs = [resolve_target_dir(tool, scope, node["skill"]["name"], project_root, registry) for tool, scope in plan]
        try:
            projection_path = deploy_packages_with_projection(
                package_dir,
                target_dirs,
                workspace_id,
                node["slug"],
                projection_items,
                remove_projection_if_empty=not active_preflight_items,
            )
            results = [
                {
                    "tool": tool,
                    "scope": scope,
                    "status": "installed",
                    "reason": None,
                    "path": str(target_dir),
                    "checksum": compute_dir_checksum(target_dir),
                }
                for (tool, scope), target_dir in zip(plan, target_dirs)
            ]
            filtered_redeemed = {
                "items": projection_items,
                "tombstones": [
                    row for row in (redeemed.get("tombstones", []) or [])
                    if isinstance(row, dict) and row.get("skill") == node["slug"]
                ],
            }
            update_projection_state(workspace_id, filtered_redeemed, {node["slug"]: projection_path})
        except (OSError, ValueError) as exc:
            results = [
                {"tool": tool, "scope": scope, "status": "error", "reason": str(exc), "path": str(target_dir), "checksum": None}
                for (tool, scope), target_dir in zip(plan, target_dirs)
            ]
    else:
        results = fan_out_install(package_dir, node["skill"]["name"], plan, registry, project_root, prior_user, prior_project, force)

    for row in results:
        row["slug"] = node["slug"]
        row["version"] = node["version"]

    installed = [row for row in results if row["status"] == "installed"]
    user_targets = [row for row in installed if row["scope"] == "user"]
    project_targets = [row for row in installed if row["scope"] == "project"]
    upsert_skill_lock_record(lockfile_path(), workspace_id, api_url, node["skill"], user_targets, relative_to=None)
    if project_root is not None and project_targets:
        upsert_skill_lock_record(project_lockfile_path(project_root), workspace_id, api_url, node["skill"], project_targets, relative_to=project_root)
    return results


def install_nodes(
    api_url: str,
    token: str,
    workspace_id: str | None,
    nodes: list[dict[str, Any]],
    plan: list[tuple[str, str]],
    registry: dict[str, Any],
    project_root: Path | None,
    prior_user: dict[str, Any],
    prior_project: dict[str, Any],
    force: bool,
    secret_context: dict[str, Any] | None = None,
) -> dict[str, Any]:
    all_results: list[dict[str, Any]] = []
    completed: list[str] = []
    skipped: list[str] = []
    prepared: dict[str, Path] = {}
    temp_packages = tempfile.TemporaryDirectory(prefix="companion-install-set-") if secret_context is not None else None
    try:
        if temp_packages is not None:
            # The grant is redeemed before this point. Download and validate the complete package set
            # before mutating any target, so a network/package error preserves every previous install.
            for index, node in enumerate(nodes):
                zip_bytes = api_download_bytes(api_url, token, f"/skills/{api_quote(node['slug'])}/versions/{api_quote(node['version'])}/package")
                destination = Path(temp_packages.name) / str(index)
                destination.mkdir()
                prepared[node["slug"]] = extract_package(zip_bytes, destination)

        for index, node in enumerate(nodes):
            results = install_prepared_node(
                api_url, workspace_id, node, prepared[node["slug"]], plan, registry, project_root,
                prior_user, prior_project, force, secret_context
            ) if temp_packages is not None else install_node(
                api_url, token, workspace_id, node, plan, registry, project_root,
                prior_user, prior_project, force, secret_context
            )
            all_results.extend(results)
            complete = bool(results) and len([row for row in results if row["status"] == "installed"]) == len(plan)
            if not complete:
                skipped = [later["slug"] for later in nodes[index + 1:]]
                break
            completed.append(node["slug"])
    finally:
        if temp_packages is not None:
            temp_packages.cleanup()
    return {"targets": all_results, "completed": completed, "skipped": skipped}


def report_install(api_url: str, token: str, slug: str, version: str, agent: str) -> dict[str, Any]:
    url = f"{api_url.rstrip('/')}/skills/{api_quote(slug)}/install"
    body = json.dumps({"version": version, "agent": agent, "source": "agent"}).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        fail(f"POST {url} failed with HTTP {exc.code}: {detail}")
    except urllib.error.URLError as exc:
        fail(f"POST {url} failed: {exc.reason}")


def resolve_tools(args_tools: str | None, registry: dict[str, Any]) -> list[str]:
    if args_tools:
        wanted = [tool.strip() for tool in args_tools.split(",") if tool.strip()]
    else:
        wanted = load_tool_config()
    if not wanted:
        detected = detect_tools(registry)
        hint = ", ".join(detected) if detected else "none detected"
        fail(
            "no tools configured. Detected on this machine: "
            f"{hint}. Confirm the set with the user, then write {config_path()} "
            "(or pass --tools claude-code,codex,opencode)."
        )
    unknown = [tool for tool in wanted if tool not in registry]
    if unknown:
        fail(f"unknown tool(s) {', '.join(unknown)}; known tools: {', '.join(sorted(registry))}")
    return list(dict.fromkeys(wanted))


def main() -> None:
    parser = argparse.ArgumentParser(description="Install a workspace skill into every configured local tool")
    parser.add_argument("slug", help="skill slug to install")
    parser.add_argument("--version", help="version to install (defaults to the current published version)")
    parser.add_argument("--tools", help="comma-separated tool keys (defaults to ~/.companion/config.json)")
    parser.add_argument("--scope", choices=["user", "project", "both"], default="user", help="install scope")
    parser.add_argument("--project", help="project root for project-scope installs (defaults to the current repo root)")
    parser.add_argument("--force", action="store_true", help="overwrite locally customized targets")
    parser.add_argument(
        "--confirm-secrets",
        action="store_true",
        help="confirm the server preflight and permit one-time secret retrieval",
    )
    parser.add_argument(
        "--confirm-required-secrets",
        action="store_true",
        help="deprecated metadata-only confirmation flag; use --confirm-secrets for retrieval",
    )
    parser.add_argument("--report", action="store_true", help="send the aggregate POST /skills/:slug/install report")
    parser.add_argument("--agent", default=os.environ.get("COMPANION_AGENT"), help="agent label for the install report")
    parser.add_argument("--json", action="store_true", help="print a machine-readable result")
    args = parser.parse_args()

    if args.confirm_required_secrets:
        fail("--confirm-required-secrets no longer authorizes secret retrieval; review the preflight and use --confirm-secrets explicitly")

    api_url, token, workspace_id = resolve_credentials()
    # Legacy flat credentials do not carry a workspace id. They remain valid for package-only
    # installs; secret projections are disabled until credentials are refreshed to schema v2.
    if workspace_id:
        recover_pending_transactions(workspace_id)
    registry = load_tool_registry()
    tools = resolve_tools(args.tools, registry)
    scopes = ["user", "project"] if args.scope == "both" else [args.scope]

    project_root: Path | None = None
    if "project" in scopes:
        project_root = Path(args.project).expanduser().resolve() if args.project else find_project_root()

    install_target_plan = plan_targets(tools, scopes, project_root, registry)
    target_tools = list(dict.fromkeys(tool for tool, _scope in install_target_plan))
    duplicate_tools = duplicate_target_tools(tools, target_tools, registry)
    auto_prune_tools = set(tools).difference(target_tools)

    # Resolve prior records through workspace_lock_entry so customization detection still works on
    # activeWorkspaceId-, legacy URL-, or flat-keyed lockfiles (not only workspace_id/api_url keys).
    prior_user = {}
    prior_project = {}
    raw_user = load_json(lockfile_path())
    if isinstance(raw_user, dict):
        prior_user = workspace_lock_entry(raw_user, workspace_id, api_url).get("skills", {}) or {}
    if project_root is not None:
        raw_project = load_json(project_lockfile_path(project_root))
        if isinstance(raw_project, dict):
            prior_project = workspace_lock_entry(raw_project, workspace_id, api_url).get("skills", {}) or {}

    install_plan = build_install_plan(api_url, token, args.slug, args.version)
    if install_plan["blockers"]:
        fail_preflight(
            args.json,
            format_dependency_blockers(install_plan["blockers"]),
            blockers=install_plan["blockers"],
        )
    nodes = install_plan["nodes"]
    if not nodes or not install_plan["root"]:
        fail(f"skill {args.slug!r} not found in this workspace")
    root = install_plan["root"]

    secret_preflight = preflight_skills(
        api_url,
        token,
        [{"slug": root["slug"], "version": root["version"]}],
    )
    if int(secret_preflight.get("blockers") or 0) > 0:
        fail_preflight(
            args.json,
            "server secret preflight found required configuration that is missing",
            secretPreflight=redacted_preflight(secret_preflight),
        )

    conflicts = preflight_target_conflicts(
        nodes,
        install_target_plan,
        registry,
        project_root,
        prior_user,
        prior_project,
        args.force,
    )
    conflicts.extend(target_alias_conflicts(nodes, install_target_plan, registry, project_root))
    if conflicts:
        fail_preflight(args.json, format_target_conflicts(conflicts), conflicts=conflicts)

    duplicate_conflicts, duplicate_prune_plan = preflight_duplicate_targets(
        nodes,
        duplicate_tools,
        target_tools,
        auto_prune_tools,
        scopes,
        registry,
        project_root,
        prior_user,
        prior_project,
    )
    additional_duplicate_conflicts, additional_roots_checked = preflight_additional_discovery_targets(
        nodes,
        tools,
        scopes,
        registry,
        project_root,
    )
    duplicate_conflicts.extend(additional_duplicate_conflicts)
    if duplicate_conflicts:
        fail_preflight(args.json, format_target_conflicts(duplicate_conflicts), conflicts=duplicate_conflicts)

    needs_secret_confirmation = bool(secret_preflight.get("items") or secret_preflight.get("tombstones"))
    if needs_secret_confirmation and not workspace_id:
        fail_preflight(
            args.json,
            "legacy credentials have no workspace id; refresh the Companion credentials before installing skills with secrets",
            secretPreflight=redacted_preflight(secret_preflight),
        )
    if needs_secret_confirmation and not args.confirm_secrets:
        fail_preflight(
            args.json,
            "review the secret preflight, then rerun with --confirm-secrets",
            secretPreflight=redacted_preflight(secret_preflight),
        )
    redeemed = {"items": [], "tombstones": []}
    if needs_secret_confirmation:
        redeemed = redeem_plan(api_url, token, str(secret_preflight["plan_id"]))

    install_result = install_nodes(
        api_url,
        token,
        workspace_id,
        nodes,
        install_target_plan,
        registry,
        project_root,
        prior_user,
        prior_project,
        args.force,
        {"preflight": secret_preflight, "redeemed": redeemed},
    )
    results = install_result["targets"]
    installed = [row for row in results if row["status"] == "installed"]
    root_results = [row for row in results if row.get("slug") == root["slug"]]

    # The workspace install report is a single aggregate row at this version. Only send it when EVERY
    # planned target for the root and its dependency closure installed; a partial fan-out must not mark
    # the root current while one of the local tools/scopes is still behind or missing.
    complete = bool(nodes) and len(installed) == len(nodes) * len(install_target_plan)
    duplicate_prune = prune_duplicate_targets(
        duplicate_prune_plan, workspace_id, api_url, project_root
    ) if complete else []
    if any(row["status"] == "error" for row in duplicate_prune):
        complete = False
    report = None
    report_withheld = args.report and not complete
    if args.report and complete:
        installed_tools = sorted({registry[tool].get("displayName", tool) for tool in tools})
        agent_label = args.agent or ", ".join(installed_tools)
        report = report_install(api_url, token, root["slug"], root["version"], agent_label)

    summary = {
        "slug": root["slug"],
        "version": root["version"],
        "tools": tools,
        "targetTools": target_tools,
        "duplicateRootsChecked": duplicate_tools,
        "additionalDuplicateRootsChecked": additional_roots_checked,
        "scopes": scopes,
        "projectRoot": str(project_root) if project_root else None,
        "installOrder": [node["slug"] for node in nodes],
        "dependencies": [node["slug"] for node in nodes if node["slug"] != root["slug"]],
        "secretPreflight": redacted_preflight(secret_preflight),
        "confirmedSecrets": bool(needs_secret_confirmation and args.confirm_secrets),
        "targets": results,
        "rootTargets": root_results,
        "installedCount": len(installed),
        "installedSkillCount": len(install_result["completed"]),
        "skippedSkills": install_result["skipped"],
        "duplicatePrune": duplicate_prune,
        "complete": complete,
        "report": report,
        "reportWithheld": report_withheld,
    }

    if args.json:
        print(json.dumps(summary, indent=2, sort_keys=True))
    else:
        dep_count = len(summary["dependencies"])
        suffix = f" plus {dep_count} dependenc{'y' if dep_count == 1 else 'ies'}" if dep_count else ""
        print(f"Installed {root['slug']} {root['version']}{suffix} into {len(installed)} target(s):")
        for node in nodes:
            node_rows = [row for row in results if row.get("slug") == node["slug"]]
            if not node_rows:
                print(f"  {node['slug']} {node['version']}: skipped")
                continue
            print(f"  {node['slug']} {node['version']}:")
            for row in node_rows:
                marker = "ok" if row["status"] == "installed" else row["status"]
                print(f"    - {row['tool']} ({row['scope']}): {marker} {row.get('path') or ''}".rstrip())
        skipped = [row for row in results if row["status"] in ("skipped_customized", "skipped_untracked")]
        if skipped:
            print("Some targets were left untouched (locally customized or untracked); pass --force to overwrite.")
        errored = [row for row in results if row["status"] == "error"]
        if errored:
            print(f"{len(errored)} target(s) failed to install; see the per-target results above.")
        if install_result["skipped"]:
            print(f"Skipped skill(s) after a failed dependency install: {', '.join(install_result['skipped'])}.")
        removed_duplicates = [row for row in duplicate_prune if row["status"] in ("removed", "already_absent")]
        if removed_duplicates:
            print(f"Removed {len(removed_duplicates)} redundant skill target(s) and refreshed the lockfile.")
        if report_withheld:
            print("Aggregate install report withheld: not every planned target installed. Resolve the "
                  "skipped/failed targets (or pass --force), then report once all targets are current.")
        elif not args.report:
            print(f"Next: report the aggregate install with POST /skills/{root['slug']}/install (version {root['version']}).")


if __name__ == "__main__":
    main()
