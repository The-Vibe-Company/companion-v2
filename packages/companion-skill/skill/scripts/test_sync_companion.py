#!/usr/bin/env python3
"""Unit tests for the Companion multi-tool synchronization wrapper."""

from __future__ import annotations

import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import sync_companion  # noqa: E402


class SyncCompanionTests(unittest.TestCase):
    def context(self, *, errors=None, blocked=False, needs_update=False):
        return {
            "errors": errors or [],
            "companion": {
                "autoUpdate": {"blocked": blocked, "reason": "local_customizations" if blocked else None},
                "targets": [{"path": "/tmp/companion", "needsUpdate": needs_update}],
            },
        }

    def test_sync_result_succeeds_only_when_every_target_is_current(self):
        with mock.patch.object(sync_companion, "collect_context", return_value=self.context()):
            context, ok = sync_companion.sync_result("Codex")
        self.assertTrue(ok)
        self.assertFalse(context["companion"]["targets"][0]["needsUpdate"])

    def test_sync_result_fails_for_blocked_or_still_outdated_targets(self):
        for context in (
            self.context(blocked=True),
            self.context(needs_update=True),
            self.context(errors=[{"message": "network failed"}]),
        ):
            with self.subTest(context=context):
                with mock.patch.object(sync_companion, "collect_context", return_value=context):
                    _result, ok = sync_companion.sync_result("Codex")
                self.assertFalse(ok)


if __name__ == "__main__":
    unittest.main()
