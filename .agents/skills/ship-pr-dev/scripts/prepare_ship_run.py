#!/usr/bin/env python3
"""Prepare a non-committable artifact directory for ship-pr-dev."""

from __future__ import annotations

import argparse
import importlib.util
import json
from datetime import datetime, timezone
from pathlib import Path

from review_dependency import resolve_review_skill_dir


ARTIFACT_ROOT = Path("plans/ship-pr-dev")


def load_review_preparer():
    module_path = resolve_review_skill_dir() / "scripts" / "prepare_review_run.py"
    spec = importlib.util.spec_from_file_location("review_code_dev_prepare_run", module_path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load review-code-dev artifact safety helpers: {module_path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--cwd", default=".")
    args = parser.parse_args()

    cwd = Path(args.cwd).resolve()
    review_preparer = load_review_preparer()
    repo_root = review_preparer.detect_repo(cwd)
    if repo_root is None:
        raise SystemExit("ship-pr-dev requires a Git repository")
    tracked = review_preparer.tracked_artifacts(repo_root, ARTIFACT_ROOT)
    if tracked:
        raise SystemExit("plans/ship-pr-dev/ is tracked by Git; refusing to write artifacts")
    exclude = review_preparer.ensure_local_exclude(
        repo_root,
        ARTIFACT_ROOT,
        "# Ship PR artifacts",
        ".ship-pr-dev-ignore-check",
    )
    if not exclude["verified"]:
        raise SystemExit("plans/ship-pr-dev/ is not ignored by Git; refusing to write artifacts")

    timestamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    repo_slug = review_preparer.slugify(repo_root.name)
    run_dir = repo_root / ARTIFACT_ROOT / "runs" / f"{timestamp}-{repo_slug}"
    run_dir.mkdir(parents=True, exist_ok=False)

    metadata = {
        "skill": "ship-pr-dev",
        "timestamp_utc": timestamp,
        "cwd": str(cwd),
        "repo_root": str(repo_root),
        "repo_slug": repo_slug,
        "run_dir": str(run_dir),
        "artifact_root": ARTIFACT_ROOT.as_posix(),
        "git_exclude": exclude,
        "tracked_artifacts": tracked,
        "non_committable": True,
        "git_ignore_rule": "/plans/ship-pr-dev/",
    }
    (run_dir / "run-metadata.json").write_text(
        json.dumps(metadata, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(metadata))


if __name__ == "__main__":
    main()
