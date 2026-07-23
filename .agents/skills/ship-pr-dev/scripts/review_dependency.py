from __future__ import annotations

import json
import os
import re
from pathlib import Path


EXPECTED_SKILL_ID = "b0780a97-6972-4a2b-8e88-f41a528900c7"
MINIMUM_VERSION = (1, 2, 2)


def compatible_review_skill(candidate: Path) -> bool:
    manifest_path = candidate / "companion.json"
    required_scripts = (
        candidate / "scripts" / "collect_review_context.py",
        candidate / "scripts" / "prepare_review_run.py",
    )
    if not (candidate / "SKILL.md").is_file() or not all(path.is_file() for path in required_scripts):
        return False
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return False
    match = re.fullmatch(r"(\d+)\.(\d+)\.(\d+)(?:[-+].*)?", str(manifest.get("version", "")))
    version = tuple(int(part) for part in match.groups()) if match else (0, 0, 0)
    return (
        manifest.get("name") == "review-code-dev"
        and manifest.get("metadata", {}).get("companionSkillId") == EXPECTED_SKILL_ID
        and version >= MINIMUM_VERSION
    )


def resolve_review_skill_dir() -> Path:
    script_dir = Path(__file__).resolve().parent
    cwd = Path.cwd().resolve()
    candidates = []
    configured = os.environ.get("REVIEW_CODE_DEV_SKILL_DIR")
    if configured:
        candidates.append(Path(configured).expanduser())
    candidates.append(script_dir.parents[1] / "review-code-dev")
    candidates.extend(parent / ".agents" / "skills" / "review-code-dev" for parent in (cwd, *cwd.parents))
    candidates.extend(
        Path.home() / library / "review-code-dev"
        for library in (".agents/skills", ".codex/skills", ".claude/skills")
    )

    seen: set[Path] = set()
    for candidate in candidates:
        resolved = candidate.resolve()
        if resolved in seen:
            continue
        seen.add(resolved)
        if compatible_review_skill(resolved):
            return resolved
    raise RuntimeError(
        "compatible review-code-dev dependency (id b0780a97..., version >=1.2.2) not found; "
        "set REVIEW_CODE_DEV_SKILL_DIR to its installed skill directory"
    )
