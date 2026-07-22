#!/usr/bin/env python3
"""Prepare a non-committable artifact directory for Mega Code Review."""

from __future__ import annotations

import argparse
from datetime import datetime
import json
import re
import subprocess
import sys
from pathlib import Path
from typing import Any


ARTIFACT_ROOT = Path("plans/review-code-dev")
EXCLUDE_MARKER = "# Mega Code Review artifacts"
EXCLUDE_LINES = ("/plans/review-code-dev/",)


def run(cmd: list[str], cwd: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        cmd,
        cwd=str(cwd),
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )


def require_ok(result: subprocess.CompletedProcess[str]) -> str:
    if result.returncode != 0:
        raise SystemExit(result.stderr.strip() or f"{result.args} failed")
    return result.stdout


def slugify(value: str) -> str:
    slug = re.sub(r"[^A-Za-z0-9._-]+", "-", value.strip().lower())
    slug = re.sub(r"-+", "-", slug).strip("-._")
    return slug or "repo"


def detect_repo(cwd: Path) -> Path | None:
    result = run(["git", "rev-parse", "--show-toplevel"], cwd)
    if result.returncode != 0:
        return None
    return Path(result.stdout.strip()).resolve()


def git_path(repo: Path, path: str) -> Path:
    result = run(["git", "rev-parse", "--git-path", path], repo)
    resolved = Path(require_ok(result).strip())
    if not resolved.is_absolute():
        resolved = repo / resolved
    return resolved.resolve()


def tracked_artifacts(repo: Path, artifact_root: Path = ARTIFACT_ROOT) -> list[str]:
    result = run(["git", "ls-files", "--", artifact_root.as_posix()], repo)
    if result.returncode != 0:
        raise SystemExit(result.stderr.strip() or "git ls-files failed")
    return [line for line in result.stdout.splitlines() if line.strip()]


def ensure_local_exclude(
    repo: Path,
    artifact_root: Path = ARTIFACT_ROOT,
    exclude_marker: str = EXCLUDE_MARKER,
    probe_name: str = ".review-code-dev-ignore-check",
) -> dict[str, Any]:
    exclude_path = git_path(repo, "info/exclude")
    exclude_path.parent.mkdir(parents=True, exist_ok=True)
    before = exclude_path.read_text(encoding="utf-8") if exclude_path.exists() else ""

    exclude_lines = (f"/{artifact_root.as_posix().strip('/')}/",)
    missing = [line for line in exclude_lines if line not in before.splitlines()]
    added = False
    if missing:
        suffix = "" if before.endswith("\n") or not before else "\n"
        block = suffix + exclude_marker + "\n" + "\n".join(missing) + "\n"
        exclude_path.write_text(before + block, encoding="utf-8")
        added = True

    probe = artifact_root / probe_name
    check = run(["git", "check-ignore", "-q", "--", probe.as_posix()], repo)
    return {
        "path": str(exclude_path),
        "added": added,
        "verified": check.returncode == 0,
        "probe": probe.as_posix(),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cwd", default=".", help="Repository working directory")
    parser.add_argument("--repo-slug", help="Slug to use in the run directory name")
    parser.add_argument("--timestamp", help="YYYYMMDD-HHMMSS timestamp override")
    parser.add_argument("--artifact-root", default=ARTIFACT_ROOT.as_posix())
    parser.add_argument("--exclude-marker", default=EXCLUDE_MARKER)
    parser.add_argument("--probe-name", default=".review-code-dev-ignore-check")
    parser.add_argument("--skill-name", default="review-code-dev")
    parser.add_argument("--output", help="Write metadata JSON to this path")
    args = parser.parse_args()

    cwd = Path(args.cwd).resolve()
    artifact_root = Path(args.artifact_root)
    if (
        artifact_root.is_absolute()
        or ".." in artifact_root.parts
        or len(artifact_root.parts) < 2
        or artifact_root.parts[0] != "plans"
    ):
        raise SystemExit("Artifact root must be a repository-relative path below plans/.")
    repo = detect_repo(cwd)
    if repo is None:
        raise SystemExit("Mega Code Review requires a Git repository for non-committable artifacts.")

    tracked = tracked_artifacts(repo, artifact_root)
    if tracked:
        raise SystemExit(
            f"Refusing to write artifacts because {artifact_root.as_posix()} is already tracked by Git: "
            + ", ".join(tracked[:10])
        )

    exclude = ensure_local_exclude(
        repo,
        artifact_root,
        args.exclude_marker,
        args.probe_name,
    )
    if not exclude["verified"]:
        raise SystemExit(
            "Refusing to write artifacts because Git ignore verification failed for "
            + exclude["probe"]
        )

    timestamp = args.timestamp or datetime.now().strftime("%Y%m%d-%H%M%S")
    repo_slug = slugify(args.repo_slug or repo.name)
    run_dir = repo / artifact_root / "runs" / f"{timestamp}-{repo_slug}"
    run_dir.mkdir(parents=True, exist_ok=False)

    rel_run_dir = run_dir.relative_to(repo).as_posix()
    metadata = {
        "skill": args.skill_name,
        "repo_root": str(repo),
        "run_dir": str(run_dir),
        "run_dir_relative": rel_run_dir,
        "artifact_root": artifact_root.as_posix(),
        "git_exclude": exclude,
        "tracked_artifacts": tracked,
        "non_committable": True,
        "git_ignore_rule": f"/{artifact_root.as_posix().strip('/')}/",
    }

    metadata_path = Path(args.output).resolve() if args.output else run_dir / "run-metadata.json"
    metadata_path.parent.mkdir(parents=True, exist_ok=True)
    metadata_path.write_text(json.dumps(metadata, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(json.dumps(metadata, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
