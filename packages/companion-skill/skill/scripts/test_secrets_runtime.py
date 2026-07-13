#!/usr/bin/env python3

from __future__ import annotations

import json
import os
import sys
import tempfile
import threading
import unittest
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import secrets_runtime  # noqa: E402


WORKSPACE = "7ab5fcf5-c49c-4a67-bad8-d6b36e28a1dc"
SENTINEL = "SENTINEL_secret_value_297"


class SecretRuntimeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.old_home = os.environ.get("COMPANION_HOME")
        os.environ["COMPANION_HOME"] = str(self.root / ".companion")

    def tearDown(self) -> None:
        if self.old_home is None:
            os.environ.pop("COMPANION_HOME", None)
        else:
            os.environ["COMPANION_HOME"] = self.old_home
        self.tmp.cleanup()

    def item(self, value: str = SENTINEL) -> dict[str, object]:
        return {
            "projection_id": "5f81d77a-f99c-4d54-b217-d6a3479ec9ab",
            "skill": "demo-skill",
            "skill_version": "1.2.3",
            "slot_id": "3dc0c51a-710b-4c9d-bac0-2269aa76f56e",
            "env_key": "DEMO_TOKEN",
            "secret_id": "c933a777-ffeb-444a-af2e-b645d164f811",
            "secret_version": 4,
            "value": value,
        }

    def test_projection_permissions_and_value_free_state(self) -> None:
        path = secrets_runtime.write_projection(WORKSPACE, "demo-skill", [self.item()])
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(path.parent.stat().st_mode & 0o777, 0o700)
        self.assertIn(SENTINEL, path.read_text(encoding="utf-8"))
        secrets_runtime.update_projection_state(
            WORKSPACE,
            {"items": [self.item()], "tombstones": []},
            {"demo-skill": path},
        )
        state = secrets_runtime.state_path().read_text(encoding="utf-8")
        self.assertNotIn(SENTINEL, state)
        parsed = json.loads(state)
        projection = next(iter(parsed["workspaces"][WORKSPACE]["projections"].values()))
        self.assertEqual(projection["secretVersion"], 4)
        self.assertEqual(projection["envKey"], "DEMO_TOKEN")

    def test_manual_projection_uses_the_fixed_internal_namespace(self) -> None:
        item = self.item()
        item["skill"] = "_manual/local-profile"
        path = secrets_runtime.write_projection(WORKSPACE, "_manual/local-profile", [item])

        self.assertEqual(
            path,
            Path(os.environ["COMPANION_HOME"]) / "secrets" / WORKSPACE / "_manual" / "local-profile" / ".env",
        )
        with self.assertRaises(ValueError):
            secrets_runtime.projection_dir(WORKSPACE, "_manual/../escape")

    def test_dotenv_escaping_is_one_physical_line(self) -> None:
        rendered = secrets_runtime.render_projection([self.item('a"b\\c\nnext')]).decode("utf-8")
        self.assertEqual(rendered, 'DEMO_TOKEN="a\\"b\\\\c\\nnext"\n')

    def test_rejects_path_traversal_and_symlinked_projection_path(self) -> None:
        with self.assertRaises(ValueError):
            secrets_runtime.projection_dir(WORKSPACE, "../escape")
        root = Path(os.environ["COMPANION_HOME"])
        root.mkdir(parents=True)
        outside = self.root / "outside"
        outside.mkdir()
        (root / "secrets").symlink_to(outside, target_is_directory=True)
        with self.assertRaises(ValueError):
            secrets_runtime.projection_dir(WORKSPACE, "demo-skill")

    def test_concurrent_writers_leave_one_coherent_projection(self) -> None:
        values = [f"value-{index}-" + ("x" * 1000) for index in range(8)]
        threads = [threading.Thread(target=secrets_runtime.write_projection, args=(WORKSPACE, "demo-skill", [self.item(value)])) for value in values]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        final = (secrets_runtime.projection_dir(WORKSPACE, "demo-skill") / ".env").read_text(encoding="utf-8")
        self.assertIn(final.removeprefix('DEMO_TOKEN="').removesuffix('"\n'), values)

    def test_concurrent_state_merges_do_not_lose_other_skills(self) -> None:
        rows = []
        for index in range(8):
            item = self.item(f"value-{index}")
            item["projection_id"] = f"5f81d77a-f99c-4d54-b217-d6a3479eca{index:02d}"
            item["skill"] = f"demo-skill-{index}"
            path = secrets_runtime.write_projection(WORKSPACE, str(item["skill"]), [item])
            rows.append((item, path))
        threads = [
            threading.Thread(
                target=secrets_runtime.update_projection_state,
                args=(WORKSPACE, {"items": [item], "tombstones": []}, {str(item["skill"]): path}),
            )
            for item, path in rows
        ]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        state = json.loads(secrets_runtime.state_path().read_text(encoding="utf-8"))
        self.assertEqual(len(state["workspaces"][WORKSPACE]["projections"]), len(rows))

    def test_package_and_projection_rollback_together(self) -> None:
        package = self.root / "package"
        package.mkdir()
        (package / "SKILL.md").write_text("new", encoding="utf-8")
        target = self.root / "tools" / "demo-skill"
        target.mkdir(parents=True)
        (target / "SKILL.md").write_text("old", encoding="utf-8")
        old_env = secrets_runtime.write_projection(WORKSPACE, "demo-skill", [self.item("old-secret")])
        original_rename = Path.rename

        def fail_env_swap(path: Path, destination: Path) -> Path:
            if path.name.startswith("..env.staging."):
                raise OSError("simulated env swap failure")
            return original_rename(path, destination)

        Path.rename = fail_env_swap
        try:
            with self.assertRaises(OSError):
                secrets_runtime.deploy_packages_with_projection(package, [target], WORKSPACE, "demo-skill", [self.item("new-secret")])
        finally:
            Path.rename = original_rename
        self.assertEqual((target / "SKILL.md").read_text(encoding="utf-8"), "old")
        self.assertIn("old-secret", old_env.read_text(encoding="utf-8"))
        self.assertNotIn("new-secret", old_env.read_text(encoding="utf-8"))

    def test_next_operation_recovers_and_removes_plaintext_crash_backup(self) -> None:
        directory = secrets_runtime.projection_dir(WORKSPACE, "demo-skill")
        env_path = directory / ".env"
        env_path.write_text('DEMO_TOKEN="new-secret"\n', encoding="utf-8")
        env_backup = directory / "..env.backup.crash"
        env_backup.write_text('DEMO_TOKEN="old-secret"\n', encoding="utf-8")
        os.chmod(env_path, 0o600)
        os.chmod(env_backup, 0o600)
        marker = directory / ".transaction.json"
        marker.write_text(
            json.dumps({
                "targets": [],
                "envPath": str(env_path),
                "envBackup": str(env_backup),
                "envStaging": str(directory / "..env.staging.crash"),
                "envExisted": True,
            }),
            encoding="utf-8",
        )

        secrets_runtime.recover_pending_transactions(WORKSPACE)

        self.assertEqual(env_path.read_text(encoding="utf-8"), 'DEMO_TOKEN="old-secret"\n')
        self.assertFalse(marker.exists())
        self.assertFalse(env_backup.exists())
        self.assertEqual(list(directory.glob("..env.backup.*")), [])

    def test_tombstone_recovers_interrupted_swap_before_removing_projection(self) -> None:
        directory = secrets_runtime.projection_dir(WORKSPACE, "demo-skill")
        env_path = directory / ".env"
        env_path.write_text('DEMO_TOKEN="new-secret"\n', encoding="utf-8")
        env_backup = directory / "..env.backup.crash"
        env_backup.write_text('DEMO_TOKEN="old-secret"\n', encoding="utf-8")
        marker = directory / ".transaction.json"
        marker.write_text(
            json.dumps({
                "targets": [],
                "envPath": str(env_path),
                "envBackup": str(env_backup),
                "envStaging": str(directory / "..env.staging.crash"),
                "envExisted": True,
            }),
            encoding="utf-8",
        )

        secrets_runtime.remove_projection(WORKSPACE, "demo-skill")

        self.assertFalse(env_path.exists())
        self.assertFalse(marker.exists())
        self.assertFalse(env_backup.exists())


if __name__ == "__main__":
    unittest.main()
