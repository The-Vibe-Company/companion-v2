#!/usr/bin/env python3
"""Create a write-only Companion secret without placing its value in argv or output."""

from __future__ import annotations

import argparse
import getpass
import json
import re
import sys

from companion_lib import api_post_json, fail, resolve_credentials

ENV_KEY_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def main() -> None:
    parser = argparse.ArgumentParser(description="Create a write-only personal or shared Companion secret")
    parser.add_argument("--name", required=True, help="human-readable secret name")
    parser.add_argument("--key", required=True, help="environment variable key")
    parser.add_argument("--audience", choices=["personal", "restricted", "organization"], default="personal")
    parser.add_argument("--recipient", action="append", default=[], help="recipient user id (repeat for restricted access)")
    parser.add_argument("--value-stdin", action="store_true", help="read the exact value from stdin instead of a private prompt")
    parser.add_argument("--json", action="store_true", help="print value-free JSON metadata")
    args = parser.parse_args()

    if not ENV_KEY_RE.fullmatch(args.key):
        fail("--key must use environment-variable syntax")
    recipients = list(dict.fromkeys(str(value) for value in args.recipient if value))
    if args.audience == "restricted" and not recipients:
        fail("restricted secrets require at least one --recipient user id")
    if args.audience != "restricted" and recipients:
        fail("--recipient is valid only with --audience restricted")

    value = sys.stdin.read() if args.value_stdin else getpass.getpass("Secret value (never echoed): ")
    if not value:
        fail("secret value cannot be empty")

    api_url, token, _workspace_id = resolve_credentials()
    row = api_post_json(
        api_url,
        token,
        "/secrets",
        {
            "name": args.name,
            "key": args.key,
            "value": value,
            "audience": args.audience,
            "recipient_ids": recipients,
        },
    )
    # Discard the only plaintext reference before formatting output. The API response is metadata-only.
    value = ""
    if args.json:
        print(json.dumps(row, sort_keys=True))
    else:
        print(f"Created {row.get('name', args.name)} ({row.get('key', args.key)}) as {row.get('audience', args.audience)}. Value is write-only.")


if __name__ == "__main__":
    main()
