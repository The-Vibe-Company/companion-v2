from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).with_name("parse_review_findings.py")
SPEC = importlib.util.spec_from_file_location("parse_review_findings", MODULE_PATH)
assert SPEC and SPEC.loader
parser = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(parser)


class ParseReviewFindingsTests(unittest.TestCase):
    def test_requires_file_and_line_citation(self) -> None:
        with self.assertRaisesRegex(ValueError, "file:line"):
            parser.parse("**[P1] src/auth.ts - Missing guard**\nImpact.")

    def test_parses_cited_finding(self) -> None:
        issues = parser.parse("**[P1] src/auth.ts:42 - Missing guard**\nImpact.")
        self.assertEqual(issues[0]["file"], "src/auth.ts")
        self.assertEqual(issues[0]["line"], 42)


if __name__ == "__main__":
    unittest.main()
