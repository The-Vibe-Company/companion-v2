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
import create_secret  # noqa: E402
import install_skill  # noqa: E402

REGISTRY = {
    "claude-code": {
        "displayName": "Claude Code",
        "detect": ["~/.claude"],
        "skillsDir": {"user": "~/.claude/skills", "project": ".claude/skills"},
        "discovers": ["claude-code"],
        "format": "skill-md",
    },
    "codex": {
        "displayName": "Codex",
        "detect": ["~/.codex"],
        "skillsDir": {"user": "~/.codex/skills", "project": ".codex/skills"},
        "discovers": ["codex", "opencode"],
        "format": "skill-md",
    },
    "opencode": {
        "displayName": "OpenCode",
        "detect": ["~/.config/opencode"],
        "skillsDir": {"user": "~/.agents/skills", "project": ".agents/skills"},
        "discovers": ["opencode", "claude-code"],
        "additionalDiscoveryDirs": {
            "user": ["~/.config/opencode/skills"],
            "project": [".opencode/skills"],
        },
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
        self.assertEqual(registry["codex"]["discovers"], ["codex", "opencode"])
        self.assertEqual(registry["opencode"]["discovers"], ["opencode", "claude-code"])
        self.assertEqual(
            registry["opencode"]["additionalDiscoveryDirs"],
            {"user": ["~/.config/opencode/skills"], "project": [".opencode/skills"]},
        )

    def test_plans_smallest_duplicate_free_target_set(self) -> None:
        self.assertEqual(install_skill.plan_target_tools(["claude-code", "codex", "opencode"], REGISTRY), ["claude-code", "codex"])
        self.assertEqual(install_skill.plan_target_tools(["claude-code", "opencode"], REGISTRY), ["claude-code"])
        self.assertEqual(install_skill.plan_target_tools(["codex", "opencode"], REGISTRY), ["opencode"])

    def test_duplicate_roots_follow_selected_tool_discovery(self) -> None:
        self.assertEqual(
            install_skill.duplicate_target_tools(
                ["claude-code", "codex", "opencode"], ["claude-code", "codex"], REGISTRY
            ),
            ["opencode"],
        )

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


class SecretCreationTests(EnvSandbox):
    def test_create_secret_reads_stdin_and_never_prints_plaintext(self) -> None:
        sentinel = "private-value-sentinel"
        captured: dict[str, object] = {}
        old_argv = sys.argv
        old_stdin = sys.stdin
        original_credentials = create_secret.resolve_credentials
        original_post = create_secret.api_post_json
        create_secret.resolve_credentials = lambda: ("https://api/v1", "token", "workspace-1")

        def fake_post(base: str, token: str, path: str, payload: dict[str, object]):
            captured.update({"base": base, "token": token, "path": path, "payload": payload})
            return {"id": "secret-1", "name": "Deploy key", "key": "DEPLOY_KEY", "audience": "organization"}

        create_secret.api_post_json = fake_post
        sys.argv = [
            "create_secret.py",
            "--name", "Deploy key",
            "--key", "DEPLOY_KEY",
            "--audience", "organization",
            "--value-stdin",
            "--json",
        ]
        sys.stdin = io.StringIO(sentinel)
        stdout = io.StringIO()
        try:
            with contextlib.redirect_stdout(stdout):
                create_secret.main()
        finally:
            sys.argv = old_argv
            sys.stdin = old_stdin
            create_secret.resolve_credentials = original_credentials
            create_secret.api_post_json = original_post

        self.assertEqual(captured["path"], "/secrets")
        self.assertEqual(captured["payload"]["value"], sentinel)
        self.assertNotIn(sentinel, stdout.getvalue())
        self.assertNotIn("value", json.loads(stdout.getvalue()))

    def test_create_secret_preflights_and_binds_matching_skill_slot(self) -> None:
        sentinel = "private-image-key"
        calls: list[tuple[str, str, dict[str, object] | None]] = []
        old_argv = sys.argv
        old_stdin = sys.stdin
        original_credentials = create_secret.resolve_credentials
        original_get = create_secret.api_get
        original_post = create_secret.api_post_json
        original_put = create_secret.api_put_json
        create_secret.resolve_credentials = lambda: ("https://api/v1", "token", "workspace-1")
        create_secret.api_get = lambda base, token, path: {
            "slots": [
                {"slot_id": "slot-image", "env_key": "AZURE_OPENAI_API_KEY"},
                {"slot_id": "slot-fallback", "env_key": "OPENAI_API_KEY"},
            ]
        }

        def fake_post(base: str, token: str, path: str, payload: dict[str, object]):
            calls.append(("POST", path, payload))
            return {
                "id": "secret-image",
                "name": "Azure image generation",
                "key": "AZURE_OPENAI_API_KEY",
                "audience": "organization",
            }

        def fake_put(base: str, token: str, path: str, payload: dict[str, object]):
            calls.append(("PUT", path, payload))
            return {"configured": True}

        create_secret.api_post_json = fake_post
        create_secret.api_put_json = fake_put
        sys.argv = [
            "create_secret.py",
            "--name", "Azure image generation",
            "--key", "AZURE_OPENAI_API_KEY",
            "--audience", "organization",
            "--skill", "generate-image-tools",
            "--value-stdin",
            "--json",
        ]
        sys.stdin = io.StringIO(sentinel)
        stdout = io.StringIO()
        try:
            with contextlib.redirect_stdout(stdout):
                create_secret.main()
        finally:
            sys.argv = old_argv
            sys.stdin = old_stdin
            create_secret.resolve_credentials = original_credentials
            create_secret.api_get = original_get
            create_secret.api_post_json = original_post
            create_secret.api_put_json = original_put

        self.assertEqual(calls[0][0:2], ("POST", "/secrets"))
        self.assertEqual(calls[0][2]["value"], sentinel)
        self.assertEqual(
            calls[1],
            (
                "PUT",
                "/skills/generate-image-tools/secret-bindings/slot-image",
                {"secret_id": "secret-image"},
            ),
        )
        result = json.loads(stdout.getvalue())
        self.assertEqual(result["binding"]["slot_id"], "slot-image")
        self.assertNotIn(sentinel, stdout.getvalue())

    def test_create_secret_rejects_missing_skill_slot_before_reading_value(self) -> None:
        old_argv = sys.argv
        old_stdin = sys.stdin
        original_credentials = create_secret.resolve_credentials
        original_get = create_secret.api_get
        create_secret.resolve_credentials = lambda: ("https://api/v1", "token", "workspace-1")
        create_secret.api_get = lambda base, token, path: {"slots": []}
        sys.argv = [
            "create_secret.py",
            "--name", "Azure image generation",
            "--key", "AZURE_OPENAI_API_KEY",
            "--skill", "generate-image-tools",
            "--value-stdin",
        ]
        provided_stdin = io.StringIO("must-not-be-read")
        sys.stdin = provided_stdin
        try:
            with self.assertRaises(SystemExit) as raised:
                create_secret.main()
        finally:
            sys.argv = old_argv
            sys.stdin = old_stdin
            create_secret.resolve_credentials = original_credentials
            create_secret.api_get = original_get

        self.assertIn("does not declare exactly one secret slot", str(raised.exception))
        self.assertEqual(provided_stdin.tell(), 0)


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

    def test_tracked_identical_duplicate_is_pruned_from_disk_and_lockfile(self) -> None:
        pkg = self._package()
        claude_target = companion_lib.resolve_target_dir("claude-code", "user", "demo", None, REGISTRY)
        duplicate_target = companion_lib.resolve_target_dir("opencode", "user", "demo", None, REGISTRY)
        install_skill.deploy_to_target(pkg, claude_target)
        install_skill.deploy_to_target(pkg, duplicate_target)
        skill = {"name": "demo", "slug": "demo", "skillId": "id", "version": "1.0.0", "checksum": "sha256:pkg"}
        targets = [
            {"tool": "claude-code", "scope": "user", "path": str(claude_target), "checksum": companion_lib.compute_dir_checksum(claude_target)},
            {"tool": "opencode", "scope": "user", "path": str(duplicate_target), "checksum": companion_lib.compute_dir_checksum(duplicate_target)},
        ]
        companion_lib.upsert_skill_lock_record(
            companion_lib.lockfile_path(), "ws", "https://api/v1", skill, targets, relative_to=None
        )
        prior = {"demo": json.loads(companion_lib.lockfile_path().read_text())["workspaces"]["ws"]["skills"]["demo"]}
        node = {"slug": "demo", "version": "1.0.0", "skill": skill}

        conflicts, prunable = install_skill.preflight_duplicate_targets(
            [node], ["opencode"], ["claude-code"], {"opencode"}, ["user"], REGISTRY, None, prior, {}
        )
        self.assertEqual(conflicts, [])
        self.assertEqual(len(prunable), 1)

        removed = install_skill.prune_duplicate_targets(prunable, "ws", "https://api/v1", None)
        self.assertEqual(removed[0]["status"], "removed")
        self.assertFalse(duplicate_target.exists())
        record = json.loads(companion_lib.lockfile_path().read_text())["workspaces"]["ws"]["skills"]["demo"]
        self.assertEqual([(row["tool"], row["scope"]) for row in record["targets"]], [("claude-code", "user")])

    def test_prune_checksum_error_preserves_cleanup_for_prior_removals(self) -> None:
        pkg = self._package()
        first = companion_lib.resolve_target_dir("claude-code", "user", "demo", None, REGISTRY)
        second = companion_lib.resolve_target_dir("opencode", "user", "demo", None, REGISTRY)
        install_skill.deploy_to_target(pkg, first)
        install_skill.deploy_to_target(pkg, second)
        first_checksum = companion_lib.compute_dir_checksum(first)
        second_checksum = companion_lib.compute_dir_checksum(second)
        skill = {"name": "demo", "slug": "demo", "skillId": "id", "version": "1.0.0", "checksum": "sha256:pkg"}
        companion_lib.upsert_skill_lock_record(
            companion_lib.lockfile_path(),
            "ws",
            "https://api/v1",
            skill,
            [
                {"tool": "claude-code", "scope": "user", "path": str(first), "checksum": first_checksum},
                {"tool": "opencode", "scope": "user", "path": str(second), "checksum": second_checksum},
            ],
            relative_to=None,
        )
        original_checksum = install_skill.compute_dir_checksum

        def checksum_with_error(path: Path) -> str:
            if path == second:
                raise OSError("simulated read failure")
            return original_checksum(path)

        install_skill.compute_dir_checksum = checksum_with_error
        try:
            removed = install_skill.prune_duplicate_targets(
                [
                    {"slug": "demo", "tool": "claude-code", "scope": "user", "path": str(first), "checksum": first_checksum},
                    {"slug": "demo", "tool": "opencode", "scope": "user", "path": str(second), "checksum": second_checksum},
                ],
                "ws",
                "https://api/v1",
                None,
            )
        finally:
            install_skill.compute_dir_checksum = original_checksum

        self.assertEqual([row["status"] for row in removed], ["removed", "error"])
        self.assertFalse(first.exists())
        self.assertTrue(second.exists())
        record = json.loads(companion_lib.lockfile_path().read_text())["workspaces"]["ws"]["skills"]["demo"]
        self.assertEqual([(row["tool"], row["scope"]) for row in record["targets"]], [("opencode", "user")])

    def test_customized_duplicate_blocks_before_install(self) -> None:
        pkg = self._package()
        duplicate_target = companion_lib.resolve_target_dir("opencode", "user", "demo", None, REGISTRY)
        install_skill.deploy_to_target(pkg, duplicate_target)
        recorded = companion_lib.compute_dir_checksum(duplicate_target)
        (duplicate_target / "SKILL.md").write_text("locally changed\n", encoding="utf-8")
        prior = {
            "demo": {
                "targets": [
                    {"tool": "opencode", "scope": "user", "path": str(duplicate_target), "checksum": recorded}
                ]
            }
        }
        node = {"slug": "demo", "version": "1.0.0", "skill": {"name": "demo"}}

        conflicts, prunable = install_skill.preflight_duplicate_targets(
            [node], ["opencode"], ["claude-code"], {"opencode"}, ["user"], REGISTRY, None, prior, {}
        )
        self.assertEqual(prunable, [])
        self.assertEqual(conflicts[0]["status"], "duplicate_customized")
        self.assertTrue(duplicate_target.exists())

    def test_duplicate_in_unrequested_tool_blocks_instead_of_being_pruned(self) -> None:
        pkg = self._package()
        duplicate_target = companion_lib.resolve_target_dir("claude-code", "user", "demo", None, REGISTRY)
        install_skill.deploy_to_target(pkg, duplicate_target)
        checksum = companion_lib.compute_dir_checksum(duplicate_target)
        prior = {
            "demo": {
                "targets": [
                    {"tool": "claude-code", "scope": "user", "path": str(duplicate_target), "checksum": checksum}
                ]
            }
        }
        node = {"slug": "demo", "version": "1.0.0", "skill": {"name": "demo"}}

        conflicts, prunable = install_skill.preflight_duplicate_targets(
            [node], ["claude-code"], ["codex"], set(), ["user"], REGISTRY, None, prior, {}
        )
        self.assertEqual(prunable, [])
        self.assertEqual(conflicts[0]["status"], "duplicate_outside_scope")
        self.assertTrue(duplicate_target.exists())

    def test_native_opencode_roots_block_duplicate_install(self) -> None:
        project_root = self.root / "repo"
        native_user = self.home / ".config" / "opencode" / "skills" / "demo"
        native_project = project_root / ".opencode" / "skills" / "demo"
        native_user.mkdir(parents=True)
        native_project.mkdir(parents=True)
        (native_user / "SKILL.md").write_text("native user\n", encoding="utf-8")
        (native_project / "SKILL.md").write_text("native project\n", encoding="utf-8")
        node = {"slug": "demo", "version": "1.0.0", "skill": {"name": "demo"}}

        conflicts, checked = install_skill.preflight_additional_discovery_targets(
            [node], ["opencode"], ["user", "project"], REGISTRY, project_root
        )

        self.assertEqual({row["status"] for row in conflicts}, {"duplicate_unmanaged_root"})
        self.assertEqual({row["path"] for row in conflicts}, {str(native_user), str(native_project)})
        self.assertEqual(set(checked), {str(native_user), str(native_project)})

    def test_mismatched_lockfile_path_never_authorizes_duplicate_deletion(self) -> None:
        pkg = self._package()
        duplicate_target = companion_lib.resolve_target_dir("opencode", "user", "demo", None, REGISTRY)
        install_skill.deploy_to_target(pkg, duplicate_target)
        prior = {
            "demo": {
                "targets": [
                    {
                        "tool": "opencode",
                        "scope": "user",
                        "path": str(self.home / "moved" / "demo"),
                        "checksum": companion_lib.compute_dir_checksum(duplicate_target),
                    }
                ]
            }
        }
        node = {"slug": "demo", "version": "1.0.0", "skill": {"name": "demo"}}

        conflicts, prunable = install_skill.preflight_duplicate_targets(
            [node], ["opencode"], ["claude-code"], {"opencode"}, ["user"], REGISTRY, None, prior, {}
        )

        self.assertEqual(prunable, [])
        self.assertEqual(conflicts[0]["status"], "duplicate_untracked")
        self.assertTrue(duplicate_target.exists())

    def test_symlinked_duplicate_root_cannot_alias_selected_target(self) -> None:
        claude_skills = self.home / ".claude" / "skills"
        claude_skills.mkdir(parents=True)
        agents_root = self.home / ".agents"
        agents_root.mkdir()
        (agents_root / "skills").symlink_to(claude_skills, target_is_directory=True)
        duplicate_target = claude_skills / "demo"
        duplicate_target.mkdir()
        (duplicate_target / "SKILL.md").write_text("same physical folder\n", encoding="utf-8")
        checksum = companion_lib.compute_dir_checksum(duplicate_target)
        prior = {
            "demo": {
                "targets": [
                    {
                        "tool": "opencode",
                        "scope": "user",
                        "path": str(self.home / ".agents" / "skills" / "demo"),
                        "checksum": checksum,
                    }
                ]
            }
        }
        node = {"slug": "demo", "version": "1.0.0", "skill": {"name": "demo"}}

        conflicts, prunable = install_skill.preflight_duplicate_targets(
            [node], ["opencode"], ["claude-code"], {"opencode"}, ["user"], REGISTRY, None, prior, {}
        )

        self.assertEqual(prunable, [])
        self.assertEqual(conflicts[0]["status"], "duplicate_path_alias")
        self.assertTrue(duplicate_target.exists())

    def test_duplicate_root_retargeted_after_preflight_is_not_deleted(self) -> None:
        pkg = self._package()
        separate_skills = self.root / "separate-skills"
        separate_skills.mkdir()
        agents_root = self.home / ".agents"
        agents_root.mkdir()
        agents_link = agents_root / "skills"
        agents_link.symlink_to(separate_skills, target_is_directory=True)
        duplicate_target = agents_link / "demo"
        install_skill.deploy_to_target(pkg, duplicate_target)
        checksum = companion_lib.compute_dir_checksum(duplicate_target)
        skill = {"name": "demo", "slug": "demo", "skillId": "id", "version": "1.0.0", "checksum": "sha256:pkg"}
        companion_lib.upsert_skill_lock_record(
            companion_lib.lockfile_path(),
            "ws",
            "https://api/v1",
            skill,
            [{"tool": "opencode", "scope": "user", "path": str(duplicate_target), "checksum": checksum}],
            relative_to=None,
        )
        prior = {"demo": json.loads(companion_lib.lockfile_path().read_text())["workspaces"]["ws"]["skills"]["demo"]}
        node = {"slug": "demo", "version": "1.0.0", "skill": skill}
        conflicts, prunable = install_skill.preflight_duplicate_targets(
            [node], ["opencode"], ["claude-code"], {"opencode"}, ["user"], REGISTRY, None, prior, {}
        )
        self.assertEqual(conflicts, [])
        self.assertEqual(len(prunable), 1)

        claude_target = companion_lib.resolve_target_dir("claude-code", "user", "demo", None, REGISTRY)
        install_skill.deploy_to_target(pkg, claude_target)
        agents_link.unlink()
        agents_link.symlink_to(claude_target.parent, target_is_directory=True)
        removed = install_skill.prune_duplicate_targets(prunable, "ws", "https://api/v1", None)

        self.assertEqual(removed[0]["status"], "error")
        self.assertTrue(claude_target.exists())
        record = json.loads(companion_lib.lockfile_path().read_text())["workspaces"]["ws"]["skills"]["demo"]
        self.assertEqual([(row["tool"], row["scope"]) for row in record["targets"]], [("opencode", "user")])

    def test_redundant_user_root_cannot_alias_planned_project_target(self) -> None:
        project_root = self.root / "repo"
        project_target = companion_lib.resolve_target_dir("claude-code", "project", "demo", project_root, REGISTRY)
        project_target.mkdir(parents=True)
        (project_target / "SKILL.md").write_text("shared target\n", encoding="utf-8")
        agents_root = self.home / ".agents"
        agents_root.mkdir()
        (agents_root / "skills").symlink_to(project_target.parent, target_is_directory=True)
        duplicate_target = companion_lib.resolve_target_dir("opencode", "user", "demo", project_root, REGISTRY)
        checksum = companion_lib.compute_dir_checksum(duplicate_target)
        prior = {
            "demo": {
                "targets": [
                    {
                        "tool": "opencode",
                        "scope": "user",
                        "path": str(duplicate_target),
                        "checksum": checksum,
                    }
                ]
            }
        }
        node = {"slug": "demo", "version": "1.0.0", "skill": {"name": "demo"}}

        conflicts, prunable = install_skill.preflight_duplicate_targets(
            [node],
            ["opencode"],
            ["claude-code"],
            {"opencode"},
            ["user", "project"],
            REGISTRY,
            project_root,
            prior,
            {},
        )

        self.assertEqual(prunable, [])
        self.assertEqual(conflicts[0]["status"], "duplicate_path_alias")
        self.assertTrue(project_target.exists())

    def test_planned_target_roots_cannot_alias_each_other(self) -> None:
        claude_skills = self.home / ".claude" / "skills"
        claude_skills.mkdir(parents=True)
        codex_root = self.home / ".codex"
        codex_root.mkdir()
        (codex_root / "skills").symlink_to(claude_skills, target_is_directory=True)
        node = {"slug": "demo", "version": "1.0.0", "skill": {"name": "demo"}}

        conflicts = install_skill.target_alias_conflicts(
            [node], [("claude-code", "user"), ("codex", "user")], REGISTRY, None
        )

        self.assertEqual(len(conflicts), 2)
        self.assertEqual({row["status"] for row in conflicts}, {"target_path_alias"})

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

    def test_legacy_secret_confirmation_cannot_authorize_retrieval(self) -> None:
        old_argv = sys.argv
        sys.argv = ["install_skill.py", "demo", "--confirm-required-secrets"]
        try:
            with self.assertRaisesRegex(SystemExit, "no longer authorizes secret retrieval"):
                install_skill.main()
        finally:
            sys.argv = old_argv

    def test_legacy_credentials_skip_workspace_recovery(self) -> None:
        old_argv = sys.argv
        original_credentials = install_skill.resolve_credentials
        original_recover = install_skill.recover_pending_transactions
        original_registry = install_skill.load_tool_registry
        recovered: list[str] = []
        install_skill.resolve_credentials = lambda: ("https://api/v1", "token", None)
        install_skill.recover_pending_transactions = lambda workspace_id: recovered.append(workspace_id)

        def registry_reached():
            raise SystemExit("registry reached")

        install_skill.load_tool_registry = registry_reached
        sys.argv = ["install_skill.py", "demo"]
        try:
            with self.assertRaisesRegex(SystemExit, "registry reached"):
                install_skill.main()
        finally:
            sys.argv = old_argv
            install_skill.resolve_credentials = original_credentials
            install_skill.recover_pending_transactions = original_recover
            install_skill.load_tool_registry = original_registry
        self.assertEqual(recovered, [])

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
            install_skill.preflight_skills,
            install_skill.api_download_bytes,
            install_skill.install_nodes,
            install_skill.report_install,
        )

        install_skill.build_install_plan = lambda *_args: {"root": node, "nodes": [node], "blockers": []}
        install_skill.preflight_skills = lambda *_args: {
            "plan_id": "1c70dfff-85d0-4770-99c8-937a10dde901",
            "expires_at": "2026-07-13T12:05:00Z",
            "items": [{"skill": "root", "env_key": "OPENAI_API_KEY", "required": True}],
            "tombstones": [],
            "blockers": 1,
            "warnings": 0,
        }
        install_skill.api_download_bytes = lambda *_args: calls.__setitem__("downloads", calls["downloads"] + 1)
        install_skill.install_nodes = lambda *_args: calls.__setitem__("installs", calls["installs"] + 1)
        install_skill.report_install = lambda *_args: calls.__setitem__("reports", calls["reports"] + 1)
        try:
            code, out, _err = self._run_main(["root", "--tools", "claude-code", "--json"])
        finally:
            (
                install_skill.build_install_plan,
                install_skill.preflight_skills,
                install_skill.api_download_bytes,
                install_skill.install_nodes,
                install_skill.report_install,
            ) = originals

        self.assertEqual(code, 2)
        payload = json.loads(out)
        self.assertEqual(payload["secretPreflight"]["items"][0]["env_key"], "OPENAI_API_KEY")
        self.assertEqual(calls, {"downloads": 0, "installs": 0, "reports": 0})
        self.assertFalse(companion_lib.lockfile_path().exists())

    def test_main_local_conflict_blocker_stops_before_mutation(self) -> None:
        calls = {"downloads": 0, "installs": 0, "reports": 0}
        node = {"slug": "root", "version": "1.0.0", "skill": {"name": "root", "slug": "root", "version": "1.0.0"}}
        originals = (
            install_skill.build_install_plan,
            install_skill.preflight_skills,
            install_skill.preflight_target_conflicts,
            install_skill.api_download_bytes,
            install_skill.install_nodes,
            install_skill.report_install,
        )

        install_skill.build_install_plan = lambda *_args: {"root": node, "nodes": [node], "blockers": []}
        install_skill.preflight_skills = lambda *_args: {"plan_id": "7b36fa22-2457-46e5-9b6b-e0123cd140fa", "items": [], "tombstones": [], "blockers": 0, "warnings": 0}
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
                install_skill.preflight_skills,
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
            install_skill.preflight_skills,
            install_skill.preflight_target_conflicts,
            install_skill.install_nodes,
            install_skill.report_install,
        )

        install_skill.build_install_plan = lambda *_args: {"root": root, "nodes": [dep, root], "blockers": []}
        install_skill.preflight_skills = lambda *_args: {"plan_id": "9ff7df41-ed2a-4df8-bb3e-585231c5277b", "items": [], "tombstones": [], "blockers": 0, "warnings": 0}
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
                install_skill.preflight_skills,
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
            install_skill.preflight_skills,
            install_skill.preflight_target_conflicts,
            install_skill.install_nodes,
            install_skill.report_install,
        )

        install_skill.build_install_plan = lambda *_args: {"root": root, "nodes": [dep, root], "blockers": []}
        install_skill.preflight_skills = lambda *_args: {"plan_id": "d584eb67-e9de-4d0b-b91c-c809fd4c911f", "items": [], "tombstones": [], "blockers": 0, "warnings": 0}
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
                install_skill.preflight_skills,
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
