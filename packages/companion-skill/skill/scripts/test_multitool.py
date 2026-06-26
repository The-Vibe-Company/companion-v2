#!/usr/bin/env python3
"""Unit tests for the multi-tool install helpers (tool registry, config, lockfile fan-out)."""

from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import companion_lib  # noqa: E402
import install_skill  # noqa: E402

REGISTRY = {
    "claude-code": {
        "displayName": "Claude Code",
        "detect": ["~/.claude"],
        "skillsDir": {"user": "~/.claude/skills", "project": ".claude/skills"},
        "format": "skill-md",
    },
    "codex": {
        "displayName": "Codex",
        "detect": ["~/.codex"],
        "skillsDir": {"user": "~/.codex/skills", "project": ".codex/skills"},
        "format": "skill-md",
    },
}


class EnvSandbox(unittest.TestCase):
    """Isolate HOME and COMPANION_HOME so tests never touch the real machine."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.home = self.root / "home"
        self.home.mkdir()
        self._saved = {key: os.environ.get(key) for key in ("HOME", "COMPANION_HOME")}
        os.environ["HOME"] = str(self.home)
        os.environ["COMPANION_HOME"] = str(self.home / ".companion")

    def tearDown(self) -> None:
        for key, value in self._saved.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        self._tmp.cleanup()


class RegistryTests(EnvSandbox):
    def test_shipped_registry_loads_claude_and_codex(self) -> None:
        registry = companion_lib.load_tool_registry()
        self.assertIn("claude-code", registry)
        self.assertIn("codex", registry)
        self.assertEqual(registry["claude-code"]["skillsDir"]["user"], "~/.claude/skills")

    def test_detect_tools_finds_only_present_tools(self) -> None:
        (self.home / ".claude").mkdir()
        self.assertEqual(companion_lib.detect_tools(REGISTRY), ["claude-code"])
        (self.home / ".codex").mkdir()
        self.assertEqual(companion_lib.detect_tools(REGISTRY), ["claude-code", "codex"])

    def test_resolve_target_dir_user_and_project(self) -> None:
        user_dir = companion_lib.resolve_target_dir("claude-code", "user", "demo", None, REGISTRY)
        self.assertEqual(user_dir, self.home / ".claude" / "skills" / "demo")
        project_root = self.root / "repo"
        project_dir = companion_lib.resolve_target_dir("codex", "project", "demo", project_root, REGISTRY)
        self.assertEqual(project_dir, project_root / ".codex" / "skills" / "demo")

    def test_resolve_target_dir_rejects_unknown_tool(self) -> None:
        with self.assertRaises(SystemExit):
            companion_lib.resolve_target_dir("cursor", "user", "demo", None, REGISTRY)


class ConfigTests(EnvSandbox):
    def test_round_trip_tool_config(self) -> None:
        self.assertEqual(companion_lib.load_tool_config(), [])
        path = companion_lib.save_tool_config(["codex", "claude-code", "codex"], detected_at="2026-06-26T00:00:00Z")
        self.assertTrue(path.exists())
        saved = json.loads(path.read_text())
        self.assertEqual(saved["tools"], ["claude-code", "codex"])  # sorted + deduped
        self.assertEqual(saved["detectedAt"], "2026-06-26T00:00:00Z")
        self.assertEqual(companion_lib.load_tool_config(), ["claude-code", "codex"])


class LockRecordTests(EnvSandbox):
    def test_normalize_targets_reads_modern_and_legacy(self) -> None:
        modern = companion_lib.normalize_targets(
            {"targets": [{"tool": "codex", "scope": "user", "path": "/x", "checksum": "sha256:1"}]}
        )
        self.assertEqual(modern[0]["tool"], "codex")
        # Legacy records store a package checksum, not a folder checksum, so it is surfaced as None.
        legacy = companion_lib.normalize_targets({"installPath": "/legacy", "checksum": "sha256:2", "version": "1.0.0"})
        self.assertEqual(
            legacy,
            [{"tool": "claude-code", "scope": "user", "path": "/legacy", "checksum": None, "version": "1.0.0"}],
        )

    def test_skill_records_from_lock_surfaces_targets(self) -> None:
        entry = {
            "skills": {
                "demo": {
                    "name": "demo",
                    "version": "1.0.0",
                    "targets": [
                        {"tool": "claude-code", "scope": "user", "path": "/a", "checksum": "sha256:a"},
                        {"tool": "codex", "scope": "user", "path": "/b", "checksum": "sha256:b"},
                    ],
                }
            }
        }
        records = companion_lib.skill_records_from_lock(entry)
        self.assertEqual(len(records), 1)
        self.assertEqual(len(records[0]["targets"]), 2)


class ExtractTests(EnvSandbox):
    def _zip(self, members: dict[str, str]) -> bytes:
        import io
        import zipfile

        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as archive:
            for name, content in members.items():
                archive.writestr(name, content)
        return buf.getvalue()

    def test_extracts_valid_package(self) -> None:
        dest = self.root / "out"
        dest.mkdir()
        package = install_skill.extract_package(self._zip({"SKILL.md": "# demo\n", "ref.md": "x"}), dest)
        self.assertTrue((package / "SKILL.md").exists())

    def test_rejects_zip_slip_entry(self) -> None:
        dest = self.root / "out"
        dest.mkdir()
        with self.assertRaises(SystemExit):
            install_skill.extract_package(self._zip({"SKILL.md": "ok", "../escape.txt": "evil"}), dest)
        self.assertFalse((self.root / "escape.txt").exists())  # never written outside dest


class ChecksumTests(EnvSandbox):
    def test_dir_checksum_is_deterministic_and_change_sensitive(self) -> None:
        pkg = self.root / "pkg"
        pkg.mkdir()
        (pkg / "SKILL.md").write_text("hello", encoding="utf-8")
        first = companion_lib.compute_dir_checksum(pkg)
        self.assertEqual(first, companion_lib.compute_dir_checksum(pkg))
        (pkg / "SKILL.md").write_text("changed", encoding="utf-8")
        self.assertNotEqual(first, companion_lib.compute_dir_checksum(pkg))


class FanOutTests(EnvSandbox):
    def _package(self) -> Path:
        pkg = self.root / "package"
        pkg.mkdir()
        (pkg / "SKILL.md").write_text("# demo\n", encoding="utf-8")
        (pkg / "ref.md").write_text("body\n", encoding="utf-8")
        return pkg

    def test_installs_into_every_planned_target(self) -> None:
        pkg = self._package()
        project_root = self.root / "repo"
        plan = [("claude-code", "user"), ("codex", "user"), ("claude-code", "project")]
        results = install_skill.fan_out_install(pkg, "demo", plan, REGISTRY, project_root, {}, {}, force=False)
        self.assertTrue(all(row["status"] == "installed" for row in results))
        self.assertTrue((self.home / ".claude" / "skills" / "demo" / "SKILL.md").exists())
        self.assertTrue((self.home / ".codex" / "skills" / "demo" / "SKILL.md").exists())
        self.assertTrue((project_root / ".claude" / "skills" / "demo" / "SKILL.md").exists())

    def test_skips_customized_target_unless_forced(self) -> None:
        pkg = self._package()
        target = companion_lib.resolve_target_dir("claude-code", "user", "demo", None, REGISTRY)
        target.mkdir(parents=True)
        (target / "SKILL.md").write_text("user edited this\n", encoding="utf-8")
        recorded = "sha256:does-not-match-on-disk"
        prior = {"demo": {"targets": [{"tool": "claude-code", "scope": "user", "path": str(target), "checksum": recorded}]}}

        skipped = install_skill.fan_out_install(pkg, "demo", [("claude-code", "user")], REGISTRY, None, prior, {}, force=False)
        self.assertEqual(skipped[0]["status"], "skipped_customized")
        self.assertEqual((target / "SKILL.md").read_text(), "user edited this\n")

        forced = install_skill.fan_out_install(pkg, "demo", [("claude-code", "user")], REGISTRY, None, prior, {}, force=True)
        self.assertEqual(forced[0]["status"], "installed")
        self.assertEqual((target / "SKILL.md").read_text(), "# demo\n")

    def test_untracked_existing_folder_is_protected(self) -> None:
        # An existing folder Companion does not track (hand-authored / installed another way) must not
        # be deleted without --force — cubic regression guard.
        pkg = self._package()
        target = companion_lib.resolve_target_dir("claude-code", "user", "demo", None, REGISTRY)
        target.mkdir(parents=True)
        (target / "SKILL.md").write_text("hand authored\n", encoding="utf-8")
        res = install_skill.fan_out_install(pkg, "demo", [("claude-code", "user")], REGISTRY, None, {}, {}, force=False)
        self.assertEqual(res[0]["status"], "skipped_untracked")
        self.assertEqual((target / "SKILL.md").read_text(), "hand authored\n")
        forced = install_skill.fan_out_install(pkg, "demo", [("claude-code", "user")], REGISTRY, None, {}, {}, force=True)
        self.assertEqual(forced[0]["status"], "installed")
        self.assertEqual((target / "SKILL.md").read_text(), "# demo\n")

    def test_fan_out_isolates_a_target_failure(self) -> None:
        # A failure on one target must not abort the whole fan-out; other targets still install and are
        # returned so the lockfile records exactly what landed on disk (no untracked partial installs).
        pkg = self._package()
        original = install_skill.deploy_to_target

        def flaky(package_dir: Path, target_dir: Path) -> None:
            if ".codex" in str(target_dir):
                raise OSError("simulated disk failure")
            original(package_dir, target_dir)

        install_skill.deploy_to_target = flaky
        try:
            res = install_skill.fan_out_install(pkg, "demo", [("claude-code", "user"), ("codex", "user")], REGISTRY, None, {}, {}, force=False)
        finally:
            install_skill.deploy_to_target = original
        by_tool = {r["tool"]: r["status"] for r in res}
        self.assertEqual(by_tool, {"claude-code": "installed", "codex": "error"})
        self.assertTrue((self.home / ".claude" / "skills" / "demo" / "SKILL.md").exists())

    def test_legacy_tracked_install_updates_without_force(self) -> None:
        # A pre-multi-tool record (single installPath, package checksum, no comparable folder checksum)
        # is Companion-managed: it must UPDATE on install, not be false-flagged as customized.
        pkg = self._package()
        target = companion_lib.resolve_target_dir("claude-code", "user", "demo", None, REGISTRY)
        target.mkdir(parents=True)
        (target / "SKILL.md").write_text("old version\n", encoding="utf-8")
        prior = {"demo": {"installPath": str(target), "checksum": "sha256:package-checksum"}}
        results = install_skill.fan_out_install(pkg, "demo", [("claude-code", "user")], REGISTRY, None, prior, {}, force=False)
        self.assertEqual(results[0]["status"], "installed")
        self.assertEqual((target / "SKILL.md").read_text(), "# demo\n")

    def test_write_lock_records_merges_instead_of_dropping_targets(self) -> None:
        # Installing a subset of tools must not erase previously tracked targets — cubic P1 regression.
        path = companion_lib.lockfile_path()
        base = {"name": "demo", "slug": "demo", "skillId": "id", "checksum": "sha256:p"}
        companion_lib.upsert_skill_lock_record(
            path, "ws", "https://api/v1", {**base, "version": "1.0.0"},
            [{"tool": "claude-code", "scope": "user", "path": "/a", "checksum": "sha256:a"}], relative_to=None,
        )
        companion_lib.upsert_skill_lock_record(
            path, "ws", "https://api/v1", {**base, "version": "2.0.0"},
            [{"tool": "codex", "scope": "user", "path": "/b", "checksum": "sha256:b"}], relative_to=None,
        )
        record = json.loads(path.read_text())["workspaces"]["ws"]["skills"]["demo"]
        by_tool = {t["tool"]: t["version"] for t in record["targets"]}
        self.assertEqual(by_tool, {"claude-code": "1.0.0", "codex": "2.0.0"})  # claude-code survived
        # Top-level version is the oldest target so "update available" fires when any target is behind.
        self.assertEqual(record["version"], "1.0.0")

    def test_write_lock_records_preserves_untouched_target_version(self) -> None:
        # Updating one tool must not rewrite an untouched tool's version to the record-level value —
        # regression for the cubic finding that normalize_targets dropped per-target versions.
        path = companion_lib.lockfile_path()
        base = {"name": "demo", "slug": "demo", "skillId": "id", "checksum": "sha256:p"}
        writes = [("claude-code", "1.0.0"), ("codex", "2.0.0"), ("claude-code", "2.0.0")]
        for tool, version in writes:
            companion_lib.upsert_skill_lock_record(
                path, "ws", "https://api/v1", {**base, "version": version},
                [{"tool": tool, "scope": "user", "path": f"/{tool}", "checksum": f"sha256:{tool}"}], relative_to=None,
            )
        record = json.loads(path.read_text())["workspaces"]["ws"]["skills"]["demo"]
        by_tool = {t["tool"]: t["version"] for t in record["targets"]}
        self.assertEqual(by_tool, {"claude-code": "2.0.0", "codex": "2.0.0"})  # codex kept its own 2.0.0
        self.assertEqual(record["version"], "2.0.0")

    def test_write_lock_records_replaces_same_target_in_place(self) -> None:
        path = companion_lib.lockfile_path()
        base = {"name": "demo", "slug": "demo", "skillId": "id", "checksum": "sha256:p"}
        for version, checksum in (("1.0.0", "sha256:old"), ("2.0.0", "sha256:new")):
            companion_lib.upsert_skill_lock_record(
                path, "ws", "https://api/v1", {**base, "version": version},
                [{"tool": "claude-code", "scope": "user", "path": "/a", "checksum": checksum}], relative_to=None,
            )
        record = json.loads(path.read_text())["workspaces"]["ws"]["skills"]["demo"]
        self.assertEqual(len(record["targets"]), 1)  # not duplicated
        self.assertEqual(record["targets"][0]["checksum"], "sha256:new")
        self.assertEqual(record["targets"][0]["version"], "2.0.0")

    def test_write_lock_records_splits_user_and_project(self) -> None:
        skill = {"name": "demo", "slug": "demo", "skillId": "id-1", "version": "1.0.0", "checksum": "sha256:pkg"}
        project_root = self.root / "repo"
        user_targets = [{"tool": "claude-code", "scope": "user", "path": str(self.home / ".claude/skills/demo"), "checksum": "sha256:u"}]
        project_targets = [{"tool": "codex", "scope": "project", "path": str(project_root / ".codex/skills/demo"), "checksum": "sha256:p"}]

        companion_lib.upsert_skill_lock_record(companion_lib.lockfile_path(), "ws-1", "https://api/v1", skill, user_targets, relative_to=None)
        companion_lib.upsert_skill_lock_record(companion_lib.project_lockfile_path(project_root), "ws-1", "https://api/v1", skill, project_targets, relative_to=project_root)

        user_lock = json.loads(companion_lib.lockfile_path().read_text())
        user_record = user_lock["workspaces"]["ws-1"]["skills"]["demo"]
        self.assertEqual(user_record["targets"][0]["scope"], "user")

        project_lock = json.loads(companion_lib.project_lockfile_path(project_root).read_text())
        project_record = project_lock["workspaces"]["ws-1"]["skills"]["demo"]
        # Project lockfile stores repo-relative paths so it can be committed and shared.
        self.assertEqual(project_record["targets"][0]["path"], ".codex/skills/demo")


if __name__ == "__main__":
    unittest.main()
