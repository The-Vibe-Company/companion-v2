#!/usr/bin/env python3
"""Install (or update) a published workspace skill into every local tool at once.

This is the deterministic fan-out behind multi-tool installs. Given a skill slug it downloads the
package once and deploys it into each configured tool (Claude Code, Codex, …) at the requested
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
    resolve_credentials,
    resolve_target_dir,
    upsert_skill_lock_record,
    workspace_lock_entry,
)

import urllib.error  # noqa: E402
import urllib.parse  # noqa: E402
import urllib.request  # noqa: E402


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


def deploy_to_target(package_dir: Path, target_dir: Path) -> None:
    """Replace `target_dir` with a fresh copy of the package: stage, then swap via a backup so a
    failed rename restores the previous folder instead of leaving the target missing."""
    target_dir.parent.mkdir(parents=True, exist_ok=True)
    staging = target_dir.with_name(target_dir.name + ".companion-staging")
    backup = target_dir.with_name(target_dir.name + ".companion-backup")
    if staging.exists():
        shutil.rmtree(staging)
    shutil.copytree(package_dir, staging)
    if backup.exists():
        shutil.rmtree(backup)
    if target_dir.exists():
        target_dir.rename(backup)
    try:
        staging.rename(target_dir)
    except OSError:
        if backup.exists() and not target_dir.exists():
            backup.rename(target_dir)  # restore the previous folder
        raise
    if backup.exists():
        shutil.rmtree(backup)


def plan_targets(tools: list[str], scopes: list[str], project_root: Path | None) -> list[tuple[str, str]]:
    plan: list[tuple[str, str]] = []
    for scope in scopes:
        if scope == "project" and project_root is None:
            fail("project scope requested but no project root was found (run inside a repo or pass --project)")
        for tool in tools:
            plan.append((tool, scope))
    return plan


def existing_target(lock_records: dict[str, Any], skill_name: str, tool: str, scope: str) -> tuple[bool, str | None]:
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
        if target.get("tool") == tool and target.get("scope") == scope:
            return (True, target.get("checksum"))
    return (False, None)


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
        try:
            target_dir = resolve_target_dir(tool, scope, skill_name, project_root, registry)
        except SystemExit as exc:
            results.append({"tool": tool, "scope": scope, "status": "error", "reason": str(exc), "path": None, "checksum": None})
            continue

        prior = prior_user if scope == "user" else prior_project
        tracked, recorded = existing_target(prior, skill_name, tool, scope)
        if target_dir.exists() and not force:
            if not tracked:
                # An existing folder Companion does not track (manually authored or installed another
                # way). Never silently delete it; require --force.
                results.append(
                    {
                        "tool": tool,
                        "scope": scope,
                        "status": "skipped_untracked",
                        "reason": "an existing folder not tracked in the lockfile; pass --force to replace it",
                        "path": str(target_dir),
                        "checksum": compute_dir_checksum(target_dir),
                    }
                )
                continue
            # `recorded is None` means a tracked legacy install with no comparable folder checksum — it
            # is Companion-managed, so update it; only a divergent comparable checksum blocks as customized.
            if recorded is not None and compute_dir_checksum(target_dir) != recorded:
                results.append(
                    {
                        "tool": tool,
                        "scope": scope,
                        "status": "skipped_customized",
                        "reason": "local_customizations: on-disk folder diverges from the lockfile; pass --force to overwrite",
                        "path": str(target_dir),
                        "checksum": compute_dir_checksum(target_dir),
                    }
                )
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


def report_install(api_url: str, token: str, slug: str, version: str, agent: str) -> dict[str, Any]:
    url = f"{api_url.rstrip('/')}/skills/{urllib.parse.quote(slug)}/install"
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
            "(or pass --tools claude-code,codex)."
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
    parser.add_argument("--report", action="store_true", help="send the aggregate POST /skills/:slug/install report")
    parser.add_argument("--agent", default=os.environ.get("COMPANION_AGENT"), help="agent label for the install report")
    parser.add_argument("--json", action="store_true", help="print a machine-readable result")
    args = parser.parse_args()

    api_url, token, workspace_id = resolve_credentials()
    registry = load_tool_registry()
    tools = resolve_tools(args.tools, registry)
    scopes = ["user", "project"] if args.scope == "both" else [args.scope]

    project_root: Path | None = None
    if "project" in scopes:
        project_root = Path(args.project).expanduser().resolve() if args.project else find_project_root()

    skill_row = api_get(api_url, token, f"/skills/{urllib.parse.quote(args.slug)}")
    if not isinstance(skill_row, dict) or not skill_row.get("slug"):
        fail(f"skill {args.slug!r} not found in this workspace")
    slug = str(skill_row["slug"])
    # The skill folder is named by the slug (kebab, workspace-unique); the /skills/:slug row carries
    # no separate `name`, and a skill's frontmatter name matches its slug.
    skill_name = slug
    version = args.version or skill_row.get("current_version")
    if not version:
        fail(f"skill {slug!r} has no published version to install")
    version = str(version)
    # The detail row's checksum is the CURRENT version's package checksum; it only matches when we are
    # installing the current version. For an explicit older --version, leave it None rather than record
    # a checksum that does not describe the package actually downloaded.
    current_version = skill_row.get("current_version")
    record_checksum = skill_row.get("checksum") if current_version is not None and version == str(current_version) else None
    skill = {
        "name": skill_name,
        "slug": slug,
        "skillId": skill_row.get("id"),
        "companionSkillId": (skill_row.get("metadata") or {}).get("companionSkillId") if isinstance(skill_row.get("metadata"), dict) else None,
        "version": version,
        "checksum": record_checksum,
    }

    plan = plan_targets(tools, scopes, project_root)

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

    zip_bytes = api_download_bytes(api_url, token, f"/skills/{urllib.parse.quote(slug)}/versions/{urllib.parse.quote(version)}/package")

    with tempfile.TemporaryDirectory(prefix="companion-install-") as tmp:
        package_dir = extract_package(zip_bytes, Path(tmp))
        results = fan_out_install(package_dir, skill_name, plan, registry, project_root, prior_user, prior_project, args.force)

    installed = [row for row in results if row["status"] == "installed"]
    user_targets = [row for row in installed if row["scope"] == "user"]
    project_targets = [row for row in installed if row["scope"] == "project"]
    upsert_skill_lock_record(lockfile_path(), workspace_id, api_url, skill, user_targets, relative_to=None)
    if project_root is not None and project_targets:
        upsert_skill_lock_record(project_lockfile_path(project_root), workspace_id, api_url, skill, project_targets, relative_to=project_root)

    # The workspace install report is a single aggregate row at this version. Only send it when EVERY
    # planned target installed; a partial fan-out (a skipped or failed target) must not mark the skill
    # current for the user while one of their tools/scopes is still behind or missing.
    complete = bool(installed) and len(installed) == len(plan)
    report = None
    report_withheld = args.report and not complete
    if args.report and complete:
        installed_tools = sorted({registry[row["tool"]].get("displayName", row["tool"]) for row in installed})
        agent_label = args.agent or ", ".join(installed_tools)
        report = report_install(api_url, token, slug, version, agent_label)

    summary = {
        "slug": slug,
        "version": version,
        "tools": tools,
        "scopes": scopes,
        "projectRoot": str(project_root) if project_root else None,
        "targets": results,
        "installedCount": len(installed),
        "complete": complete,
        "report": report,
        "reportWithheld": report_withheld,
    }

    if args.json:
        print(json.dumps(summary, indent=2, sort_keys=True))
    else:
        print(f"Installed {slug} {version} into {len(installed)} target(s):")
        for row in results:
            marker = "ok" if row["status"] == "installed" else row["status"]
            print(f"  - {row['tool']} ({row['scope']}): {marker} {row.get('path') or ''}".rstrip())
        skipped = [row for row in results if row["status"] in ("skipped_customized", "skipped_untracked")]
        if skipped:
            print("Some targets were left untouched (locally customized or untracked); pass --force to overwrite.")
        errored = [row for row in results if row["status"] == "error"]
        if errored:
            print(f"{len(errored)} target(s) failed to install; see the per-target results above.")
        if report_withheld:
            print("Aggregate install report withheld: not every planned target installed. Resolve the "
                  "skipped/failed targets (or pass --force), then report once all targets are current.")
        elif not args.report:
            print(f"Next: report the aggregate install with POST /skills/{slug}/install (version {version}).")


if __name__ == "__main__":
    main()
