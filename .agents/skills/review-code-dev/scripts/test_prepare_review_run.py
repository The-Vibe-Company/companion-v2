from __future__ import annotations

import importlib.util
import subprocess
import tempfile
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).with_name("prepare_review_run.py")
SPEC = importlib.util.spec_from_file_location("prepare_review_run", MODULE_PATH)
assert SPEC and SPEC.loader
preparer = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(preparer)


class PrepareReviewRunTests(unittest.TestCase):
    def test_artifact_root_rejects_symlink_escape(self) -> None:
        with tempfile.TemporaryDirectory() as tmp, tempfile.TemporaryDirectory() as outside:
            repo = Path(tmp)
            subprocess.run(["git", "init", "-b", "main"], cwd=repo, check=True, stdout=subprocess.PIPE)
            (repo / "plans").symlink_to(Path(outside), target_is_directory=True)

            with self.assertRaisesRegex(SystemExit, "symlink component"):
                preparer.safe_artifact_root(repo, Path("plans/review-code-dev"))


if __name__ == "__main__":
    unittest.main()
