#!/usr/bin/env python3
"""Unit tests for the local Companion skill guard. Run with:

    python3 -m unittest discover -s packages/companion-skill/skill/scripts -p 'test_*.py'
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import companion_lib  # noqa: E402
import skill_guard  # noqa: E402


def entry(slug, skill_id=None, source="lockfile", version=None, path=None):
    return {"slug": slug, "skill_id": skill_id, "version": version, "path": path, "source": source}


def online_index(by_slug=None, archived_slugs=None, reported_by_slug=None):
    return {
        "by_slug": by_slug or {},
        "by_id": {},
        "archived_slugs": archived_slugs or set(),
        "reported_by_slug": reported_by_slug or {},
    }


def online_row(slug, skill_id=None, current_version=None, scope="org", archived=False):
    return {
        "slug": slug,
        "id": skill_id,
        "current_version": current_version,
        "scope": scope,
        "archived": archived,
    }


def kinds(conflicts):
    return {conflict["kind"] for conflict in conflicts}


class ConflictDetectionTests(unittest.TestCase):
    def test_id_multiple_slugs_blocks(self):
        entries = [
            entry("alpha", "ID-1", source="lockfile"),
            entry("beta", "ID-1", source="manifest:/tmp/beta", path="/tmp/beta"),
        ]
        conflicts = skill_guard.detect_conflicts(entries, online_index())
        self.assertIn(skill_guard.KIND_ID_MULTIPLE_SLUGS, kinds(conflicts))
        self.assertTrue(skill_guard.has_blocking(conflicts))
        self.assertEqual(2, skill_guard.exit_code_for(conflicts, None))

    def test_id_mismatch_online_blocks(self):
        entries = [entry("alpha", "LOCAL-ID", source="lockfile", version="1.0.0")]
        online = online_index(by_slug={"alpha": online_row("alpha", "REMOTE-ID", "1.0.0")})
        conflicts = skill_guard.detect_conflicts(entries, online)
        self.assertIn(skill_guard.KIND_ID_MISMATCH_ONLINE, kinds(conflicts))
        self.assertTrue(skill_guard.has_blocking(conflicts))

    def test_lock_two_slugs_one_id_requests_repair(self):
        entries = [
            entry("alpha", "ID-1", source="lockfile"),
            entry("beta", "ID-1", source="lockfile"),
        ]
        conflicts = skill_guard.detect_conflicts(entries, online_index())
        repair = [c for c in conflicts if c["kind"] == skill_guard.KIND_LOCK_TWO_SLUGS]
        self.assertEqual(1, len(repair))
        self.assertEqual("request repair", repair[0]["remediation"])

    def test_duplicate_companion_id_manifests_blocks(self):
        entries = [
            entry("skill-x", "DUP-ID", source="manifest:/tmp/x", path="/tmp/x"),
            entry("skill-y", "DUP-ID", source="manifest:/tmp/y", path="/tmp/y"),
        ]
        conflicts = skill_guard.detect_conflicts(entries, online_index())
        self.assertIn(skill_guard.KIND_DUP_COMPANION_ID, kinds(conflicts))

    def test_duplicate_local_skill_name_same_id_warns(self):
        entries = [
            entry("ship-pr", "SHIP-ID", source="manifest:/tmp/one", path="/tmp/one"),
            entry("ship-pr", "SHIP-ID", source="manifest:/tmp/two", path="/tmp/two"),
        ]
        conflicts = skill_guard.detect_conflicts(entries, online_index())
        duplicate = [c for c in conflicts if c["kind"] == skill_guard.KIND_DUPLICATE_LOCAL_SKILL_NAME]
        self.assertEqual(1, len(duplicate))
        self.assertEqual("warn", duplicate[0]["severity"])
        self.assertFalse(skill_guard.has_blocking(conflicts))
        self.assertNotIn(skill_guard.KIND_DUP_COMPANION_ID, kinds(conflicts))
        self.assertIn("/tmp/one", {item["path"] for item in duplicate[0]["evidence"]})
        self.assertIn("/tmp/two", {item["path"] for item in duplicate[0]["evidence"]})

    def test_duplicate_local_skill_name_missing_ids_warns(self):
        entries = [
            entry("ship-pr", None, source="skill:/tmp/one", path="/tmp/one"),
            entry("ship-pr", None, source="skill:/tmp/two", path="/tmp/two"),
        ]
        conflicts = skill_guard.detect_conflicts(entries, online_index())
        duplicate = [c for c in conflicts if c["kind"] == skill_guard.KIND_DUPLICATE_LOCAL_SKILL_NAME]
        self.assertEqual(1, len(duplicate))
        self.assertEqual("warn", duplicate[0]["severity"])
        self.assertFalse(skill_guard.has_blocking(conflicts))

    def test_stale_backup_skill_folder_blocks(self):
        entries = [
            entry("ship-pr", None, source="skill:/tmp/ship-pr", path="/tmp/ship-pr"),
            entry("ship-pr", None, source="skill:/tmp/ship-pr.backup-1.0.3", path="/tmp/ship-pr.backup-1.0.3"),
        ]
        conflicts = skill_guard.detect_conflicts(entries, online_index())
        stale = [c for c in conflicts if c["kind"] == skill_guard.KIND_STALE_BACKUP_SKILL_FOLDER]
        self.assertEqual(1, len(stale))
        self.assertEqual("block", stale[0]["severity"])
        self.assertIn("must be deleted", stale[0]["detail"])
        self.assertTrue(skill_guard.has_blocking(conflicts))
        self.assertNotIn(skill_guard.KIND_DUPLICATE_LOCAL_SKILL_NAME, kinds(conflicts))

    def test_hidden_companion_backup_skill_folder_blocks(self):
        entries = [
            entry("companion", None, source="skill:/tmp/.companion-backup.abc", path="/tmp/.companion-backup.abc"),
        ]
        conflicts = skill_guard.detect_conflicts(entries, online_index())
        self.assertIn(skill_guard.KIND_STALE_BACKUP_SKILL_FOLDER, kinds(conflicts))
        self.assertTrue(skill_guard.has_blocking(conflicts))

    def test_duplicate_local_skill_name_different_ids_still_blocks(self):
        entries = [
            entry("ship-pr", "SHIP-ID-1", source="manifest:/tmp/one", path="/tmp/one"),
            entry("ship-pr", "SHIP-ID-2", source="manifest:/tmp/two", path="/tmp/two"),
        ]
        conflicts = skill_guard.detect_conflicts(entries, online_index())
        self.assertIn(skill_guard.KIND_SLUG_MULTIPLE_IDS, kinds(conflicts))
        self.assertTrue(skill_guard.has_blocking(conflicts))

    def test_archived_online_is_missing_or_archived_not_current(self):
        status, _ = companion_lib.status_for_local_guarded(
            {"name": "alpha", "version": "1.0.0"},
            {"alpha": online_row("alpha", "ID-1", "2.0.0", archived=True)},
            {},
            {"alpha"},
        )
        self.assertEqual("missing_or_archived", status)

        entries = [entry("alpha", "ID-1", source="lockfile", version="1.0.0")]
        online = online_index(
            by_slug={"alpha": online_row("alpha", "ID-1", "2.0.0", archived=True)},
            archived_slugs={"alpha"},
        )
        conflicts = skill_guard.detect_conflicts(entries, online)
        missing = [c for c in conflicts if c["kind"] == skill_guard.KIND_MISSING_OR_ARCHIVED]
        self.assertEqual(1, len(missing))
        self.assertEqual("warn", missing[0]["severity"])

    def test_distinct_ids_do_not_block_each_other(self):
        # The canonical false-positive case: two close names, distinct ids, no conflict.
        entries = [
            entry("catalogue-proofreading", "ID-CATALOGUE", source="lockfile", version="1.0.0"),
            entry("vibe-catalog-proofreading", "ID-VIBE", source="lockfile", version="1.0.0"),
        ]
        online = online_index(
            by_slug={
                "catalogue-proofreading": online_row("catalogue-proofreading", "ID-CATALOGUE", "1.0.0"),
                "vibe-catalog-proofreading": online_row("vibe-catalog-proofreading", "ID-VIBE", "1.0.0"),
            }
        )
        conflicts = skill_guard.detect_conflicts(entries, online)
        self.assertEqual([], conflicts)
        self.assertEqual(0, skill_guard.exit_code_for(conflicts, None))

    def test_installed_only_slug_not_flagged_missing(self):
        # An installed org skill is present via the installed/mine union -> not "missing".
        entries = [entry("shared-skill", "ID-1", source="lockfile", version="1.0.0")]
        online = online_index(
            by_slug={"shared-skill": online_row("shared-skill", "ID-1", "1.0.0", scope="org")},
            reported_by_slug={"shared-skill": online_row("shared-skill", "ID-1", "1.0.0")},
        )
        conflicts = skill_guard.detect_conflicts(entries, online)
        self.assertNotIn(skill_guard.KIND_MISSING_OR_ARCHIVED, kinds(conflicts))


class CreatePreflightTests(unittest.TestCase):
    def test_create_existing_online_refused(self):
        result = skill_guard.create_preflight(
            "alpha",
            {"alpha": online_row("alpha", "ID-1", "1.0.0", scope="org")},
            set(), set(), set(), set(),
        )
        self.assertFalse(result["allowed"])
        self.assertIn("org", result["found_in"])
        self.assertEqual("update", result["recommendation"])

    def test_create_existing_legacy_refused(self):
        result = skill_guard.create_preflight("alpha", {}, set(), {"alpha"}, set(), set())
        self.assertFalse(result["allowed"])
        self.assertIn("legacy_log", result["found_in"])
        self.assertEqual("update", result["recommendation"])

    def test_create_archived_recommends_restore(self):
        result = skill_guard.create_preflight(
            "alpha",
            {"alpha": online_row("alpha", "ID-1", "1.0.0", archived=True)},
            set(), set(), set(), {"alpha"},
        )
        self.assertFalse(result["allowed"])
        self.assertEqual("restore", result["recommendation"])

    def test_create_fresh_slug_allowed(self):
        result = skill_guard.create_preflight("brand-new", {}, set(), set(), set(), set())
        self.assertTrue(result["allowed"])
        self.assertEqual("create", result["recommendation"])
        self.assertEqual(0, skill_guard.exit_code_for([], result))

    def test_create_refused_exit_code(self):
        refused = skill_guard.create_preflight("alpha", {"alpha": online_row("alpha", "ID-1")}, set(), set(), set(), set())
        self.assertEqual(2, skill_guard.exit_code_for([], refused))


class ManifestDiscoveryTests(unittest.TestCase):
    def _write_skill(
        self,
        root: Path,
        folder_name: str,
        companion_id: str | None = None,
        *,
        skill_name: str | None = None,
    ):
        name = skill_name or folder_name
        folder = root / folder_name
        folder.mkdir(parents=True)
        (folder / "SKILL.md").write_text(f"---\nname: {name}\n---\n# skill\n", encoding="utf-8")
        if companion_id is not None:
            (folder / "companion.json").write_text(
                json.dumps({"name": name, "version": "1.0.0", "metadata": {"companionSkillId": companion_id}}),
                encoding="utf-8",
            )
        return folder

    def test_discovers_manifests_and_skips_noise(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self._write_skill(root, "skill-a", "ID-A")
            self._write_skill(root, "node_modules", "ID-NOISE")  # must be skipped
            found = skill_guard.discover_manifest_skills([root])
            slugs = {item["slug"] for item in found}
            self.assertIn("skill-a", slugs)
            self.assertNotIn("node_modules", slugs)

    def test_duplicate_id_across_two_folders_blocks(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self._write_skill(root, "skill-a", "SHARED-ID")
            self._write_skill(root, "skill-b", "SHARED-ID")
            found = skill_guard.discover_manifest_skills([root])
            entries = [
                entry(item["slug"], item["companionSkillId"], source=f"manifest:{item['dir']}", path=item["dir"])
                for item in found
            ]
            conflicts = skill_guard.detect_conflicts(entries, online_index())
            self.assertIn(skill_guard.KIND_DUP_COMPANION_ID, kinds(conflicts))

    def test_duplicate_name_with_manifest_and_skill_only_warns(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self._write_skill(root, "ship-pr-old", None, skill_name="ship-pr")
            self._write_skill(root, "ship-pr-new", "SHIP-ID", skill_name="ship-pr")
            found = skill_guard.discover_local_skill_folders([root])
            entries = [
                entry(item["slug"], item["companionSkillId"], source=item["source"], path=item["dir"])
                for item in found
            ]
            conflicts = skill_guard.detect_conflicts(entries, online_index())
            duplicate = [c for c in conflicts if c["kind"] == skill_guard.KIND_DUPLICATE_LOCAL_SKILL_NAME]
            self.assertEqual(1, len(duplicate))
            self.assertEqual("warn", duplicate[0]["severity"])
            self.assertFalse(skill_guard.has_blocking(conflicts))

    def test_build_inventory_includes_skill_md_only_folder(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            folder = self._write_skill(root, "ship-pr-copy", None, skill_name="ship-pr")
            previous_home = os.environ.get("COMPANION_HOME")
            with tempfile.TemporaryDirectory() as home:
                os.environ["COMPANION_HOME"] = home
                try:
                    entries = skill_guard.build_local_inventory("ws-1", "https://api.example/v1", [root])
                finally:
                    if previous_home is None:
                        os.environ.pop("COMPANION_HOME", None)
                    else:
                        os.environ["COMPANION_HOME"] = previous_home
            self.assertIn(
                entry("ship-pr", None, source=f"skill:{folder}", path=str(folder)),
                entries,
            )

    def test_build_inventory_finds_sibling_backup_when_scanning_skill_dir(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            folder = self._write_skill(root, "ship-pr", None, skill_name="ship-pr")
            backup = self._write_skill(root, "ship-pr.backup-1.0.3", None, skill_name="ship-pr")
            previous_home = os.environ.get("COMPANION_HOME")
            with tempfile.TemporaryDirectory() as home:
                os.environ["COMPANION_HOME"] = home
                try:
                    entries = skill_guard.build_local_inventory("ws-1", "https://api.example/v1", [folder])
                finally:
                    if previous_home is None:
                        os.environ.pop("COMPANION_HOME", None)
                    else:
                        os.environ["COMPANION_HOME"] = previous_home
            paths = {entry["path"] for entry in entries}
            self.assertIn(str(folder), paths)
            self.assertIn(str(backup), paths)
            conflicts = skill_guard.detect_conflicts(entries, online_index())
            self.assertIn(skill_guard.KIND_STALE_BACKUP_SKILL_FOLDER, kinds(conflicts))


class MigrationTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self._home = Path(self._tmp.name)
        self._prev = os.environ.get("COMPANION_HOME")
        os.environ["COMPANION_HOME"] = str(self._home)

    def tearDown(self):
        if self._prev is None:
            os.environ.pop("COMPANION_HOME", None)
        else:
            os.environ["COMPANION_HOME"] = self._prev
        self._tmp.cleanup()

    def _write(self, name: str, data: dict):
        (self._home / name).write_text(json.dumps(data), encoding="utf-8")

    def test_migration_merges_without_clobber_and_deletes_legacy(self):
        wsid = "ws-1"
        self._write("skills.lock.json", {
            "schemaVersion": 2,
            "activeWorkspaceId": wsid,
            "workspaces": {wsid: {"apiUrl": "https://api.example/v1", "skills": {
                "alpha": {"slug": "alpha", "version": "2.0.0", "skillId": "ID-A"},
            }}},
        })
        self._write("skills.log.json", {
            "workspaces": {wsid: {"skills": {
                "alpha": {"slug": "alpha", "version": "1.0.0", "skillId": "ID-A"},
                "beta": {"slug": "beta", "version": "1.0.0", "skillId": "ID-B"},
            }}},
        })

        report = skill_guard.migrate_legacy_log(wsid, "https://api.example/v1")
        self.assertTrue(report["migrated"])
        self.assertEqual(["beta"], report["added"])
        self.assertEqual(["alpha"], report["kept_lockfile"])
        self.assertFalse(companion_lib.legacy_log_path().exists())

        lock = json.loads(companion_lib.lockfile_path().read_text(encoding="utf-8"))
        skills = lock["workspaces"][wsid]["skills"]
        self.assertEqual("2.0.0", skills["alpha"]["version"])  # lockfile won
        self.assertEqual("1.0.0", skills["beta"]["version"])  # legacy added
        self.assertEqual("https://api.example/v1", lock["workspaces"][wsid]["apiUrl"])

        # Idempotent second run.
        again = skill_guard.migrate_legacy_log(wsid, "https://api.example/v1")
        self.assertFalse(again["migrated"])
        self.assertEqual("no legacy file", again["reason"])

    def test_migration_drops_secrets(self):
        wsid = "ws-1"
        self._write("skills.log.json", {
            "workspaces": {wsid: {"skills": {
                "alpha": {"slug": "alpha", "version": "1.0.0", "skillId": "ID-A", "token": "cmp_pat_SECRET"},
            }}},
        })
        skill_guard.migrate_legacy_log(wsid, "https://api.example/v1")
        text = companion_lib.lockfile_path().read_text(encoding="utf-8")
        self.assertNotIn("cmp_pat_SECRET", text)
        self.assertNotIn("token", text)


class ReportTests(unittest.TestCase):
    def test_report_never_contains_token(self):
        entries = [entry("alpha", "ID-1", source="lockfile", version="1.0.0")]
        online = online_index(by_slug={"alpha": online_row("alpha", "ID-1", "1.0.0")})
        report = skill_guard.build_report(
            "ws-1", "https://api.example/v1", {"migrated": False, "reason": "no legacy file"},
            entries, online, skill_guard.detect_conflicts(entries, online), None,
        )
        serialized = json.dumps(report)
        self.assertNotIn("cmp_pat_", serialized)
        self.assertNotIn("Bearer", serialized)

    def test_parse_args(self):
        opts = skill_guard.parse_args(["--json", "--create-check", "alpha", "dir-1", "dir-2"])
        self.assertTrue(opts["json"])
        self.assertEqual("alpha", opts["create_check"])
        self.assertEqual(["dir-1", "dir-2"], opts["scan_roots"])


if __name__ == "__main__":
    unittest.main()
