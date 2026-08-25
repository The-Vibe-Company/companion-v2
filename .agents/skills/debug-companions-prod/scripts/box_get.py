#!/usr/bin/env python3
"""Fetch one box.ascii.dev Box by id (GET only — no mutation code path).

Validates the ``bx_`` id shape (the same regex the database CHECK uses) before
making any network call.
"""

from __future__ import annotations

import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import box_list  # noqa: E402
import prodlib  # noqa: E402


def get_box(env: dict, box_id: str, http=prodlib.http_json) -> dict:
    if not prodlib.BOX_ID_RE.match(box_id):
        raise prodlib.ProdToolError(
            f"{box_id!r} is not a valid Box id (expected bx_ plus 8 characters of "
            "the 23456789abcdefghjkmnpqrstuvwxyz alphabet)",
        )
    base = prodlib.require(env, "COMPANION_BOX_API_BASE").rstrip("/")
    status, body = http(
        "GET", f"{base}/boxes/{box_id}", headers=box_list.box_headers(env),
    )
    if status == 404:
        raise prodlib.ProdToolError(f"Box {box_id} was not found (already deleted or never created)")
    if status != 200 or not isinstance(body, dict):
        raise prodlib.ProdToolError(f"Box API returned status {status} for {box_id}")
    return body


def main() -> None:
    parser = argparse.ArgumentParser(description="Fetch one provider Box (read-only)")
    parser.add_argument("box_id", help="Box id, e.g. bx_abcdefgh")
    parser.add_argument("--json", action="store_true", help="print the full redacted payload")
    args = parser.parse_args()

    env = prodlib.load_env()
    try:
        box = get_box(env, args.box_id)
    except prodlib.ProdToolError as error:
        prodlib.fail(str(error), code=1)
        return

    if args.json:
        prodlib.print_json(box)
        return
    for key in ("id", "name", "state"):
        prodlib.print_redacted(f"{key}: {box.get(key)}")
    extras = sorted(key for key in box if key not in ("id", "name", "state"))
    if extras:
        prodlib.print_redacted(f"other fields (use --json): {', '.join(extras)}")


if __name__ == "__main__":
    main()
