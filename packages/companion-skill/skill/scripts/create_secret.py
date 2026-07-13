#!/usr/bin/env python3
"""Create a write-only Companion secret without placing its value in argv or output."""

from __future__ import annotations

import argparse
import getpass
import json
import re
import sys
import urllib.parse

from companion_lib import api_get, api_post_json, api_put_json, fail, resolve_credentials

ENV_KEY_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def main() -> None:
    parser = argparse.ArgumentParser(description="Create a write-only personal or shared Companion secret")
    parser.add_argument("--name", required=True, help="human-readable secret name")
    parser.add_argument("--key", required=True, help="environment variable key")
    parser.add_argument("--audience", choices=["personal", "restricted", "organization"], default="personal")
    parser.add_argument("--recipient", action="append", default=[], help="recipient user id (repeat for restricted access)")
    parser.add_argument("--skill", help="create the secret and bind it to this skill's matching --key slot")
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

    skill_slug = args.skill.strip() if args.skill else None
    if args.skill is not None and not skill_slug:
        fail("--skill cannot be empty")

    api_url, token, _workspace_id = resolve_credentials()
    slot_id = None
    if skill_slug:
        encoded_slug = urllib.parse.quote(skill_slug, safe="")
        configuration = api_get(api_url, token, f"/skills/{encoded_slug}/secret-configuration")
        slots = configuration.get("slots", []) if isinstance(configuration, dict) else []
        matching_slots = [slot for slot in slots if isinstance(slot, dict) and slot.get("env_key") == args.key]
        if len(matching_slots) != 1 or not matching_slots[0].get("slot_id"):
            fail(f"skill {skill_slug} does not declare exactly one secret slot for {args.key}")
        slot_id = str(matching_slots[0]["slot_id"])

    value = sys.stdin.read() if args.value_stdin else getpass.getpass("Secret value (never echoed): ")
    if not value:
        fail("secret value cannot be empty")

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
    binding = None
    if skill_slug and slot_id:
        secret_id = row.get("id") if isinstance(row, dict) else None
        if not secret_id:
            fail("secret was created but the response did not include its id; binding was not attempted")
        encoded_slug = urllib.parse.quote(skill_slug, safe="")
        api_put_json(
            api_url,
            token,
            f"/skills/{encoded_slug}/secret-bindings/{urllib.parse.quote(slot_id, safe='')}",
            {"secret_id": secret_id},
        )
        binding = {"skill": skill_slug, "slot_id": slot_id, "env_key": args.key}

    if args.json:
        print(json.dumps({"secret": row, "binding": binding} if binding else row, sort_keys=True))
    else:
        message = f"Created {row.get('name', args.name)} ({row.get('key', args.key)}) as {row.get('audience', args.audience)}. Value is write-only."
        if binding:
            message += f" Bound to {skill_slug}:{args.key}."
        print(message)


if __name__ == "__main__":
    main()
