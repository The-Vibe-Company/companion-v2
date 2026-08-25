#!/usr/bin/env python3
"""Tests for railway_status / railway_logs / railway_restart request construction
and the restart double-gate. No network access anywhere."""

from __future__ import annotations

import argparse
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import prodlib  # noqa: E402
import railway_logs  # noqa: E402
import railway_restart  # noqa: E402
import railway_status  # noqa: E402

ENV = {
    "RAILWAY_API_TOKEN": "railway_test_token_value",
    "RAILWAY_PROJECT_ID": "proj-1",
    "RAILWAY_ENVIRONMENT_ID": "env-1",
}


def status_payload(commits=("abc123def4567", "abc123def4567")) -> dict:
    services = []
    for index, commit in enumerate(commits):
        services.append({
            "node": {
                "id": f"svc-{index}",
                "name": ["api", "runtime", "worker", "web"][index % 4],
                "deployments": {
                    "edges": [
                        {
                            "node": {
                                "id": f"dep-{index}",
                                "status": "SUCCESS",
                                "createdAt": "2026-08-25T00:00:00Z",
                                "meta": {"commitHash": commit},
                            },
                        },
                    ],
                },
            },
        })
    return {"data": {"project": {"name": "companion", "services": {"edges": services}}}}


class GraphqlRequestTest(unittest.TestCase):
    def test_bearer_request_body_and_headers(self):
        url, headers, body = railway_status.build_graphql_request(
            ENV, railway_status.STATUS_QUERY, {"projectId": "proj-1"}, "bearer",
        )
        self.assertEqual(url, railway_status.RAILWAY_GRAPHQL_URL)
        self.assertEqual(headers, {"Authorization": "Bearer railway_test_token_value"})
        self.assertEqual(body["variables"], {"projectId": "proj-1"})
        self.assertIn("deployments(first: $first", body["query"])
        # The token must never leak into the URL or query text.
        self.assertNotIn("railway_test_token_value", url + body["query"])

    def test_project_token_fallback_header(self):
        _url, headers, _body = railway_status.build_graphql_request(
            ENV, railway_status.STATUS_QUERY, {}, "project",
        )
        self.assertEqual(headers, {"Project-Access-Token": "railway_test_token_value"})

    def test_auth_fallback_after_401(self):
        seen_headers = []

        def http(method, url, headers=None, body=None, **kwargs):
            seen_headers.append(dict(headers))
            if "Authorization" in headers:
                return 401, {"errors": [{"message": "Not Authorized"}]}
            return 200, status_payload()

        data = railway_status.railway_graphql(ENV, railway_status.STATUS_QUERY, {}, http=http)
        self.assertIn("project", data)
        self.assertEqual(len(seen_headers), 2)
        self.assertIn("Project-Access-Token", seen_headers[1])

    def test_schema_mismatch_is_actionable(self):
        def http(method, url, headers=None, body=None, **kwargs):
            return 200, {"data": {"project": {"services": "not-a-connection"}}}

        data = railway_status.railway_graphql(ENV, railway_status.STATUS_QUERY, {}, http=http)
        with self.assertRaises(prodlib.ProdToolError) as ctx:
            railway_status.extract_service_rows(data, now=0.0)
        message = str(ctx.exception)
        self.assertIn("UNVERIFIED", message)
        self.assertIn("railway-api.md", message)

    def test_extract_rows_and_commit_divergence(self):
        data = railway_status.railway_graphql(
            ENV,
            railway_status.STATUS_QUERY,
            {},
            http=lambda *a, **k: (200, status_payload(("aaaa1111bbbb2", "cccc3333dddd4"))),
        )
        rows = railway_status.extract_service_rows(data, now=0.0)
        self.assertEqual([row["service"] for row in rows], ["api", "runtime"])
        self.assertEqual(rows[0]["deployments"][0]["commit"], "aaaa1111bbbb")
        self.assertEqual(len(railway_status.divergent_commits(rows)), 2)

    def test_commit_from_meta_variants(self):
        self.assertEqual(railway_status.commit_from_meta({"commitHash": "abcdef0123456789"}), "abcdef012345")
        self.assertEqual(railway_status.commit_from_meta('{"commitSha": "abcdef0123456789"}'), "abcdef012345")
        self.assertEqual(railway_status.commit_from_meta(None), "-")
        self.assertEqual(railway_status.commit_from_meta({"other": True}), "-")


class LogParsingTest(unittest.TestCase):
    def test_whitelist_formatting(self):
        record = {
            "ts": "2026-08-25T10:00:00.000Z",
            "level": "error",
            "event": "turn_attempt_failed",
            "companionId": "c-1",
            "turnId": "t-1",
            "boxId": "bx_abcdefgh",
            "persisted": {"code": "turn_stalled", "message": "stopped", "action": "retry"},
            "secretField": "should-not-appear",
        }
        line = railway_logs.format_record(record)
        self.assertIn("event=turn_attempt_failed", line)
        self.assertIn("companionId=c-1", line)
        self.assertIn("persisted.code=turn_stalled", line)
        self.assertNotIn("should-not-appear", line)

    def test_parse_log_line(self):
        self.assertIsNone(railway_logs.parse_log_line("plain text line"))
        self.assertIsNone(railway_logs.parse_log_line('{"no_event": true}'))
        record = railway_logs.parse_log_line('{"event": "claimed", "ts": "x"}')
        self.assertEqual(record["event"], "claimed")

    def test_filters(self):
        args = argparse.Namespace(event="turn_", companion="c-1", turn=None, attempt=None)
        self.assertTrue(railway_logs.matches_filters(
            {"event": "turn_attempt_failed", "companionId": "c-1"}, args,
        ))
        self.assertFalse(railway_logs.matches_filters(
            {"event": "claim_denied", "companionId": "c-1"}, args,
        ))
        self.assertFalse(railway_logs.matches_filters(
            {"event": "turn_attempt_failed", "companionId": "c-2"}, args,
        ))


class RestartDoubleGateTest(unittest.TestCase):
    def test_refusal_matrix(self):
        cases = [
            # (service, flag, env_value, expected_allowed)
            ("runtime", False, "", False),
            ("runtime", True, "", False),
            ("runtime", False, "1", False),
            ("runtime", True, "0", False),
            ("runtime", True, "true", False),
            ("release", True, "1", False),
            ("runtime", True, "1", True),
            ("api", True, "1", True),
        ]
        for service, flag, env_value, expected in cases:
            allowed, reason = railway_restart.check_restart_allowed(service, flag, env_value)
            self.assertEqual(
                allowed, expected,
                f"service={service} flag={flag} env={env_value!r}: {reason}",
            )
            if not expected:
                self.assertTrue(reason)

    def test_release_is_refused_even_fully_gated(self):
        allowed, reason = railway_restart.check_restart_allowed("release", True, "1")
        self.assertFalse(allowed)
        self.assertIn("release", reason)

    def test_refused_run_makes_no_http_call(self):
        def http(*args, **kwargs):
            raise AssertionError("a refused restart must not perform any HTTP call")

        args = argparse.Namespace(service="runtime", i_know_this_restarts_prod=True)
        env = dict(ENV)  # DEBUG_PROD_ALLOW_RESTART absent
        code = railway_restart.run(args, env, http=http)
        self.assertEqual(code, 2)

    def test_gated_run_restarts_latest_deployment(self):
        calls = []

        def http(method, url, headers=None, body=None, **kwargs):
            calls.append(body["query"])
            if "CompanionDebugStatus" in body["query"]:
                return 200, status_payload()
            self.assertIn("deploymentRestart", body["query"])
            self.assertEqual(body["variables"], {"deploymentId": "dep-0"})
            return 200, {"data": {"deploymentRestart": True}}

        args = argparse.Namespace(service="api", i_know_this_restarts_prod=True)
        env = {**ENV, "DEBUG_PROD_ALLOW_RESTART": "1"}
        code = railway_restart.run(args, env, http=http)
        self.assertEqual(code, 0)
        self.assertEqual(len(calls), 2)


if __name__ == "__main__":
    unittest.main()
