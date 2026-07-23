#!/usr/bin/env python3
"""Synchronize every existing global Companion skill installation.

This is the deterministic repair command for machines where Claude Code, Codex,
OpenCode, or another registered host ended up with different Companion versions.
It delegates download, integrity checks, transaction rollback, and install
reporting to the normal bootstrap implementation.
"""

from __future__ import annotations

import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from bootstrap import collect_context  # noqa: E402


def sync_result(agent: str) -> tuple[dict, bool]:
    context = collect_context(auto_update=True, agent=agent)
    auto_update = context["companion"]["autoUpdate"]
    targets = context["companion"].get("targets") or []
    ok = (
        not context.get("errors")
        and not auto_update.get("blocked")
        and not any(target.get("needsUpdate") for target in targets)
    )
    return context, ok


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Synchronize existing global Companion installations across registered tools"
    )
    parser.add_argument(
        "--agent",
        default=os.environ.get("COMPANION_AGENT", "companion-sync"),
        help="agent label for install reporting",
    )
    parser.add_argument("--json", action="store_true", help="print the complete machine-readable result")
    args = parser.parse_args()

    context, ok = sync_result(args.agent)
    if args.json:
        print(json.dumps(context, indent=2, sort_keys=True))
    else:
        targets = context["companion"].get("targets") or []
        if ok:
            version = context["companion"].get("availableVersion") or context["companion"].get("localVersion")
            print(f"Companion {version} is synchronized across {len(targets)} existing installation(s).")
            for target in targets:
                tools = ", ".join(target.get("tools") or ["current"])
                print(f"  - {tools}: {target.get('version') or 'unknown'} at {target.get('path')}")
        else:
            reason = context["companion"]["autoUpdate"].get("reason") or "sync failed"
            print(f"Companion synchronization failed: {reason}", file=sys.stderr)
            for error in context.get("errors") or []:
                print(f"  - {error.get('message')}", file=sys.stderr)
    if not ok:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
