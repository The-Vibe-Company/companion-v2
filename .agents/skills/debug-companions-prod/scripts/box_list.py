#!/usr/bin/env python3
"""List box.ascii.dev Boxes (GET only — this script has no mutation code path).

Mirrors the pagination contract of ``listAllBoxes`` in
packages/box-runtime/src/boxMaintenanceClient.ts: ``GET /boxes?limit=200&sort=desc``
plus a cursor loop with fail-closed guards against repeated cursors, repeated
Box ids, and a full page without pagination info.

``--companion <uuid>`` filters Runtime v2 generation-qualified names
(``Companion <uuid> g<generation>``) and prints every generation. Two Boxes
sharing one generation is evidence of ``box_create_ambiguous``.
"""

from __future__ import annotations

import argparse
import os
import re
import sys
import urllib.parse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import prodlib  # noqa: E402

PAGE_LIMIT = 200  # BOX_LIST_PAGE_LIMIT in boxMaintenanceClient.ts

COMPANION_NAME_RE = re.compile(
    r"^Companion ([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}) g(\d+)$",
)


def box_headers(env: dict) -> dict:
    return {"Authorization": f"Bearer {prodlib.require(env, 'COMPANION_BOX_API_KEY')}"}


def list_all_boxes(env: dict, http=prodlib.http_json) -> list[dict]:
    """Fetch every Box page with the same fail-closed guards as the runtime client."""
    base = prodlib.require(env, "COMPANION_BOX_API_BASE").rstrip("/")
    headers = box_headers(env)
    boxes: list[dict] = []
    seen_box_ids: set[str] = set()
    seen_cursors: set[str] = set()
    cursor: str | None = None

    while True:
        query = f"limit={PAGE_LIMIT}&sort=desc"
        if cursor is not None:
            query += f"&cursor={urllib.parse.quote(cursor, safe='')}"
        status, body = http("GET", f"{base}/boxes?{query}", headers=headers)
        if status != 200:
            raise prodlib.ProdToolError(f"Box API returned status {status} for the Box list")
        if not isinstance(body, dict) or not isinstance(body.get("boxes"), list):
            raise prodlib.ProdToolError("Box API returned an invalid Box list")

        page = body["boxes"]
        for box in page:
            if not isinstance(box, dict) or not isinstance(box.get("id"), str):
                raise prodlib.ProdToolError("Box API returned an invalid Box entry")
            if box["id"] in seen_box_ids:
                raise prodlib.ProdToolError("Box API repeated a Box across list pages")
            seen_box_ids.add(box["id"])
            boxes.append({
                "id": box["id"],
                "name": box.get("name"),
                "state": box.get("state"),
            })

        page_info = body.get("pageInfo")
        if page_info is None:
            if len(page) == PAGE_LIMIT:
                raise prodlib.ProdToolError(
                    "Box API omitted pagination for a full Box list page",
                )
            break
        if not isinstance(page_info, dict):
            raise prodlib.ProdToolError("Box API returned invalid Box list pagination")
        if not page_info.get("hasMore"):
            if page_info.get("nextCursor") is not None:
                raise prodlib.ProdToolError(
                    "Box API returned inconsistent Box list pagination",
                )
            break
        next_cursor = page_info.get("nextCursor")
        if not isinstance(next_cursor, str) or not next_cursor or next_cursor in seen_cursors:
            raise prodlib.ProdToolError("Box API returned invalid Box list pagination")
        seen_cursors.add(next_cursor)
        cursor = next_cursor

    return boxes


def filter_boxes(
    boxes: list[dict],
    state: str | None = None,
    name_contains: str | None = None,
    companion: str | None = None,
) -> list[dict]:
    matched = []
    for box in boxes:
        name = box.get("name") or ""
        if state and box.get("state") != state:
            continue
        if name_contains and name_contains.lower() not in name.lower():
            continue
        if companion:
            match = COMPANION_NAME_RE.match(name)
            if not match or match.group(1).lower() != companion.lower():
                continue
            box = {**box, "generation": int(match.group(2))}
        matched.append(box)
    if companion:
        matched.sort(key=lambda box: box.get("generation", 0))
    return matched


def duplicate_generations(matched: list[dict]) -> dict[int, int]:
    """generation -> box count, for generations owned by more than one Box."""
    counts: dict[int, int] = {}
    for box in matched:
        generation = box.get("generation")
        if isinstance(generation, int):
            counts[generation] = counts.get(generation, 0) + 1
    return {generation: count for generation, count in counts.items() if count > 1}


def main() -> None:
    parser = argparse.ArgumentParser(description="List provider Boxes (read-only)")
    parser.add_argument("--state", help="keep Boxes in this provider state")
    parser.add_argument("--name-contains", help="case-insensitive substring of the Box name")
    parser.add_argument("--companion", help="companion uuid; matches 'Companion <uuid> g<n>' names")
    parser.add_argument("--json", action="store_true", help="print structured JSON")
    args = parser.parse_args()

    if args.companion and not prodlib.UUID_RE.match(args.companion):
        prodlib.fail("--companion must be a uuid")

    env = prodlib.load_env()
    try:
        boxes = list_all_boxes(env)
    except prodlib.ProdToolError as error:
        prodlib.fail(str(error), code=1)
        return
    matched = filter_boxes(boxes, args.state, args.name_contains, args.companion)

    if args.json:
        prodlib.print_json(matched)
    else:
        prodlib.print_redacted(f"{'id':<12} {'state':<14} name")
        for box in matched:
            prodlib.print_redacted(
                f"{box['id']:<12} {str(box.get('state') or '-'):<14} {box.get('name') or '-'}",
            )
        prodlib.print_redacted(f"-- {len(matched)} of {len(boxes)} Boxes")

    if args.companion:
        for generation, count in sorted(duplicate_generations(matched).items()):
            prodlib.print_redacted(
                f"WARNING: generation g{generation} is owned by {count} Boxes — duplicate "
                "generations are box_create_ambiguous evidence. Do not delete either Box "
                "manually; see the runbook's Box lifecycle/provider outage section.",
            )


if __name__ == "__main__":
    main()
