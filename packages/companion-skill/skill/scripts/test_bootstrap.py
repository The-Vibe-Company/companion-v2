#!/usr/bin/env python3
"""Unit tests for the local Companion bootstrap."""

from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
import zipfile
from contextlib import redirect_stderr
from hashlib import sha256
from io import StringIO
from pathlib import Path
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import bootstrap  # noqa: E402
import bootstrap_update  # noqa: E402

TEST_BASELINE_FILES = [
    "SKILL.md",
    "companion.json",
    "scripts/bootstrap.py",
    "scripts/bootstrap_integrity.py",
    "scripts/bootstrap_update.py",
    "scripts/check_updates.py",
    "scripts/companion_lib.py",
    "scripts/skill_guard.py",
]


def skill_row(version="1.0.0", integrity=None):
    return {
        "workspaceId": "ws-1",
        "status": "installed",
        "installedVersion": version,
        "availableVersion": version,
        "changes": [],
        "integrity": integrity or {"packageChecksum": f"sha256:{'b' * 64}", "files": {}},
    }


def api_rows(path):
    if path == "/skills?lib=org":
        return [{"slug": "alpha", "id": "ID-A", "current_version": "2.0.0", "scope": "org"}]
    if path == "/skills?lib=mine":
        return []
    if path == "/skills?installed=true":
        return [{"slug": "alpha", "id": "ID-A", "installed_version": "1.0.0", "current_version": "2.0.0", "install_status": "update"}]
    raise AssertionError(f"unexpected path: {path}")


class BootstrapTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.skill_dir = self.root / "companion"
        (self.skill_dir / "scripts").mkdir(parents=True)
        (self.skill_dir / "SKILL.md").write_text("---\nname: companion\n---\n", encoding="utf-8")
        (self.skill_dir / "companion.json").write_text(json.dumps({"version": "1.0.0"}), encoding="utf-8")
        for rel in (
            "scripts/bootstrap.py",
            "scripts/bootstrap_integrity.py",
            "scripts/bootstrap_update.py",
            "scripts/check_updates.py",
            "scripts/companion_lib.py",
            "scripts/skill_guard.py",
        ):
            (self.skill_dir / rel).write_text(f"# {rel}\n", encoding="utf-8")
        self.write_local_baseline("1.0.0")
        self.home = self.root / "home"
        self.home.mkdir()
        self.env = mock.patch.dict(
            os.environ,
            {
                "COMPANION_SKILL_DIR": str(self.skill_dir),
                "COMPANION_HOME": str(self.home),
                "COMPANION_API_URL": "https://api.example/v1",
                "COMPANION_TOKEN": "cmp_pat_SECRET",
                "COMPANION_WORKSPACE_ID": "ws-1",
            },
            clear=False,
        )
        self.env.start()

    def tearDown(self):
        self.env.stop()
        self._tmp.cleanup()

    def integrity_for_local_files(self):
        return {
            "packageChecksum": f"sha256:{'c' * 64}",
            "files": {rel: bootstrap.sha256_file(self.skill_dir / rel) for rel in TEST_BASELINE_FILES},
        }

    def write_local_baseline(self, version):
        (self.skill_dir / bootstrap.INTEGRITY_BASELINE_FILE).write_text(
            json.dumps(
                {
                    "schemaVersion": 1,
                    "version": version,
                    "files": {rel: bootstrap.sha256_file(self.skill_dir / rel) for rel in TEST_BASELINE_FILES},
                }
            ),
            encoding="utf-8",
        )

    def run_with_api(self, local_skill, **kwargs):
        def fake_get(_api_url, _token, path):
            if path == "/local-skills/companion":
                return local_skill
            return api_rows(path)

        with mock.patch.object(bootstrap, "api_get", side_effect=fake_get):
            return bootstrap.collect_context(**kwargs)

    def test_missing_credentials_reports_error_without_token(self):
        with mock.patch.dict(os.environ, {"COMPANION_API_URL": "", "COMPANION_TOKEN": "", "COMPANION_WORKSPACE_ID": ""}):
            with redirect_stderr(StringIO()):
                ctx = bootstrap.collect_context()
        self.assertTrue(ctx["errors"])
        self.assertNotIn("cmp_pat_SECRET", json.dumps(ctx))

    def test_current_context_reports_official_integrity(self):
        ctx = self.run_with_api(skill_row(integrity=self.integrity_for_local_files()))
        self.assertFalse(ctx["errors"])
        self.assertEqual("official", ctx["integrity"]["status"])
        self.assertEqual("local-baseline", ctx["integrity"]["source"])
        self.assertTrue(ctx["integrity"]["comparable"])
        self.assertEqual("1.0.0", ctx["companion"]["localVersion"])
        self.assertEqual("1.0.0", ctx["companion"]["availableVersion"])
        self.assertEqual(1, len(ctx["skills"]["updates"]))
        self.assertIn({"kind": "review_skill_updates", "count": 1}, ctx["actions"])
        self.assertNotIn("cmp_pat_SECRET", json.dumps(ctx))

    def test_unexpected_skill_list_shape_reports_error(self):
        def fake_get(_api_url, _token, path):
            if path == "/local-skills/companion":
                return skill_row(integrity=self.integrity_for_local_files())
            if path == "/skills?lib=org":
                return {"unexpected": True}
            return []

        with mock.patch.object(bootstrap, "api_get", side_effect=fake_get):
            ctx = bootstrap.collect_context()
        self.assertTrue(ctx["errors"])
        self.assertIn("unexpected response shape", ctx["errors"][0]["message"])

    def test_auto_update_does_not_wait_on_skill_inventory(self):
        row = skill_row(version="1.1.0", integrity=self.integrity_for_local_files())
        row["availableVersion"] = "1.1.0"
        result = {"applied": True, "version": "1.1.0", "backupPath": "/tmp/backup", "report": {"status": "installed"}}

        def fake_get(_api_url, _token, path):
            if path == "/local-skills/companion":
                return row
            if path == "/skills?lib=org":
                return {"unexpected": True}
            return []

        with (
            mock.patch.object(bootstrap, "api_get", side_effect=fake_get),
            mock.patch.object(bootstrap_update, "install_companion_update", return_value=result),
        ):
            ctx = bootstrap.collect_context(auto_update=True)

        self.assertTrue(ctx["companion"]["autoUpdate"]["applied"])
        self.assertEqual("installed", ctx["companion"]["status"])
        self.assertEqual("1.1.0", ctx["companion"]["localVersion"])
        self.assertNotIn({"kind": "update_companion", "version": "1.1.0"}, ctx["actions"])
        self.assertTrue(ctx["errors"])
        self.assertIn("unexpected response shape", ctx["errors"][0]["message"])

    def test_update_available_adds_companion_action(self):
        row = skill_row(version="1.1.0", integrity=self.integrity_for_local_files())
        row["availableVersion"] = "1.1.0"
        ctx = self.run_with_api(row)
        self.assertIn({"kind": "update_companion", "version": "1.1.0"}, ctx["actions"])

    def test_auto_update_uses_local_baseline_instead_of_new_version_hashes(self):
        integrity = self.integrity_for_local_files()
        integrity["files"]["scripts/bootstrap.py"] = f"sha256:{'0' * 64}"
        row = skill_row(version="1.1.0", integrity=integrity)
        row["availableVersion"] = "1.1.0"
        result = {"applied": True, "version": "1.1.0", "backupPath": "/tmp/backup", "report": {"status": "installed"}}
        with mock.patch.object(bootstrap_update, "install_companion_update", return_value=result):
            ctx = self.run_with_api(row, auto_update=True)
        self.assertTrue(ctx["integrity"]["comparable"])
        self.assertEqual("local-baseline", ctx["integrity"]["source"])
        self.assertTrue(ctx["companion"]["autoUpdate"]["applied"])

    def test_auto_update_refuses_when_integrity_baseline_is_unavailable(self):
        (self.skill_dir / bootstrap.INTEGRITY_BASELINE_FILE).unlink()
        row = skill_row(version="1.1.0", integrity={"packageChecksum": f"sha256:{'b' * 64}", "files": {}})
        row["availableVersion"] = "1.1.0"
        with mock.patch.object(bootstrap, "install_companion_update") as install:
            ctx = self.run_with_api(row, auto_update=True)
        install.assert_not_called()
        self.assertFalse(ctx["integrity"]["comparable"])
        self.assertTrue(ctx["companion"]["autoUpdate"]["blocked"])
        self.assertEqual("integrity_unavailable", ctx["companion"]["autoUpdate"]["reason"])

    def test_auto_update_refuses_modified_file_against_installed_baseline(self):
        (self.skill_dir / "scripts/bootstrap.py").write_text("# local customization\n", encoding="utf-8")
        row = skill_row(version="1.1.0", integrity={"packageChecksum": f"sha256:{'b' * 64}", "files": {}})
        row["availableVersion"] = "1.1.0"
        with mock.patch.object(bootstrap, "install_companion_update") as install:
            ctx = self.run_with_api(row, auto_update=True)
        install.assert_not_called()
        self.assertTrue(ctx["integrity"]["comparable"])
        self.assertEqual("customized", ctx["integrity"]["status"])
        self.assertEqual(["scripts/bootstrap.py"], ctx["integrity"]["blockingFiles"])
        self.assertTrue(ctx["companion"]["autoUpdate"]["blocked"])
        self.assertEqual("local_customizations", ctx["companion"]["autoUpdate"]["reason"])

    def test_auto_update_refuses_invalid_installed_baseline(self):
        (self.skill_dir / bootstrap.INTEGRITY_BASELINE_FILE).write_text("{not json", encoding="utf-8")
        row = skill_row(version="1.1.0", integrity={"packageChecksum": f"sha256:{'b' * 64}", "files": {}})
        row["availableVersion"] = "1.1.0"
        with mock.patch.object(bootstrap, "install_companion_update") as install:
            ctx = self.run_with_api(row, auto_update=True)
        install.assert_not_called()
        self.assertTrue(ctx["integrity"]["comparable"])
        self.assertEqual("local-baseline-invalid", ctx["integrity"]["source"])
        self.assertTrue(ctx["companion"]["autoUpdate"]["blocked"])
        self.assertEqual("integrity_unavailable", ctx["companion"]["autoUpdate"]["reason"])

    def test_auto_update_refuses_unsafe_installed_baseline_path(self):
        (self.skill_dir / bootstrap.INTEGRITY_BASELINE_FILE).write_text(
            json.dumps({"schemaVersion": 1, "version": "1.0.0", "files": {"scripts//bad.py": f"sha256:{'a' * 64}"}}),
            encoding="utf-8",
        )
        row = skill_row(version="1.1.0", integrity={"packageChecksum": f"sha256:{'b' * 64}", "files": {}})
        row["availableVersion"] = "1.1.0"
        with mock.patch.object(bootstrap, "install_companion_update") as install:
            ctx = self.run_with_api(row, auto_update=True)
        install.assert_not_called()
        self.assertEqual("local-baseline-invalid", ctx["integrity"]["source"])
        self.assertTrue(ctx["companion"]["autoUpdate"]["blocked"])

    def test_auto_update_applies_when_integrity_is_official(self):
        row = skill_row(version="1.1.0", integrity=self.integrity_for_local_files())
        row["availableVersion"] = "1.1.0"
        result = {"applied": True, "version": "1.1.0", "backupPath": "/tmp/backup", "report": {"status": "installed"}}
        with mock.patch.object(bootstrap_update, "install_companion_update", return_value=result):
            ctx = self.run_with_api(row, auto_update=True)
        self.assertTrue(ctx["companion"]["autoUpdate"]["applied"])
        self.assertEqual("installed", ctx["companion"]["status"])
        self.assertEqual("1.1.0", ctx["companion"]["localVersion"])
        self.assertNotIn({"kind": "update_companion", "version": "1.1.0"}, ctx["actions"])

    def test_install_update_accepts_package_files_at_zip_root(self):
        official_files = {}

        def write_package(_api_url, _token, destination, _expected_checksum=None):
            skill_md = "---\nname: companion\n---\n"
            manifest = json.dumps({"version": "1.1.0"})
            bootstrap_script = "# bootstrap\n"
            files = {
                "SKILL.md": f"sha256:{sha256(skill_md.encode('utf-8')).hexdigest()}",
                "companion.json": f"sha256:{sha256(manifest.encode('utf-8')).hexdigest()}",
                "scripts/bootstrap.py": f"sha256:{sha256(bootstrap_script.encode('utf-8')).hexdigest()}",
                "scripts/check_updates.py": f"sha256:{sha256(b'# check\n').hexdigest()}",
                "scripts/companion_lib.py": f"sha256:{sha256(b'# lib\n').hexdigest()}",
                "scripts/skill_guard.py": f"sha256:{sha256(b'# guard\n').hexdigest()}",
            }
            baseline = json.dumps({"schemaVersion": 1, "version": "1.1.0", "files": files})
            official_files.update(files)
            official_files[bootstrap.INTEGRITY_BASELINE_FILE] = f"sha256:{sha256(baseline.encode('utf-8')).hexdigest()}"
            with zipfile.ZipFile(destination, "w") as zf:
                zf.writestr("SKILL.md", skill_md)
                zf.writestr("companion.json", manifest)
                zf.writestr("scripts/bootstrap.py", bootstrap_script)
                zf.writestr("scripts/check_updates.py", "# check\n")
                zf.writestr("scripts/companion_lib.py", "# lib\n")
                zf.writestr("scripts/skill_guard.py", "# guard\n")
                zf.writestr(bootstrap.INTEGRITY_BASELINE_FILE, baseline)

        with (
            mock.patch.object(bootstrap_update, "download_package", side_effect=write_package),
            mock.patch.object(bootstrap_update, "api_post_json", return_value={"status": "installed"}),
        ):
            result = bootstrap.install_companion_update("https://api.example/v1", "cmp_pat_SECRET", self.skill_dir, "1.1.0", "Codex", official_files)

        self.assertTrue(result["applied"])
        self.assertEqual("1.1.0", json.loads((self.skill_dir / "companion.json").read_text(encoding="utf-8"))["version"])
        backup = Path(result["backupPath"])
        self.assertTrue(backup.exists())
        self.assertEqual("1.0.0", json.loads((backup / "companion.json").read_text(encoding="utf-8"))["version"])

    def test_install_update_restores_backup_when_reporting_fails(self):
        official_files = {}

        def write_package(_api_url, _token, destination, _expected_checksum=None):
            skill_md = "---\nname: companion\n---\n"
            manifest = json.dumps({"version": "1.1.0"})
            files = {
                "SKILL.md": f"sha256:{sha256(skill_md.encode('utf-8')).hexdigest()}",
                "companion.json": f"sha256:{sha256(manifest.encode('utf-8')).hexdigest()}",
                "scripts/bootstrap.py": f"sha256:{sha256(b'# bootstrap\n').hexdigest()}",
            }
            baseline = json.dumps({"schemaVersion": 1, "version": "1.1.0", "files": files})
            official_files.update(files)
            official_files[bootstrap.INTEGRITY_BASELINE_FILE] = f"sha256:{sha256(baseline.encode('utf-8')).hexdigest()}"
            with zipfile.ZipFile(destination, "w") as zf:
                zf.writestr("SKILL.md", skill_md)
                zf.writestr("companion.json", manifest)
                zf.writestr("scripts/bootstrap.py", "# bootstrap\n")
                zf.writestr(bootstrap.INTEGRITY_BASELINE_FILE, baseline)

        with (
            mock.patch.object(bootstrap_update, "download_package", side_effect=write_package),
            mock.patch.object(bootstrap_update, "api_post_json", side_effect=SystemExit(1)),
            self.assertRaises(SystemExit),
        ):
            bootstrap.install_companion_update("https://api.example/v1", "cmp_pat_SECRET", self.skill_dir, "1.1.0", "Codex", official_files)

        self.assertEqual("1.0.0", json.loads((self.skill_dir / "companion.json").read_text(encoding="utf-8"))["version"])

    def test_install_update_rejects_self_consistent_package_that_differs_from_workspace_hashes(self):
        def write_package(_api_url, _token, destination, _expected_checksum=None):
            skill_md = "---\nname: companion\n---\n"
            manifest = json.dumps({"version": "1.1.0"})
            files = {
                "SKILL.md": f"sha256:{sha256(skill_md.encode('utf-8')).hexdigest()}",
                "companion.json": f"sha256:{sha256(manifest.encode('utf-8')).hexdigest()}",
                "scripts/bootstrap.py": f"sha256:{sha256(b'# bootstrap\n').hexdigest()}",
            }
            with zipfile.ZipFile(destination, "w") as zf:
                zf.writestr("SKILL.md", skill_md)
                zf.writestr("companion.json", manifest)
                zf.writestr("scripts/bootstrap.py", "# bootstrap\n")
                zf.writestr(bootstrap.INTEGRITY_BASELINE_FILE, json.dumps({"schemaVersion": 1, "version": "1.1.0", "files": files}))

        official_files = {"scripts/bootstrap.py": f"sha256:{'0' * 64}"}
        with (
            mock.patch.object(bootstrap_update, "download_package", side_effect=write_package),
            mock.patch.object(bootstrap_update, "api_post_json") as report,
            self.assertRaises(SystemExit),
        ):
            bootstrap.install_companion_update("https://api.example/v1", "cmp_pat_SECRET", self.skill_dir, "1.1.0", "Codex", official_files)

        report.assert_not_called()
        self.assertEqual("1.0.0", json.loads((self.skill_dir / "companion.json").read_text(encoding="utf-8"))["version"])

    def test_install_update_rejects_zip_members_outside_package_dir(self):
        def write_package(_api_url, _token, destination, _expected_checksum=None):
            with zipfile.ZipFile(destination, "w") as zf:
                zf.writestr("../escape.txt", "bad")

        with (
            mock.patch.object(bootstrap_update, "download_package", side_effect=write_package),
            mock.patch.object(bootstrap_update, "api_post_json") as report,
            self.assertRaises(SystemExit) as raised,
        ):
            bootstrap.install_companion_update("https://api.example/v1", "cmp_pat_SECRET", self.skill_dir, "1.1.0", "Codex", {})

        self.assertIn("unsafe path", str(raised.exception))
        report.assert_not_called()
        self.assertEqual("1.0.0", json.loads((self.skill_dir / "companion.json").read_text(encoding="utf-8"))["version"])

    def test_leave_skill_cwd_moves_out_before_replacing_skill_dir(self):
        original = Path.cwd()
        try:
            os.chdir(self.skill_dir / "scripts")
            restore = bootstrap_update.leave_skill_cwd(self.skill_dir)
            self.assertEqual((self.skill_dir / "scripts").resolve(), restore.resolve() if restore else None)
            self.assertEqual(self.skill_dir.parent.resolve(), Path.cwd().resolve())
        finally:
            os.chdir(original)

    def test_lockfile_obsolete_skill_is_reported(self):
        (self.home / "skills.lock.json").write_text(
            json.dumps(
                {
                    "schemaVersion": 2,
                    "activeWorkspaceId": "ws-1",
                    "workspaces": {
                        "ws-1": {
                            "apiUrl": "https://api.example/v1",
                            "skills": {"alpha": {"slug": "alpha", "version": "1.0.0", "skillId": "ID-A"}},
                        }
                    },
                }
            ),
            encoding="utf-8",
        )
        ctx = self.run_with_api(skill_row(integrity=self.integrity_for_local_files()))
        self.assertEqual(1, ctx["skills"]["counts"]["update"])
        self.assertEqual("update", ctx["skills"]["local"][0]["status"])


if __name__ == "__main__":
    unittest.main()
