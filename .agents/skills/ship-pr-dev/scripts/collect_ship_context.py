#!/usr/bin/env python3
"""Collect deterministic branch context for ship-pr-dev."""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

from review_dependency import resolve_review_skill_dir


FRONTEND_RE = re.compile(
    r"(\.(tsx|jsx|vue|svelte|css|scss|less)$|(^|/)(components|pages|routes|app|styles|theme|tokens|assets)/)",
    re.IGNORECASE,
)
BACKEND_RE = re.compile(
    r"(\.(py|rb|go|rs|java|kt|php|cs)$|(^|/)(api|server|backend|services|jobs|workers|controllers|models|routes)/)",
    re.IGNORECASE,
)
DB_RE = re.compile(r"(^|/)(migrations?|schema|prisma|db)/|schema\.(sql|rb|prisma)$", re.IGNORECASE)
SECURITY_RE = re.compile(
    r"(auth|permission|policy|role|token|secret|privacy|pii|billing|export|upload|download)",
    re.IGNORECASE,
)
MANIFEST_NAMES = {
    "package.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "package-lock.json",
    "pyproject.toml",
    "requirements.txt",
    "Cargo.toml",
    "go.mod",
    "Gemfile",
    "mix.exs",
    "pom.xml",
    "build.gradle",
    "Makefile",
}
CI_PARTS = {".github/workflows", ".gitlab-ci.yml", "circle.yml", ".circleci", "azure-pipelines.yml"}


def run(cwd: Path, args: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        args,
        cwd=str(cwd),
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )


def git(cwd: Path, args: list[str]) -> subprocess.CompletedProcess[str]:
    return run(cwd, ["git", *args])


def lines(text: str) -> list[str]:
    return [line for line in text.splitlines() if line.strip()]


def collect_review_context(repo_root: Path, base: str | None) -> dict:
    collector_path = resolve_review_skill_dir() / "scripts" / "collect_review_context.py"
    command = [
        sys.executable,
        str(collector_path),
        "--cwd",
        str(repo_root),
        "--mode",
        "base",
    ]
    if base:
        command.extend(["--base", base])
    result = run(repo_root, command)
    if result.returncode != 0:
        raise RuntimeError(
            "review-code-dev context collection failed: "
            + (result.stderr.strip() or f"exit code {result.returncode}")
        )
    try:
        payload = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise RuntimeError("review-code-dev context collector returned invalid JSON") from exc
    required = {"diff_ref", "diff_range", "diff_stat"}
    if not required.issubset(payload):
        missing = ", ".join(sorted(required - payload.keys()))
        raise RuntimeError(f"review-code-dev context is missing required fields: {missing}")
    return payload


def parse_name_status(output: str) -> list[dict[str, str]]:
    changed = []
    for line in lines(output):
        parts = line.split("\t")
        if len(parts) >= 2:
            path = parts[-1]
            changed.append({"status": parts[0], "path": path})
    return changed


def find_project_files(repo_root: Path) -> tuple[list[str], list[str]]:
    manifests: list[str] = []
    ci_files: list[str] = []
    listed = git(repo_root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"])
    if listed.returncode != 0:
        raise RuntimeError(f"failed to list repository files: {listed.stderr.strip()}")
    for rel in listed.stdout.split("\0"):
        if not rel:
            continue
        path = repo_root / rel
        if path.is_file() and path.name in MANIFEST_NAMES:
            manifests.append(rel)
        if path.is_file() and (
            any(rel.startswith(part) for part in CI_PARTS if "/" in part)
            or rel in CI_PARTS
        ):
            ci_files.append(rel)
    return sorted(manifests), sorted(ci_files)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--cwd", default=".")
    parser.add_argument("--base")
    parser.add_argument("--output")
    args = parser.parse_args()

    cwd = Path(args.cwd).resolve()
    root = git(cwd, ["rev-parse", "--show-toplevel"])
    if root.returncode != 0:
        raise SystemExit("ship-pr-dev requires a Git repository")
    repo_root = Path(root.stdout.strip()).resolve()

    branch = git(repo_root, ["branch", "--show-current"]).stdout.strip() or "DETACHED"
    review_context = collect_review_context(repo_root, args.base)
    base = review_context["diff_ref"]
    merge_base_result = git(repo_root, ["merge-base", base, "HEAD"])
    merge_base = merge_base_result.stdout.strip() if merge_base_result.returncode == 0 else None
    diff_range = review_context["diff_range"]

    name_status = git(repo_root, ["diff", "--name-status", diff_range])
    status = git(repo_root, ["status", "--short"])
    changed_files = parse_name_status(name_status.stdout)
    paths = [item["path"] for item in changed_files]
    manifests, ci_files = find_project_files(repo_root)

    context = {
        "repo_root": str(repo_root),
        "branch": branch,
        "base": base,
        "merge_base": merge_base,
        "diff_range": diff_range,
        "git_status_short": lines(status.stdout),
        "diff_stat": review_context["diff_stat"].strip(),
        "changed_files": changed_files,
        "impact": {
            "frontend": any(FRONTEND_RE.search(path) for path in paths),
            "backend": any(BACKEND_RE.search(path) for path in paths),
            "db": any(DB_RE.search(path) for path in paths),
            "security_or_privacy": any(SECURITY_RE.search(path) for path in paths),
            "docs_only": bool(paths)
            and all(re.search(r"(\.md$|^docs/|^README|^CHANGELOG)", path, re.IGNORECASE) for path in paths),
        },
        "project_files": {
            "manifests": manifests,
            "ci": ci_files,
        },
    }

    output = json.dumps(context, indent=2, sort_keys=True) + "\n"
    if args.output:
        Path(args.output).write_text(output, encoding="utf-8")
    print(output, end="")


if __name__ == "__main__":
    main()
