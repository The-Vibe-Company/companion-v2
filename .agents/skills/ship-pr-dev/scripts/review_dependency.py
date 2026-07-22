from __future__ import annotations

import os
from pathlib import Path


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
        if (resolved / "SKILL.md").is_file() and (resolved / "scripts").is_dir():
            return resolved
    raise RuntimeError(
        "review-code-dev dependency not found; set REVIEW_CODE_DEV_SKILL_DIR to its installed skill directory"
    )
