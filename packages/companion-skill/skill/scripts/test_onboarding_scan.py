#!/usr/bin/env python3
"""Protection: bounded onboarding discovery groups copies and excludes managed installs.

Product promise: onboarding proposes only untracked skills from the registered current-user and
current-project roots. Regression caught: recursive filesystem discovery, duplicate proposals,
Companion self-upload, tracked org installs, and ambiguous same-slug copies. Level: local unit test
because discovery and grouping are deterministic filesystem behavior. Failure proof: fixtures place
a tempting SKILL.md outside every registry root and assert it is absent.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import companion_lib  # noqa: E402
import onboarding_scan  # noqa: E402


class OnboardingScanTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.home = self.root / "home"
        self.project = self.root / "project"
        self.home.mkdir()
        self.project.mkdir()
        self.registry = self.root / "tools.json"
        self.registry.write_text(
            json.dumps(
                {
                    "tools": {
                        "claude-code": {
                            "skillsDir": {
                                "user": str(self.home / ".claude" / "skills"),
                                "project": ".claude/skills",
                            }
                        },
                        "codex": {
                            "skillsDir": {
                                "user": str(self.home / ".codex" / "skills"),
                                "project": ".codex/skills",
                            }
                        },
                        "opencode": {
                            "skillsDir": {
                                "user": str(self.home / ".agents" / "skills"),
                                "project": ".agents/skills",
                            }
                        },
                        "openclaw": {
                            "skillsDir": {
                                "user": str(self.home / ".openclaw" / "skills"),
                                "project": "skills",
                            }
                        },
                        "hermes": {
                            "skillsDir": {
                                "user": str(self.home / ".hermes" / "skills"),
                            },
                            "recursive": True,
                        },
                    }
                }
            ),
            encoding="utf-8",
        )
        self.user_lock = self.home / ".companion" / "skills.lock.json"
        self.project_lock = self.project / ".companion" / "skills.lock.json"

    def tearDown(self):
        self.temp.cleanup()

    def skill(self, path: Path, slug: str, body: str = "body", skill_id: str | None = None):
        path.mkdir(parents=True)
        (path / "SKILL.md").write_text(f"---\nname: {slug}\n---\n{body}\n", encoding="utf-8")
        if skill_id:
            (path / "companion.json").write_text(
                json.dumps(
                    {
                        "name": slug,
                        "metadata": {"companionSkillId": skill_id},
                    }
                ),
                encoding="utf-8",
            )
        return path

    def run_scan(self):
        return self.run_scan_result()["candidates"]

    def run_scan_result(self):
        return onboarding_scan.scan(
            registry_path=self.registry,
            home=self.home,
            project_root=self.project,
            user_lockfile=self.user_lock,
            project_lockfile=self.project_lock,
            companion_skill_id="COMPANION-ID",
        )

    def test_reads_the_bundled_companion_skill_id_without_cli_configuration(self):
        self.assertEqual(
            "b0780a97-6972-4a2b-8e88-f41a528900c7",
            onboarding_scan._bundled_companion_skill_id(),
        )

    def test_requires_an_absolute_project_root(self):
        with self.assertRaisesRegex(argparse.ArgumentTypeError, "must be an absolute"):
            onboarding_scan._absolute_project_arg("nested/project")

    def test_groups_identical_copies_across_global_and_project_roots(self):
        first = self.skill(self.home / ".claude/skills/alpha", "alpha")
        second = self.skill(self.project / ".codex/skills/alpha", "alpha")
        self.assertEqual(
            companion_lib.compute_dir_checksum(first),
            companion_lib.compute_dir_checksum(second),
        )
        self.assertEqual(
            companion_lib.compute_dir_checksum(first),
            onboarding_scan._bounded_dir_checksum(first, self.home / ".claude/skills"),
        )

        rows = self.run_scan()

        self.assertEqual(1, len(rows))
        self.assertEqual("candidate", rows[0]["status"])
        self.assertEqual(
            {("claude-code", "user"), ("codex", "project")},
            {(copy["tool"], copy["scope"]) for copy in rows[0]["copies"]},
        )

    def test_same_slug_different_checksums_are_blocking_conflicts(self):
        self.skill(self.home / ".claude/skills/alpha", "alpha", "one")
        self.skill(self.home / ".codex/skills/alpha", "alpha", "two")

        rows = self.run_scan()

        self.assertEqual(2, len(rows))
        self.assertEqual({"conflict"}, {row["status"] for row in rows})

    def test_discovers_nested_hermes_skills_but_ignores_hub_state(self):
        nested = self.skill(
            self.home / ".hermes/skills/research/web-search",
            "web-search",
        )
        self.skill(self.home / ".hermes/skills/.hub/quarantine/blocked", "blocked")

        rows = self.run_scan()

        self.assertEqual(["web-search"], [row["slug"] for row in rows])
        self.assertEqual(
            {
                "tool": "hermes",
                "scope": "user",
                "path": str(nested),
            },
            rows[0]["copies"][0],
        )

    def test_excludes_companion_and_lockfile_tracked_by_path_or_slug_checksum(self):
        self.skill(self.home / ".claude/skills/companion", "different", skill_id="COMPANION-ID")
        tracked_path = self.skill(self.home / ".codex/skills/tracked-path", "tracked-path")
        tracked_checksum = self.skill(self.project / ".agents/skills/tracked-checksum", "tracked-checksum")
        self.user_lock.parent.mkdir(parents=True)
        self.user_lock.write_text(
            json.dumps(
                {
                    "lockfileVersion": 2,
                    "workspaces": {
                        "workspace": {
                            "skills": {
                                "tracked-path": {
                                    "slug": "tracked-path",
                                    "targets": [{"path": str(tracked_path), "tool": "codex", "scope": "user"}],
                                },
                                "tracked-checksum": {
                                    "slug": "tracked-checksum",
                                    "targets": [
                                        {
                                            "path": "/old/location",
                                            "checksum": companion_lib.compute_dir_checksum(tracked_checksum),
                                            "tool": "opencode",
                                            "scope": "project",
                                        }
                                    ],
                                },
                            }
                        }
                    },
                }
            ),
            encoding="utf-8",
        )

        self.assertEqual([], self.run_scan())

    def test_never_scans_openclaw_parent_or_outside_registry_roots(self):
        self.skill(self.home / ".openclaw/skills/ignored", "ignored")
        self.skill(self.project / "outside", "outside")
        self.skill(self.root / "another-project/.claude/skills/also-ignored", "also-ignored")
        self.skill(self.home / ".agents/skills/included", "included")

        rows = self.run_scan()

        self.assertEqual(["included"], [row["slug"] for row in rows])

    def test_blocks_oversized_packages_without_reading_them(self):
        skill = self.skill(self.home / ".claude/skills/oversized", "oversized")
        payload = skill / "payload.bin"
        payload.write_bytes(b"too large")

        with mock.patch.object(onboarding_scan, "MAX_SKILL_FILE_BYTES", 4):
            result = self.run_scan_result()

        self.assertEqual([], result["candidates"])
        self.assertEqual("blocked", result["blocked"][0]["status"])
        self.assertEqual("file_size_limit", result["blocked"][0]["reason"])
        self.assertEqual(str(skill), result["blocked"][0]["copies"][0]["path"])

    def test_blocks_excessive_depth_and_file_counts(self):
        deep = self.skill(self.home / ".claude/skills/deep", "deep")
        (deep / "one/two").mkdir(parents=True)
        (deep / "one/two/data").write_text("x", encoding="utf-8")
        crowded = self.skill(self.home / ".codex/skills/crowded", "crowded")
        (crowded / "extra").write_text("x", encoding="utf-8")

        with (
            mock.patch.object(onboarding_scan, "MAX_SKILL_DEPTH", 1),
            mock.patch.object(onboarding_scan, "MAX_SKILL_FILES", 1),
        ):
            result = self.run_scan_result()

        self.assertEqual([], result["candidates"])
        self.assertEqual(
            {"depth_limit", "file_count_limit"},
            {row["reason"] for row in result["blocked"]},
        )

    def test_bounds_total_directory_entries_before_sorting(self):
        wide = self.skill(self.home / ".claude/skills/wide", "wide")
        for name in ("one", "two", "three"):
            (wide / name).mkdir()

        with mock.patch.object(onboarding_scan, "MAX_SKILL_ENTRIES", 2):
            result = self.run_scan_result()

        self.assertEqual([], result["candidates"])
        self.assertEqual(["entry_count_limit"], [row["reason"] for row in result["blocked"]])

    def test_bounds_registry_entries_before_sorting(self):
        self.skill(self.home / ".claude/skills/one", "one")
        self.skill(self.home / ".claude/skills/two", "two")

        with mock.patch.object(onboarding_scan, "MAX_REGISTRY_ENTRIES", 1):
            result = self.run_scan_result()

        self.assertEqual([], result["candidates"])
        self.assertEqual(["registry_entry_limit"], [row["reason"] for row in result["blocked"]])


if __name__ == "__main__":
    unittest.main()
