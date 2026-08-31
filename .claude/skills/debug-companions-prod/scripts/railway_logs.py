#!/usr/bin/env python3
"""Fetch and filter Railway deployment logs for one Companion service.

Parses each log line as the runtime's JSON process-log shape
(packages/companion-runtime/src/logging.ts): top-level ``level``, ``ts``,
``event`` plus flat camelCase fields such as ``companionId``, ``turnId``,
``workId``, ``boxId``, and nested ``persisted { code, message, action }`` /
``thrown { name, message, stableCode }``.

Default output prints a whitelist of diagnostic keys; ``--raw`` passes the full
line through redaction. Non-JSON lines are redacted and shown (subject to
``--grep``) unless a structured filter is active.

The Railway ``deploymentLogs`` GraphQL shape is UNVERIFIED — see
references/railway-api.md.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import prodlib  # noqa: E402
import railway_status  # noqa: E402

# UNVERIFIED schema: needs one live probe with a real token. See
# references/railway-api.md.
LOGS_QUERY = """
query CompanionDebugLogs($deploymentId: String!, $limit: Int!) {
  deploymentLogs(deploymentId: $deploymentId, limit: $limit) {
    timestamp
    severity
    message
    attributes { key value }
  }
}
"""

# Whitelisted top-level keys of a runtime log record, in display order. From
# RuntimeLogRecord and workFailureLogRecord in companion-runtime/src/logging.ts.
DEFAULT_KEYS = (
    "level",
    "event",
    "code",
    "action",
    "outcome",
    "reason",
    "status",
    "companionId",
    "turnId",
    "attemptId",
    "workKind",
    "workId",
    "operationKind",
    "claimedCheckpoint",
    "liveCheckpoint",
    "checkpoint",
    "boxId",
    "boxState",
    "piState",
    "recovered",
    "message",
)

STRUCTURED_FILTER_ARGS = ("event", "companion", "turn", "attempt")


def parse_log_line(message: str) -> dict | None:
    """Parse one log message as a runtime JSON record, or None."""
    message = message.strip()
    if not message.startswith("{"):
        return None
    try:
        record = json.loads(message)
    except ValueError:
        return None
    if not isinstance(record, dict) or "event" not in record:
        return None
    return record


def record_from_attributes(attributes: object) -> dict | None:
    """Rebuild a runtime record from Railway's structured attribute set.

    The runtime ships JSON logs whose payload Railway splits into ``attributes``
    and leaves ``message`` empty. Without this, every structured line renders as
    a blank string and the tool silently reports "N matching lines" of nothing.
    """
    if not isinstance(attributes, dict) or "event" not in attributes:
        return None
    return dict(attributes)


def rendered_is_blank(line: object) -> bool:
    """True when a matched entry carries no readable content, in either output mode.

    ``--json`` emits dicts, the default path emits strings, so the emptiness check has
    to understand both or the guard below silently skips JSON callers.
    """
    if isinstance(line, str):
        return not line.strip()
    if isinstance(line, dict):
        if set(line) - {"timestamp"} == {"raw"}:
            raw = line.get("raw")
            return isinstance(raw, str) and not raw.strip()
        return False
    return False


def matches_filters(record: dict, args: argparse.Namespace) -> bool:
    if args.event and not str(record.get("event", "")).startswith(args.event):
        return False
    if args.companion and record.get("companionId") != args.companion:
        return False
    if args.turn and record.get("turnId") != args.turn:
        return False
    if args.attempt and record.get("attemptId") != args.attempt and record.get("workId") != args.attempt:
        return False
    return True


def format_record(record: dict) -> str:
    """Whitelisted key=value line for one structured runtime record."""
    parts = [str(record.get("ts", ""))]
    for key in DEFAULT_KEYS:
        value = record.get(key)
        if value is None:
            continue
        parts.append(f"{key}={value}")
    persisted = record.get("persisted")
    if isinstance(persisted, dict):
        for key in ("code", "message", "action"):
            value = persisted.get(key)
            if value is not None:
                parts.append(f"persisted.{key}={value}")
    thrown = record.get("thrown")
    if isinstance(thrown, dict):
        for key in ("stableCode", "name", "message"):
            value = thrown.get(key)
            if value is not None:
                parts.append(f"thrown.{key}={value}")
    return " ".join(parts)


def has_structured_filter(args: argparse.Namespace) -> bool:
    return any(getattr(args, name) for name in STRUCTURED_FILTER_ARGS)


def redact_json_value(value):
    """Redact every string inside a JSON-compatible value without breaking JSON."""
    if isinstance(value, str):
        return prodlib.redact(value)
    if isinstance(value, list):
        return [redact_json_value(entry) for entry in value]
    if isinstance(value, dict):
        return {key: redact_json_value(entry) for key, entry in value.items()}
    return value


def resolve_latest_deployment(env: dict, service: str, http=prodlib.http_json) -> str:
    variables = {
        "projectId": prodlib.require(env, "RAILWAY_PROJECT_ID"),
        "environmentId": prodlib.require(env, "RAILWAY_ENVIRONMENT_ID"),
        "first": 1,
    }
    data = railway_status.railway_graphql(env, railway_status.STATUS_QUERY, variables, http=http)
    rows = railway_status.extract_service_rows(data, time.time())
    for row in rows:
        if row["service"] == service:
            if not row["deployments"]:
                raise prodlib.ProdToolError(
                    f"service {service} has no deployment in this environment",
                )
            return row["deployments"][0]["id"]
    raise prodlib.ProdToolError(f"service {service} not found in the Railway project")


def fetch_deployment_logs(env: dict, deployment_id: str, limit: int, http=prodlib.http_json) -> list[dict]:
    data = railway_status.railway_graphql(
        env, LOGS_QUERY, {"deploymentId": deployment_id, "limit": limit}, http=http,
    )
    entries = data.get("deploymentLogs")
    if not isinstance(entries, list):
        raise railway_status.schema_error("data.deploymentLogs")
    rows = []
    for entry in entries:
        if not isinstance(entry, dict):
            raise railway_status.schema_error("deploymentLogs[]")
        attributes: dict[str, object] = {}
        raw_attributes = entry.get("attributes")
        if isinstance(raw_attributes, list):
            for attribute in raw_attributes:
                if not isinstance(attribute, dict) or "key" not in attribute:
                    continue
                value = attribute.get("value")
                if isinstance(value, str):
                    try:
                        value = json.loads(value)
                    except ValueError:
                        pass
                attributes[str(attribute["key"])] = value
        rows.append({
            "timestamp": str(entry.get("timestamp", "")),
            "severity": str(entry.get("severity", "")),
            "message": str(entry.get("message", "")),
            "attributes": attributes,
        })
    return rows


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Fetch redacted Railway logs for one Companion service (read-only)",
    )
    parser.add_argument("--service", required=True, choices=railway_status.SERVICES)
    parser.add_argument("--deployment", help="deployment id (default: latest in the environment)")
    parser.add_argument("--since", default="30m", help="lookback window, e.g. 30m, 6h, 2d")
    parser.add_argument("--limit", type=int, default=2000, help="maximum log entries to fetch")
    parser.add_argument("--event", help="keep runtime records whose event starts with this prefix")
    parser.add_argument("--companion", help="keep records for this companion uuid")
    parser.add_argument("--turn", help="keep records for this turn uuid")
    parser.add_argument("--attempt", help="keep records for this attempt uuid")
    parser.add_argument("--grep", help="regular expression applied to the redacted line")
    parser.add_argument("--raw", action="store_true", help="print full redacted lines")
    parser.add_argument("--json", action="store_true", help="print matching records as JSON")
    args = parser.parse_args()

    for name in ("companion", "turn", "attempt"):
        value = getattr(args, name)
        if value and not prodlib.UUID_RE.match(value):
            prodlib.fail(f"--{name} must be a uuid")
    try:
        since_seconds = prodlib.parse_since(args.since)
        grep = re.compile(args.grep) if args.grep else None
    except re.error as error:
        prodlib.fail(f"invalid --grep pattern: {error}")
        return
    except prodlib.ProdToolError as error:
        prodlib.fail(str(error))
        return
    if args.limit < 1:
        prodlib.fail("--limit must be positive")

    env = prodlib.load_env()
    cutoff = time.time() - since_seconds
    try:
        deployment_id = args.deployment or resolve_latest_deployment(env, args.service)
        entries = fetch_deployment_logs(env, deployment_id, args.limit)
    except prodlib.ProdToolError as error:
        prodlib.fail(str(error), code=1)
        return

    structured_only = has_structured_filter(args)
    matched: list[object] = []
    for entry in entries:
        entry_at = prodlib.parse_iso_timestamp(entry["timestamp"])
        if entry_at and entry_at < cutoff:
            continue
        record = parse_log_line(entry["message"])
        from_attributes = False
        if record is None:
            record = record_from_attributes(entry.get("attributes"))
            from_attributes = record is not None
        if record is None:
            if structured_only:
                continue
            line = prodlib.redact(entry["message"].rstrip())
            if grep and not grep.search(line):
                continue
            matched.append(line if not args.json else {"raw": line, "timestamp": entry["timestamp"]})
            continue
        if not matches_filters(record, args):
            continue
        if args.raw:
            rendered = json.dumps(record) if from_attributes else entry["message"].rstrip()
        else:
            rendered = format_record(record)
        line = prodlib.redact(rendered)
        if grep and not grep.search(line):
            continue
        matched.append(line if not args.json else redact_json_value(record))

    if entries and matched and all(rendered_is_blank(line) for line in matched):
        print(
            f"-- WARNING: all {len(matched)} matching entries rendered empty (no message and "
            "no attributes). Do NOT read this as 'no matching logs': either the service was "
            "idle, or the deploymentLogs schema drifted and needs re-probing "
            "(references/railway-api.md).",
            file=sys.stderr,
        )
    if args.json:
        prodlib.print_json(matched)
        return
    for line in matched:
        print(line)
    print(
        prodlib.redact(
            f"-- {len(matched)} matching lines from deployment {deployment_id} "
            f"({args.service}, since {args.since})",
        ),
        file=sys.stderr,
    )


if __name__ == "__main__":
    main()
