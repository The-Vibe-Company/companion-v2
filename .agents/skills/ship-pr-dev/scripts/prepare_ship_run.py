#!/usr/bin/env python3
"""Prepare a non-committable artifact directory for ship-pr-dev."""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

from review_dependency import resolve_review_skill_dir


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--cwd", default=".")
    args = parser.parse_args()

    preparer_path = resolve_review_skill_dir() / "scripts" / "prepare_review_run.py"
    result = subprocess.run(
        [
            sys.executable,
            str(preparer_path),
            "--cwd",
            str(Path(args.cwd).resolve()),
            "--artifact-root",
            "plans/ship-pr-dev",
            "--exclude-marker",
            "# Ship PR artifacts",
            "--probe-name",
            ".ship-pr-dev-ignore-check",
            "--skill-name",
            "ship-pr-dev",
        ],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if result.returncode != 0:
        raise SystemExit(result.stderr.strip() or "ship-pr-dev artifact preparation failed")
    try:
        metadata = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise SystemExit("review-code-dev artifact preparer returned invalid JSON") from exc
    if metadata.get("skill") != "ship-pr-dev" or metadata.get("artifact_root") != "plans/ship-pr-dev":
        raise SystemExit("review-code-dev artifact preparer returned unexpected metadata")
    print(json.dumps(metadata))


if __name__ == "__main__":
    main()
