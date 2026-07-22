from __future__ import annotations

import importlib.util
import subprocess
import tempfile
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).with_name("collect_review_context.py")
SPEC = importlib.util.spec_from_file_location("collect_review_context", MODULE_PATH)
assert SPEC and SPEC.loader
collector = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(collector)


def git(cwd: Path, *args: str) -> str:
    return subprocess.run(
        ["git", *args],
        cwd=cwd,
        check=True,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    ).stdout.strip()


class CollectReviewContextTests(unittest.TestCase):
    def test_feature_upstream_does_not_replace_default_base(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            origin = root / "origin.git"
            repo = root / "repo"
            subprocess.run(["git", "init", "--bare", str(origin)], check=True, stdout=subprocess.PIPE)
            subprocess.run(["git", "clone", str(origin), str(repo)], check=True, stdout=subprocess.PIPE)
            git(repo, "config", "user.email", "test@example.test")
            git(repo, "config", "user.name", "Test")
            git(repo, "checkout", "-b", "main")
            (repo / "base.txt").write_text("base\n", encoding="utf-8")
            git(repo, "add", "base.txt")
            git(repo, "commit", "-m", "base")
            git(repo, "push", "-u", "origin", "main")
            git(repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main")

            git(repo, "checkout", "-b", "feature")
            (repo / "feature.txt").write_text("feature\n", encoding="utf-8")
            git(repo, "add", "feature.txt")
            git(repo, "commit", "-m", "feature")
            git(repo, "push", "-u", "origin", "feature")

            self.assertEqual(collector.detect_base_branch(repo), "main")
            context = collector.collect_base(repo, "main", 1_000_000)
            self.assertEqual(context["diff_range"], "origin/main...HEAD")
            self.assertEqual(context["changed_files"], ["feature.txt"])

    def test_redacts_tracked_and_quoted_secrets(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            git(repo, "init", "-b", "main")
            git(repo, "config", "user.email", "test@example.test")
            git(repo, "config", "user.name", "Test")
            target = repo / "config.txt"
            target.write_text("safe=true\n", encoding="utf-8")
            git(repo, "add", "config.txt")
            git(repo, "commit", "-m", "base")
            target.write_text('password = "hunter2 backup"\n', encoding="utf-8")
            git(repo, "add", "config.txt")

            context = collector.collect_worktree_state(repo, 1_000_000)
            staged = context["staged_diff"]["text"]
            self.assertIn("password = <redacted>", staged)
            self.assertNotIn("hunter2", staged)
            self.assertNotIn("backup", staged)

    def test_untracked_preview_is_bounded_before_decoding(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            git(repo, "init", "-b", "main")
            target = repo / "large.txt"
            target.write_text("x" * (collector.DEFAULT_MAX_UNTRACKED_FILE_BYTES + 100), encoding="utf-8")

            preview = collector.collect_untracked_previews(repo, ["large.txt"])[0]
            self.assertEqual(preview["byte_length"], target.stat().st_size)
            self.assertEqual(len(preview["text"]), collector.DEFAULT_MAX_UNTRACKED_FILE_BYTES)
            self.assertTrue(preview["truncated"])


if __name__ == "__main__":
    unittest.main()
