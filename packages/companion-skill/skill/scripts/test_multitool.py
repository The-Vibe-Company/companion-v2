#!/usr/bin/env python3
"""Unit tests for the multi-tool install helpers (tool registry, config, lockfile fan-out)."""

from __future__ import annotations

import contextlib
import io
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
    "opencode": {
        "displayName": "OpenCode",
        "detect": ["~/.config/opencode"],
        "skillsDir": {"user": "~/.agents/skills", "project": ".agents/skills"},
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
        self._saved = {
            key: os.environ.get(key)
            for key in ("HOME", "COMPANION_HOME", "COMPANION_API_URL", "COMPANION_TOKEN", "COMPANION_WORKSPACE_ID", "COMPANION_AGENT")
        }
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
    def test_shipped_registry_loads_claude_codex_and_opencode(self) -> None:
        registry = companion_lib.load_tool_registry()
        self.assertIn("claude-code", registry)
        self.assertIn("codex", registry)
        self.assertIn("opencode", registry)
        self.assertEqual(registry["claude-code"]["skillsDir"]["user"], "~/.claude/skills")
        self.assertEqual(registry["opencode"]["detect"], ["~/.config/opencode"])
        self.assertEqual(registry["opencode"]["skillsDir"]["user"], "~/.agents/skills")
        self.assertEqual(registry["opencode"]["skillsDir"]["project"], ".agents/skills")

    def test_detect_tools_finds_only_present_tools(self) -> None:
        (self.home / ".claude").mkdir()
        self.assertEqual(companion_lib.detect_tools(REGISTRY), ["claude-code"])
        (self.home / ".codex").mkdir()
        self.assertEqual(companion_lib.detect_tools(REGISTRY), ["claude-code", "codex"])
        (self.home / ".config" / "opencode").mkdir(parents=True)
        self.assertEqual(companion_lib.detect_tools(REGISTRY), ["claude-code", "codex", "opencode"])

    def test_resolve_target_dir_user_and_project(self) -> None:
        user_dir = companion_lib.resolve_target_dir("claude-code", "user", "demo", None, REGISTRY)
        self.assertEqual(user_dir, self.home / ".claude" / "skills" / "demo")
        opencode_user_dir = companion_lib.resolve_target_dir("opencode", "user", "demo", None, REGISTRY)
        self.assertEqual(opencode_user_dir, self.home / ".agents" / "skills" / "demo")
        project_root = self.root / "repo"
        project_dir = companion_lib.resolve_target_dir("codex", "project", "demo", project_root, REGISTRY)
        self.assertEqual(project_dir, project_root / ".codex" / "skills" / "demo")
        opencode_project_dir = companion_lib.resolve_target_dir("opencode", "project", "demo", project_root, REGISTRY)
        self.assertEqual(opencode_project_dir, project_root / ".agents" / "skills" / "demo")

    def test_resolve_target_dir_rejects_unknown_tool(self) -> None:
        with self.assertRaises(SystemExit):
            companion_lib.resolve_target_dir("cursor", "user", "demo", None, REGISTRY)


class ConfigTests(EnvSandbox):
    def test_round_trip_tool_config(self) -> None:
        self.assertEqual(companion_lib.load_tool_config(), [])
        path = companion_lib.save_tool_config(["opencode", "codex", "claude-code", "codex"], detected_at="2026-06-26T00:00:00Z")
        self.assertTrue(path.exists())
        saved = json.loads(path.read_text())
        self.assertEqual(saved["tools"], ["claude-code", "codex", "opencode"])  # sorted + deduped
        self.assertEqual(saved["detectedAt"], "2026-06-26T00:00:00Z")
        self.assertEqual(companion_lib.load_tool_config(), ["claude-code", "codex", "opencode"])


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

    def _swap_dirs(self, parent: Path) -> list[str]:
        return sorted(
            child.name
            for child in parent.iterdir()
            if ".companion-backup" in child.name or ".companion-staging" in child.name or ".backup-" in child.name
        )

    def test_installs_into_every_planned_target(self) -> None:
        pkg = self._package()
        project_root = self.root / "repo"
        plan = [("claude-code", "user"), ("codex", "user"), ("opencode", "user"), ("claude-code", "project"), ("opencode", "project")]
        results = install_skill.fan_out_install(pkg, "demo", plan, REGISTRY, project_root, {}, {}, force=False)
        self.assertTrue(all(row["status"] == "installed" for row in results))
        self.assertTrue((self.home / ".claude" / "skills" / "demo" / "SKILL.md").exists())
        self.assertTrue((self.home / ".codex" / "skills" / "demo" / "SKILL.md").exists())
        self.assertTrue((self.home / ".agents" / "skills" / "demo" / "SKILL.md").exists())
        self.assertTrue((project_root / ".claude" / "skills" / "demo" / "SKILL.md").exists())
        self.assertTrue((project_root / ".agents" / "skills" / "demo" / "SKILL.md").exists())
        self.assertEqual([], self._swap_dirs(self.home / ".claude" / "skills"))
        self.assertEqual([], self._swap_dirs(self.home / ".codex" / "skills"))
        self.assertEqual([], self._swap_dirs(self.home / ".agents" / "skills"))

    def test_deploy_to_target_restores_and_deletes_backup_after_rename_failure(self) -> None:
        pkg = self._package()
        target = companion_lib.resolve_target_dir("claude-code", "user", "demo", None, REGISTRY)
        target.mkdir(parents=True)
        (target / "SKILL.md").write_text("old version\n", encoding="utf-8")
        original_rename = Path.rename

        def flaky_rename(self: Path, target_path: Path) -> Path:
            if ".companion-staging." in self.name:
                raise OSError("simulated rename failure")
            return original_rename(self, target_path)

        Path.rename = flaky_rename
        try:
            with self.assertRaises(OSError):
                install_skill.deploy_to_target(pkg, target)
        finally:
            Path.rename = original_rename

        self.assertEqual((target / "SKILL.md").read_text(encoding="utf-8"), "old version\n")
        self.assertEqual([], self._swap_dirs(target.parent))

    def test_deploy_to_target_deletes_backup_symlink(self) -> None:
        pkg = self._package()
        target = companion_lib.resolve_target_dir("claude-code", "user", "demo", None, REGISTRY)
        real_target = self.root / "real-demo"
        real_target.mkdir()
        (real_target / "SKILL.md").write_text("old version\n", encoding="utf-8")
        target.parent.mkdir(parents=True)
        target.symlink_to(real_target, target_is_directory=True)

        install_skill.deploy_to_target(pkg, target)

        self.assertFalse(target.is_symlink())
        self.assertEqual((target / "SKILL.md").read_text(encoding="utf-8"), "# demo\n")
        self.assertEqual([], self._swap_dirs(target.parent))

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
        self.assertEqual([], self._swap_dirs(target.parent))

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


class DependencyInstallPlanTests(EnvSandbox):
    def _zip_package(self, name: str = "demo") -> bytes:
        import zipfile

        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as archive:
            archive.writestr("SKILL.md", f"# {name}\n")
            archive.writestr("companion.json", json.dumps({"name": name, "version": "1.0.0"}))
        return buf.getvalue()

    def _patch_dependency_api(self, graph: dict[str, list[dict[str, object]]]):
        original_fetch = install_skill.fetch_skill_node
        original_get = install_skill.api_get

        def fake_fetch(_api_url: str, _token: str, slug: str, version_override: str | None = None) -> dict[str, object]:
            version = version_override or "1.0.0"
            return {
                "slug": slug,
                "version": version,
                "skill": {"name": slug, "slug": slug, "skillId": f"id-{slug}", "version": version, "checksum": "sha256:pkg"},
            }

        def fake_get(_api_url: str, _token: str, path: str) -> dict[str, object]:
            slug = path.split("/skills/", 1)[1].split("/dependencies", 1)[0]
            from urllib.parse import unquote

            return {"requires": graph.get(unquote(slug), [])}

        install_skill.fetch_skill_node = fake_fetch
        install_skill.api_get = fake_get
        return original_fetch, original_get

    def _restore_dependency_api(self, originals) -> None:
        install_skill.fetch_skill_node, install_skill.api_get = originals

    def _run_main(self, args: list[str]) -> tuple[int, str, str]:
        old_argv = sys.argv
        os.environ["COMPANION_API_URL"] = "https://api/v1"
        os.environ["COMPANION_TOKEN"] = "token"
        os.environ["COMPANION_WORKSPACE_ID"] = "ws"
        stdout = io.StringIO()
        stderr = io.StringIO()
        sys.argv = ["install_skill.py", *args]
        try:
            with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                try:
                    install_skill.main()
                except SystemExit as exc:
                    code = exc.code if isinstance(exc.code, int) else 1
                else:
                    code = 0
        finally:
            sys.argv = old_argv
        return code, stdout.getvalue(), stderr.getvalue()

    def test_transitive_install_plan_is_dependency_first(self) -> None:
        originals = self._patch_dependency_api(
            {
                "a": [{"slug": "b", "status": "satisfied", "can_open": True}],
                "b": [{"slug": "c", "status": "satisfied", "can_open": True}],
                "c": [],
            }
        )
        try:
            plan = install_skill.build_install_plan("https://api/v1", "token", "a")
        finally:
            self._restore_dependency_api(originals)

        self.assertEqual(plan["blockers"], [])
        self.assertEqual([node["slug"] for node in plan["nodes"]], ["c", "b", "a"])

        calls: list[str] = []
        original_install_node = install_skill.install_node

        def fake_install_node(*args, **_kwargs):
            node = args[3]
            calls.append(node["slug"])
            return [{"tool": "claude-code", "scope": "user", "status": "installed", "slug": node["slug"], "version": node["version"]}]

        install_skill.install_node = fake_install_node
        try:
            result = install_skill.install_nodes(
                "https://api/v1",
                "token",
                "ws",
                plan["nodes"],
                [("claude-code", "user")],
                REGISTRY,
                None,
                {},
                {},
                False,
            )
        finally:
            install_skill.install_node = original_install_node

        self.assertEqual(calls, ["c", "b", "a"])
        self.assertEqual(result["completed"], ["c", "b", "a"])

    def test_shared_dependency_is_planned_once(self) -> None:
        originals = self._patch_dependency_api(
            {
                "a": [
                    {"slug": "b", "status": "satisfied", "can_open": True},
                    {"slug": "c", "status": "satisfied", "can_open": True},
                ],
                "b": [{"slug": "d", "status": "satisfied", "can_open": True}],
                "c": [{"slug": "d", "status": "satisfied", "can_open": True}],
                "d": [],
            }
        )
        try:
            plan = install_skill.build_install_plan("https://api/v1", "token", "a")
        finally:
            self._restore_dependency_api(originals)

        self.assertEqual([node["slug"] for node in plan["nodes"]], ["d", "b", "c", "a"])
        self.assertEqual([node["slug"] for node in plan["nodes"]].count("d"), 1)

    def test_dependency_status_blockers_stop_the_plan_before_install(self) -> None:
        originals = self._patch_dependency_api(
            {
                "a": [
                    {"slug": "missing-dep", "status": "missing", "can_open": False, "note": "not published"},
                    {"slug": "archived-dep", "status": "archived", "can_open": True, "note": "publisher archived this skill"},
                    {"slug": "cycle-dep", "status": "cycle", "can_open": True, "note": "forms a cycle"},
                ],
            }
        )
        try:
            plan = install_skill.build_install_plan("https://api/v1", "token", "a")
        finally:
            self._restore_dependency_api(originals)

        statuses = {blocker["slug"]: blocker["status"] for blocker in plan["blockers"]}
        self.assertEqual(
            statuses,
            {"missing-dep": "missing", "archived-dep": "archived", "cycle-dep": "cycle"},
        )

    def test_real_cycle_and_not_openable_dependency_are_blockers(self) -> None:
        originals = self._patch_dependency_api(
            {
                "a": [
                    {"slug": "b", "status": "satisfied", "can_open": True},
                    {"slug": "hidden", "status": "satisfied", "can_open": False, "note": "not visible"},
                ],
                "b": [{"slug": "a", "status": "satisfied", "can_open": True}],
            }
        )
        try:
            plan = install_skill.build_install_plan("https://api/v1", "token", "a")
        finally:
            self._restore_dependency_api(originals)

        blockers = {(blocker["slug"], blocker["status"], blocker["canOpen"]) for blocker in plan["blockers"]}
        self.assertIn(("a", "cycle", True), blockers)
        self.assertIn(("hidden", "satisfied", False), blockers)

    def test_local_conflict_on_dependency_blocks_root_without_force(self) -> None:
        dep_target = companion_lib.resolve_target_dir("claude-code", "user", "dep", None, REGISTRY)
        dep_target.mkdir(parents=True)
        (dep_target / "SKILL.md").write_text("hand authored\n", encoding="utf-8")
        nodes = [
            {"slug": "dep", "version": "1.0.0", "skill": {"name": "dep", "slug": "dep", "version": "1.0.0"}},
            {"slug": "root", "version": "1.0.0", "skill": {"name": "root", "slug": "root", "version": "1.0.0"}},
        ]

        conflicts = install_skill.preflight_target_conflicts(
            nodes,
            [("claude-code", "user")],
            REGISTRY,
            None,
            {},
            {},
            force=False,
        )
        self.assertEqual(len(conflicts), 1)
        self.assertEqual(conflicts[0]["slug"], "dep")
        self.assertEqual(conflicts[0]["status"], "skipped_untracked")
        self.assertFalse(companion_lib.resolve_target_dir("claude-code", "user", "root", None, REGISTRY).exists())

        forced = install_skill.preflight_target_conflicts(
            nodes,
            [("claude-code", "user")],
            REGISTRY,
            None,
            {},
            {},
            force=True,
        )
        self.assertEqual(forced, [])

    def test_required_secrets_are_collected_from_companion_manifest(self) -> None:
        original_get = install_skill.api_get

        def fake_get(_api_url: str, _token: str, _path: str) -> dict[str, object]:
            return {
                "files": [
                    {"path": "SKILL.md", "content": "# demo\n"},
                    {
                        "path": "companion.json",
                        "content": json.dumps(
                            {
                                "environment": {
                                    "secrets": {
                                        "OPENAI_API_KEY": {"required": True},
                                        "OPTIONAL_TOKEN": {"required": False},
                                    }
                                }
                            }
                        ),
                    },
                ]
            }

        install_skill.api_get = fake_get
        try:
            required = install_skill.collect_required_secrets(
                "https://api/v1",
                "token",
                [{"slug": "demo", "version": "1.0.0", "skill": {"name": "demo"}}],
            )
        finally:
            install_skill.api_get = original_get

        self.assertEqual(required, [{"slug": "demo", "version": "1.0.0", "secret": "OPENAI_API_KEY"}])

    def test_required_secret_without_required_field_defaults_to_blocking(self) -> None:
        manifest = {"environment": {"secrets": {"OPENAI_API_KEY": {"description": "from provider"}}}}
        self.assertEqual(install_skill.required_secret_names(manifest), ["OPENAI_API_KEY"])

    def test_main_dependency_blocker_stops_before_mutation(self) -> None:
        calls = {"downloads": 0, "installs": 0, "reports": 0}
        originals = (
            install_skill.build_install_plan,
            install_skill.api_download_bytes,
            install_skill.install_nodes,
            install_skill.report_install,
        )

        install_skill.build_install_plan = lambda *_args: {
            "root": None,
            "nodes": [],
            "blockers": [{"slug": "dep", "requiredBy": "root", "status": "missing", "note": "not published", "canOpen": False}],
        }
        install_skill.api_download_bytes = lambda *_args: calls.__setitem__("downloads", calls["downloads"] + 1)
        install_skill.install_nodes = lambda *_args: calls.__setitem__("installs", calls["installs"] + 1)
        install_skill.report_install = lambda *_args: calls.__setitem__("reports", calls["reports"] + 1)
        try:
            code, out, _err = self._run_main(["root", "--tools", "claude-code", "--json"])
        finally:
            (
                install_skill.build_install_plan,
                install_skill.api_download_bytes,
                install_skill.install_nodes,
                install_skill.report_install,
            ) = originals

        self.assertEqual(code, 2)
        payload = json.loads(out)
        self.assertIn("dependency preflight failed", payload["error"])
        self.assertEqual(calls, {"downloads": 0, "installs": 0, "reports": 0})
        self.assertFalse(companion_lib.lockfile_path().exists())

    def test_main_required_secrets_blocker_stops_before_mutation(self) -> None:
        calls = {"downloads": 0, "installs": 0, "reports": 0}
        node = {"slug": "root", "version": "1.0.0", "skill": {"name": "root", "slug": "root", "version": "1.0.0"}}
        originals = (
            install_skill.build_install_plan,
            install_skill.collect_required_secrets,
            install_skill.api_download_bytes,
            install_skill.install_nodes,
            install_skill.report_install,
        )

        install_skill.build_install_plan = lambda *_args: {"root": node, "nodes": [node], "blockers": []}
        install_skill.collect_required_secrets = lambda *_args: [{"slug": "root", "version": "1.0.0", "secret": "OPENAI_API_KEY"}]
        install_skill.api_download_bytes = lambda *_args: calls.__setitem__("downloads", calls["downloads"] + 1)
        install_skill.install_nodes = lambda *_args: calls.__setitem__("installs", calls["installs"] + 1)
        install_skill.report_install = lambda *_args: calls.__setitem__("reports", calls["reports"] + 1)
        try:
            code, out, _err = self._run_main(["root", "--tools", "claude-code", "--json"])
        finally:
            (
                install_skill.build_install_plan,
                install_skill.collect_required_secrets,
                install_skill.api_download_bytes,
                install_skill.install_nodes,
                install_skill.report_install,
            ) = originals

        self.assertEqual(code, 2)
        payload = json.loads(out)
        self.assertEqual(payload["requiredSecrets"][0]["secret"], "OPENAI_API_KEY")
        self.assertEqual(calls, {"downloads": 0, "installs": 0, "reports": 0})
        self.assertFalse(companion_lib.lockfile_path().exists())

    def test_main_local_conflict_blocker_stops_before_mutation(self) -> None:
        calls = {"downloads": 0, "installs": 0, "reports": 0}
        node = {"slug": "root", "version": "1.0.0", "skill": {"name": "root", "slug": "root", "version": "1.0.0"}}
        originals = (
            install_skill.build_install_plan,
            install_skill.collect_required_secrets,
            install_skill.preflight_target_conflicts,
            install_skill.api_download_bytes,
            install_skill.install_nodes,
            install_skill.report_install,
        )

        install_skill.build_install_plan = lambda *_args: {"root": node, "nodes": [node], "blockers": []}
        install_skill.collect_required_secrets = lambda *_args: []
        install_skill.preflight_target_conflicts = lambda *_args, **_kwargs: [
            {"slug": "root", "version": "1.0.0", "tool": "claude-code", "scope": "user", "status": "skipped_untracked", "path": "/x"}
        ]
        install_skill.api_download_bytes = lambda *_args: calls.__setitem__("downloads", calls["downloads"] + 1)
        install_skill.install_nodes = lambda *_args: calls.__setitem__("installs", calls["installs"] + 1)
        install_skill.report_install = lambda *_args: calls.__setitem__("reports", calls["reports"] + 1)
        try:
            code, out, _err = self._run_main(["root", "--tools", "claude-code", "--json"])
        finally:
            (
                install_skill.build_install_plan,
                install_skill.collect_required_secrets,
                install_skill.preflight_target_conflicts,
                install_skill.api_download_bytes,
                install_skill.install_nodes,
                install_skill.report_install,
            ) = originals

        self.assertEqual(code, 2)
        payload = json.loads(out)
        self.assertEqual(payload["conflicts"][0]["status"], "skipped_untracked")
        self.assertEqual(calls, {"downloads": 0, "installs": 0, "reports": 0})
        self.assertFalse(companion_lib.lockfile_path().exists())

    def test_main_partial_install_withholds_report(self) -> None:
        calls: list[tuple[str, str]] = []
        dep = {"slug": "dep", "version": "1.0.0", "skill": {"name": "dep", "slug": "dep", "version": "1.0.0"}}
        root = {"slug": "root", "version": "1.0.0", "skill": {"name": "root", "slug": "root", "version": "1.0.0"}}
        originals = (
            install_skill.build_install_plan,
            install_skill.collect_required_secrets,
            install_skill.preflight_target_conflicts,
            install_skill.install_nodes,
            install_skill.report_install,
        )

        install_skill.build_install_plan = lambda *_args: {"root": root, "nodes": [dep, root], "blockers": []}
        install_skill.collect_required_secrets = lambda *_args: []
        install_skill.preflight_target_conflicts = lambda *_args, **_kwargs: []
        install_skill.install_nodes = lambda *_args, **_kwargs: {
            "targets": [{"slug": "dep", "version": "1.0.0", "tool": "claude-code", "scope": "user", "status": "installed"}],
            "completed": ["dep"],
            "skipped": ["root"],
        }
        install_skill.report_install = lambda *_args: calls.append((_args[2], _args[3]))
        try:
            code, out, _err = self._run_main(["root", "--tools", "claude-code", "--json", "--report"])
        finally:
            (
                install_skill.build_install_plan,
                install_skill.collect_required_secrets,
                install_skill.preflight_target_conflicts,
                install_skill.install_nodes,
                install_skill.report_install,
            ) = originals

        self.assertEqual(code, 0)
        payload = json.loads(out)
        self.assertTrue(payload["reportWithheld"])
        self.assertFalse(payload["complete"])
        self.assertEqual(calls, [])

    def test_main_complete_install_reports_root_once(self) -> None:
        calls: list[tuple[str, str]] = []
        dep = {"slug": "dep", "version": "1.0.0", "skill": {"name": "dep", "slug": "dep", "version": "1.0.0"}}
        root = {"slug": "root", "version": "1.0.0", "skill": {"name": "root", "slug": "root", "version": "1.0.0"}}
        originals = (
            install_skill.build_install_plan,
            install_skill.collect_required_secrets,
            install_skill.preflight_target_conflicts,
            install_skill.install_nodes,
            install_skill.report_install,
        )

        install_skill.build_install_plan = lambda *_args: {"root": root, "nodes": [dep, root], "blockers": []}
        install_skill.collect_required_secrets = lambda *_args: []
        install_skill.preflight_target_conflicts = lambda *_args, **_kwargs: []
        install_skill.install_nodes = lambda *_args, **_kwargs: {
            "targets": [
                {"slug": "dep", "version": "1.0.0", "tool": "claude-code", "scope": "user", "status": "installed"},
                {"slug": "root", "version": "1.0.0", "tool": "claude-code", "scope": "user", "status": "installed"},
            ],
            "completed": ["dep", "root"],
            "skipped": [],
        }

        def fake_report(_api_url: str, _token: str, slug: str, version: str, _agent: str):
            calls.append((slug, version))
            return {"ok": True}

        install_skill.report_install = fake_report
        try:
            code, out, _err = self._run_main(["root", "--tools", "claude-code", "--json", "--report"])
        finally:
            (
                install_skill.build_install_plan,
                install_skill.collect_required_secrets,
                install_skill.preflight_target_conflicts,
                install_skill.install_nodes,
                install_skill.report_install,
            ) = originals

        self.assertEqual(code, 0)
        payload = json.loads(out)
        self.assertTrue(payload["complete"])
        self.assertFalse(payload["reportWithheld"])
        self.assertEqual(calls, [("root", "1.0.0")])

    def test_install_nodes_records_dependency_and_root_lockfiles(self) -> None:
        original_download = install_skill.api_download_bytes
        dep = {"slug": "dep", "version": "1.0.0", "skill": {"name": "dep", "slug": "dep", "skillId": "id-dep", "version": "1.0.0"}}
        root = {"slug": "root", "version": "1.0.0", "skill": {"name": "root", "slug": "root", "skillId": "id-root", "version": "1.0.0"}}
        project_root = self.root / "repo"

        install_skill.api_download_bytes = lambda _api_url, _token, path: self._zip_package("dep" if "/dep/" in path else "root")
        try:
            result = install_skill.install_nodes(
                "https://api/v1",
                "token",
                "ws",
                [dep, root],
                [("claude-code", "user"), ("codex", "project")],
                REGISTRY,
                project_root,
                {},
                {},
                False,
            )
        finally:
            install_skill.api_download_bytes = original_download

        self.assertEqual(result["completed"], ["dep", "root"])
        user_skills = json.loads(companion_lib.lockfile_path().read_text())["workspaces"]["ws"]["skills"]
        project_skills = json.loads(companion_lib.project_lockfile_path(project_root).read_text())["workspaces"]["ws"]["skills"]
        self.assertEqual(sorted(user_skills), ["dep", "root"])
        self.assertEqual(sorted(project_skills), ["dep", "root"])
        self.assertEqual(user_skills["dep"]["targets"][0]["tool"], "claude-code")
        self.assertEqual(project_skills["root"]["targets"][0]["path"], ".codex/skills/root")


if __name__ == "__main__":
    unittest.main()
