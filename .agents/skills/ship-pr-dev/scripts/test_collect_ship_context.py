from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from review_dependency import resolve_review_skill_dir


MODULE_PATH = Path(__file__).with_name("collect_ship_context.py")
PREPARE_PATH = Path(__file__).with_name("prepare_ship_run.py")
SPEC = importlib.util.spec_from_file_location("collect_ship_context", MODULE_PATH)
assert SPEC and SPEC.loader
collector = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(collector)


class CollectShipContextTests(unittest.TestCase):
    def test_project_discovery_respects_git_ignores(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            subprocess.run(["git", "init", "-b", "main"], cwd=repo, check=True, stdout=subprocess.PIPE)
            (repo / ".gitignore").write_text("ignored/\n", encoding="utf-8")
            (repo / "package.json").write_text("{}\n", encoding="utf-8")
            (repo / "pyproject.toml").write_text("[project]\nname = 'demo'\n", encoding="utf-8")
            workflow = repo / ".github" / "workflows" / "ci.yml"
            workflow.parent.mkdir(parents=True)
            workflow.write_text("name: CI\n", encoding="utf-8")
            ignored = repo / "ignored" / "package.json"
            ignored.parent.mkdir(parents=True)
            ignored.write_text("{}\n", encoding="utf-8")
            subprocess.run(
                ["git", "add", ".gitignore", "package.json", ".github/workflows/ci.yml"],
                cwd=repo,
                check=True,
                stdout=subprocess.PIPE,
            )

            manifests, ci_files = collector.find_project_files(repo)

            self.assertEqual(manifests, ["package.json", "pyproject.toml"])
            self.assertEqual(ci_files, [".github/workflows/ci.yml"])
            self.assertNotIn("ignored/package.json", manifests)

    def test_ship_artifacts_use_review_gate_safety_helpers(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            subprocess.run(["git", "init", "-b", "main"], cwd=repo, check=True, stdout=subprocess.PIPE)

            result = subprocess.run(
                [sys.executable, str(PREPARE_PATH), "--cwd", str(repo)],
                check=True,
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )
            metadata = json.loads(result.stdout)

            self.assertEqual(metadata["artifact_root"], "plans/ship-pr-dev")
            self.assertTrue(metadata["git_exclude"]["verified"])
            self.assertTrue(metadata["non_committable"])
            exclude = (repo / ".git" / "info" / "exclude").read_text(encoding="utf-8")
            self.assertIn("/plans/ship-pr-dev/", exclude.splitlines())

    def test_review_dependency_supports_explicit_non_sibling_install(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            skill_dir = Path(tmp) / "custom-review-install"
            (skill_dir / "scripts").mkdir(parents=True)
            (skill_dir / "SKILL.md").write_text("---\nname: review-code-dev\n---\n", encoding="utf-8")

            with patch.dict(os.environ, {"REVIEW_CODE_DEV_SKILL_DIR": str(skill_dir)}):
                self.assertEqual(resolve_review_skill_dir(), skill_dir.resolve())

    def test_review_context_uses_dependency_cli_json_contract(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            skill_dir = root / "review-code-dev"
            scripts = skill_dir / "scripts"
            scripts.mkdir(parents=True)
            (skill_dir / "SKILL.md").write_text("---\nname: review-code-dev\n---\n", encoding="utf-8")
            fake_collector = scripts / "collect_review_context.py"
            fake_collector.write_text(
                "import json, sys\n"
                "assert '--mode' in sys.argv and sys.argv[sys.argv.index('--mode') + 1] == 'base'\n"
                "assert '--base' in sys.argv and sys.argv[sys.argv.index('--base') + 1] == 'main'\n"
                "print(json.dumps({'diff_ref': 'origin/main', "
                "'diff_range': 'origin/main...HEAD', 'diff_stat': '1 file changed'}))\n",
                encoding="utf-8",
            )

            with patch.dict(os.environ, {"REVIEW_CODE_DEV_SKILL_DIR": str(skill_dir)}):
                payload = collector.collect_review_context(root, "main")

            self.assertEqual(payload["diff_ref"], "origin/main")
            self.assertEqual(payload["diff_range"], "origin/main...HEAD")


if __name__ == "__main__":
    unittest.main()
