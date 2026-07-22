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

    def test_feature_upstream_is_ignored_when_origin_head_is_missing(self) -> None:
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
            git(repo, "checkout", "-b", "feature")
            (repo / "feature.txt").write_text("feature\n", encoding="utf-8")
            git(repo, "add", "feature.txt")
            git(repo, "commit", "-m", "feature")
            git(repo, "push", "-u", "origin", "feature")

            self.assertNotEqual(git(repo, "rev-parse", "--abbrev-ref", "@{upstream}"), "origin/main")
            self.assertEqual(collector.detect_base_branch(repo), "main")

    def test_remote_slash_branch_is_resolved_through_origin(self) -> None:
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
            git(repo, "push", "origin", "main:release/1.0")

            self.assertEqual(collector.resolve_diff_ref(repo, "release/1.0"), "origin/release/1.0")

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

    def test_redacts_json_and_environment_secret_assignments(self) -> None:
        source = '\n'.join([
            '"password": "json secret",',
            '"api_key": "json api secret",',
            'GITHUB_TOKEN=environment-secret',
            'SERVICE_PRIVATE_KEY: yaml-secret',
            'monkey=banana',
        ])

        redacted = collector.redact_secret_text(source)

        self.assertNotIn("json secret", redacted)
        self.assertNotIn("json api secret", redacted)
        self.assertNotIn("environment-secret", redacted)
        self.assertNotIn("yaml-secret", redacted)
        self.assertEqual(redacted.count("<redacted>"), 4)
        self.assertIn("monkey=banana", redacted)

    def test_redacts_secret_file_diffs_and_private_key_blocks(self) -> None:
        source = "".join([
            "diff --git a/.npmrc b/.npmrc\n",
            "--- a/.npmrc\n",
            "+++ b/.npmrc\n",
            "@@ -0,0 +1 @@\n",
            "+opaque credential content\n",
            "diff --git a/config.txt b/config.txt\n",
            "--- a/config.txt\n",
            "+++ b/config.txt\n",
            "@@ -0,0 +1,3 @@\n",
            "+-----BEGIN PRIVATE KEY-----\n",
            "+private material\n",
            "+-----END PRIVATE KEY-----\n",
        ])

        redacted = collector.redact_diff_text(source)

        self.assertIn("[diff content redacted: secret-like path]", redacted)
        self.assertNotIn("opaque credential content", redacted)
        self.assertIn("<redacted-private-key>", redacted)
        self.assertNotIn("private material", redacted)

    def test_base_mode_omits_untracked_file_contents(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            git(repo, "init", "-b", "main")
            git(repo, "config", "user.email", "test@example.test")
            git(repo, "config", "user.name", "Test")
            (repo / "tracked.txt").write_text("tracked\n", encoding="utf-8")
            git(repo, "add", "tracked.txt")
            git(repo, "commit", "-m", "base")
            (repo / "private-notes.txt").write_text("unrelated private content\n", encoding="utf-8")

            entries = collector.git_status_entries(repo)
            state = collector.collect_worktree_state(
                repo,
                1_000_000,
                entries,
                include_untracked_previews=False,
                include_staged_diff=False,
            )

            self.assertEqual(state["untracked_files"], ["private-notes.txt"])
            self.assertEqual(state["untracked_file_previews"], [])
            self.assertEqual(state["staged_diff"]["text"], "")

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
