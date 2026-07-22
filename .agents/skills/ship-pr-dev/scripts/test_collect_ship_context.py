from __future__ import annotations

import importlib.util
import subprocess
import tempfile
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).with_name("collect_ship_context.py")
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


if __name__ == "__main__":
    unittest.main()
