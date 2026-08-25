#!/usr/bin/env python3
"""Tests for box_list / box_get: id validation, pagination guards, name filters.
No network access anywhere."""

from __future__ import annotations

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import box_get  # noqa: E402
import box_list  # noqa: E402
import prodlib  # noqa: E402

ENV = {
    "COMPANION_BOX_API_BASE": "https://ascii.dev/api/box/v1",
    "COMPANION_BOX_API_KEY": "box_test_key_value",
}

COMPANION_A = "2f111883-7f11-42e0-81fa-359e5b7b9727"
COMPANION_B = "9112f048-26f0-4d8d-9112-f04826f04d8d"


def page(boxes, page_info):
    body = {"boxes": boxes}
    if page_info is not None:
        body["pageInfo"] = page_info
    return body


class BoxIdValidationTest(unittest.TestCase):
    def test_valid_id(self):
        self.assertTrue(prodlib.BOX_ID_RE.match("bx_abcdefgh"))
        self.assertTrue(prodlib.BOX_ID_RE.match("bx_23456789"))

    def test_invalid_ids(self):
        for bad in ("bx_ABCDEFGH", "bx_abcdefg", "bx_abcdefghi", "bx_abcdefg1",
                    "bx_abcdefgo", "bx_abcdefgl", "abcdefgh", "bx-abcdefgh"):
            self.assertIsNone(prodlib.BOX_ID_RE.match(bad), bad)

    def test_box_get_rejects_invalid_id_before_any_call(self):
        def http(*args, **kwargs):
            raise AssertionError("box_get must validate the id before any HTTP call")

        with self.assertRaises(prodlib.ProdToolError):
            box_get.get_box(ENV, "bx_INVALID!", http=http)

    def test_box_get_fetches_valid_id(self):
        def http(method, url, headers=None, **kwargs):
            self.assertEqual(method, "GET")
            self.assertTrue(url.endswith("/boxes/bx_abcdefgh"))
            self.assertIn("Authorization", headers)
            return 200, {"id": "bx_abcdefgh", "name": "Companion x g1", "state": "idle"}

        box = box_get.get_box(ENV, "bx_abcdefgh", http=http)
        self.assertEqual(box["state"], "idle")


class PaginationTest(unittest.TestCase):
    def test_cursor_loop_walks_all_pages(self):
        pages = {
            None: page([{"id": "bx_aaaaaaaa"}], {"hasMore": True, "nextCursor": "c2"}),
            "c2": page([{"id": "bx_bbbbbbbb"}], {"hasMore": False, "nextCursor": None}),
        }
        requested = []

        def http(method, url, headers=None, **kwargs):
            self.assertEqual(method, "GET")
            self.assertIn("limit=200", url)
            self.assertIn("sort=desc", url)
            cursor = None
            if "cursor=" in url:
                cursor = url.split("cursor=")[1].split("&")[0]
            requested.append(cursor)
            return 200, pages[cursor]

        boxes = box_list.list_all_boxes(ENV, http=http)
        self.assertEqual([box["id"] for box in boxes], ["bx_aaaaaaaa", "bx_bbbbbbbb"])
        self.assertEqual(requested, [None, "c2"])

    def test_repeated_cursor_fails_closed(self):
        def http(method, url, headers=None, **kwargs):
            return 200, page([{"id": f"bx_{os.urandom(4).hex()[:8]}"}],
                             {"hasMore": True, "nextCursor": "same"})

        # First page accepts cursor "same"; second page repeating it must fail.
        with self.assertRaises(prodlib.ProdToolError):
            box_list.list_all_boxes(ENV, http=http)

    def test_repeated_box_id_fails_closed(self):
        def http(method, url, headers=None, **kwargs):
            return 200, page(
                [{"id": "bx_aaaaaaaa"}, {"id": "bx_aaaaaaaa"}],
                {"hasMore": False, "nextCursor": None},
            )

        with self.assertRaises(prodlib.ProdToolError):
            box_list.list_all_boxes(ENV, http=http)

    def test_full_page_without_page_info_fails_closed(self):
        def http(method, url, headers=None, **kwargs):
            boxes = [{"id": f"bx_{index:08d}"} for index in range(box_list.PAGE_LIMIT)]
            return 200, page(boxes, None)

        with self.assertRaises(prodlib.ProdToolError):
            box_list.list_all_boxes(ENV, http=http)

    def test_partial_page_without_page_info_terminates(self):
        def http(method, url, headers=None, **kwargs):
            return 200, page([{"id": "bx_aaaaaaaa"}], None)

        boxes = box_list.list_all_boxes(ENV, http=http)
        self.assertEqual(len(boxes), 1)

    def test_has_more_with_null_cursor_fails_closed(self):
        def http(method, url, headers=None, **kwargs):
            return 200, page([{"id": "bx_aaaaaaaa"}], {"hasMore": True, "nextCursor": None})

        with self.assertRaises(prodlib.ProdToolError):
            box_list.list_all_boxes(ENV, http=http)

    def test_non_200_fails_closed(self):
        def http(method, url, headers=None, **kwargs):
            return 503, {"code": "unavailable"}

        with self.assertRaises(prodlib.ProdToolError):
            box_list.list_all_boxes(ENV, http=http)


class FilterTest(unittest.TestCase):
    BOXES = [
        {"id": "bx_aaaaaaaa", "name": f"Companion {COMPANION_A} g1", "state": "archived"},
        {"id": "bx_bbbbbbbb", "name": f"Companion {COMPANION_A} g2", "state": "idle"},
        {"id": "bx_cccccccc", "name": f"Companion {COMPANION_A} g2", "state": "running"},
        {"id": "bx_dddddddd", "name": f"Companion {COMPANION_B} g1", "state": "idle"},
        {"id": "bx_eeeeeeee", "name": "unrelated box", "state": "idle"},
    ]

    def test_companion_filter_returns_all_generations(self):
        matched = box_list.filter_boxes(self.BOXES, companion=COMPANION_A)
        self.assertEqual(
            [box["id"] for box in matched],
            ["bx_aaaaaaaa", "bx_bbbbbbbb", "bx_cccccccc"],
        )
        self.assertEqual([box["generation"] for box in matched], [1, 2, 2])

    def test_duplicate_generation_detection(self):
        matched = box_list.filter_boxes(self.BOXES, companion=COMPANION_A)
        self.assertEqual(box_list.duplicate_generations(matched), {2: 2})
        clean = box_list.filter_boxes(self.BOXES, companion=COMPANION_B)
        self.assertEqual(box_list.duplicate_generations(clean), {})

    def test_state_and_name_filters(self):
        idle = box_list.filter_boxes(self.BOXES, state="idle")
        self.assertEqual(len(idle), 3)
        named = box_list.filter_boxes(self.BOXES, name_contains="unrelated")
        self.assertEqual([box["id"] for box in named], ["bx_eeeeeeee"])

    def test_generation_qualified_name_regex_is_exact(self):
        self.assertIsNone(box_list.COMPANION_NAME_RE.match(f"Companion {COMPANION_A}"))
        self.assertIsNone(box_list.COMPANION_NAME_RE.match(f"companion {COMPANION_A} g1"))
        self.assertIsNone(box_list.COMPANION_NAME_RE.match(f"Companion {COMPANION_A} g1 extra"))


if __name__ == "__main__":
    unittest.main()
