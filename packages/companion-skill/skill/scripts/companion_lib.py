#!/usr/bin/env python3
"""Shared helpers for the local Companion skill scripts.

This module is imported by ``bootstrap.py``, ``check_updates.py``, and ``skill_guard.py``. It
holds credential resolution, the workspace API client, semver comparison, and
lockfile parsing. It NEVER prints or persists the Companion token.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from contextlib import contextmanager
from datetime import datetime, timezone
from functools import cmp_to_key
from pathlib import Path
from typing import Any, Iterator


class TokenRefreshUnavailable(Exception):
    """The supplied PAT is not eligible for automatic refresh."""


AGENT_CREDENTIAL_PREFIX = "companion_agent:"
MAX_SECRET_REDEMPTION_BYTES = 16 * 1024 * 1024


def fail(message: str) -> None:
    raise SystemExit(f"error: {message}")


def load_json(path: Path) -> dict[str, Any] | None:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None
    except json.JSONDecodeError as exc:
        fail(f"{path} is not valid JSON: {exc}")


def _is_agent_credential(token: str) -> bool:
    return token.startswith(AGENT_CREDENTIAL_PREFIX)


def _agent_workspace_id(token: str) -> str:
    if not _is_agent_credential(token) or not token.removeprefix(AGENT_CREDENTIAL_PREFIX):
        fail("invalid local Agent Auth credential reference")
    return token.removeprefix(AGENT_CREDENTIAL_PREFIX)


def _agent_client_path() -> Path:
    override = os.environ.get("COMPANION_AGENT_CLIENT")
    if override:
        return Path(override).expanduser().resolve()
    return Path(__file__).resolve().parent / "companion-agent-client.mjs"


def _agent_request(token: str, payload: dict[str, Any]) -> Any:
    """Run the bundled Agent Auth client over JSON stdin/stdout; no credential enters argv."""
    client = _agent_client_path()
    if not client.is_file():
        fail(f"Agent Auth client is missing at {client}; reinstall or update the Companion skill")
    node = shutil.which(os.environ.get("COMPANION_NODE", "node"))
    if not node:
        fail("Node.js 20 or newer is required for Companion Agent Auth")
    request = {**payload, "workspaceId": _agent_workspace_id(token)}
    completed = subprocess.run(
        [node, str(client)],
        input=json.dumps(request),
        text=True,
        stdout=subprocess.PIPE,
        check=False,
    )
    try:
        result = json.loads(completed.stdout)
    except json.JSONDecodeError:
        fail("the Companion Agent Auth client returned an invalid response")
    if completed.returncode != 0 or not isinstance(result, dict) or result.get("ok") is False:
        message = result.get("error") if isinstance(result, dict) else None
        fail(str(message or "the Companion Agent Auth request failed"))
    return result.get("data")


def _agent_secret_redeem(token: str, plan_id: str) -> dict[str, Any]:
    """Redeem one plan through an inherited pipe so plaintext never reaches stdout or argv."""
    if os.name != "posix":  # pragma: no cover - the bundled local workflow currently targets macOS/Linux
        fail("Agent Auth secret redemption requires a POSIX private pipe")
    if not plan_id or "/" in plan_id or "\\" in plan_id:
        fail("invalid secret retrieval plan id")

    client = _agent_client_path()
    if not client.is_file():
        fail(f"Agent Auth client is missing at {client}; reinstall or update the Companion skill")
    node = shutil.which(os.environ.get("COMPANION_NODE", "node"))
    if not node:
        fail("Node.js 20 or newer is required for Companion Agent Auth")

    read_fd, write_fd = os.pipe()
    secret_bytes = bytearray()
    reader_errors: list[BaseException] = []
    too_large = threading.Event()

    def read_private_pipe() -> None:
        try:
            with os.fdopen(read_fd, "rb", closefd=True) as stream:
                while True:
                    chunk = stream.read(64 * 1024)
                    if not chunk:
                        break
                    if len(secret_bytes) + len(chunk) <= MAX_SECRET_REDEMPTION_BYTES:
                        secret_bytes.extend(chunk)
                    else:
                        too_large.set()
        except BaseException as exc:  # pragma: no cover - defensive transport failure
            reader_errors.append(exc)

    request = {
        "action": "secret-redeem",
        "workspaceId": _agent_workspace_id(token),
        "planId": plan_id,
        "outputFd": write_fd,
    }
    try:
        process = subprocess.Popen(
            [node, str(client)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            text=True,
            close_fds=True,
            pass_fds=(write_fd,),
        )
    except BaseException:
        os.close(read_fd)
        os.close(write_fd)
        raise

    # Only the child retains the write side. Reading concurrently prevents a large redemption from
    # filling the kernel pipe buffer while the parent waits for the value-free stdout envelope.
    os.close(write_fd)
    reader = threading.Thread(target=read_private_pipe, name="companion-secret-pipe", daemon=True)
    reader.start()
    try:
        stdout, _ = process.communicate(json.dumps(request))
    except BaseException:
        process.kill()
        process.wait()
        reader.join()
        raise
    reader.join()

    try:
        result = json.loads(stdout)
    except json.JSONDecodeError:
        fail("the Companion Agent Auth client returned an invalid response")
    if process.returncode != 0 or not isinstance(result, dict) or result.get("ok") is False:
        message = result.get("error") if isinstance(result, dict) else None
        fail(str(message or "the Companion Agent Auth secret request failed"))
    if reader_errors:
        fail("the Companion Agent Auth private secret pipe failed")
    if too_large.is_set():
        fail("the Companion Agent Auth secret response exceeded the safe size limit")
    try:
        redeemed = json.loads(secret_bytes.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        fail("the Companion Agent Auth private secret response was invalid")
    if not isinstance(redeemed, dict):
        fail("the Companion Agent Auth private secret response was invalid")
    return redeemed


def api_get(base: str, token: str, path: str) -> Any:
    if _is_agent_credential(token):
        return _agent_request(token, {"action": "api", "method": "GET", "path": path})
    url = f"{base.rstrip('/')}{path}"
    request = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        fail(f"GET {url} failed with HTTP {exc.code}: {body}")
    except urllib.error.URLError as exc:
        fail(f"GET {url} failed: {exc.reason}")


def api_download_bytes(base: str, token: str, path: str) -> bytes:
    """Download a binary payload (e.g. a skill package zip) from the workspace API."""
    if _is_agent_credential(token):
        with tempfile.TemporaryDirectory(prefix="companion-agent-download-") as directory:
            destination = Path(directory) / "package.bin"
            _agent_request(
                token,
                {"action": "download", "path": path, "outputPath": str(destination)},
            )
            return destination.read_bytes()
    url = f"{base.rstrip('/')}{path}"
    request = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            return response.read()
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        fail(f"GET {url} failed with HTTP {exc.code}: {body}")
    except urllib.error.URLError as exc:
        fail(f"GET {url} failed: {exc.reason}")


def api_post_json(base: str, token: str, path: str, payload: dict[str, Any] | None = None) -> Any:
    """POST JSON to Companion without ever including the bearer token in errors or persisted state."""
    if _is_agent_credential(token):
        if path == "/secret-grants/redeem" or (
            path.startswith("/secret-retrievals/") and path.endswith("/grant")
        ):
            fail("secret grants and redeemed values require the private Agent Auth pipe")
        return _agent_request(
            token,
            {"action": "api", "method": "POST", "path": path, "body": payload or {}},
        )
    url = f"{base.rstrip('/')}{path}"
    body = json.dumps(payload or {}).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        response_body = exc.read().decode("utf-8", errors="replace")
        fail(f"POST {url} failed with HTTP {exc.code}: {response_body}")
    except urllib.error.URLError as exc:
        fail(f"POST {url} failed: {exc.reason}")


def api_redeem_secret_plan(base: str, token: str, plan_id: str) -> dict[str, Any]:
    """Redeem a plan without exposing plaintext through the Agent Auth JSON transport."""
    if _is_agent_credential(token):
        return _agent_secret_redeem(token, plan_id)
    grant = api_post_json(base, token, f"/secret-retrievals/{plan_id}/grant", {})
    raw_grant = grant.get("grant") if isinstance(grant, dict) else None
    if not isinstance(raw_grant, str):
        fail("Companion did not return a retrieval grant")
    return api_post_json(base, token, "/secret-grants/redeem", {"grant": raw_grant})


def api_put_json(base: str, token: str, path: str, payload: dict[str, Any] | None = None) -> Any:
    """PUT JSON to Companion without ever including the bearer token in errors or persisted state."""
    if _is_agent_credential(token):
        return _agent_request(
            token,
            {"action": "api", "method": "PUT", "path": path, "body": payload or {}},
        )
    url = f"{base.rstrip('/')}{path}"
    body = json.dumps(payload or {}).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=body,
        method="PUT",
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        response_body = exc.read().decode("utf-8", errors="replace")
        fail(f"PUT {url} failed with HTTP {exc.code}: {response_body}")
    except urllib.error.URLError as exc:
        fail(f"PUT {url} failed: {exc.reason}")


def api_refresh_token(base: str, token: str) -> dict[str, Any]:
    """Check or refresh one PAT without exposing it in failures."""
    if _is_agent_credential(token):
        raise TokenRefreshUnavailable("Agent Auth credentials use grants, not PAT refresh")
    url = f"{base.rstrip('/')}/tokens/refresh"
    request = urllib.request.Request(
        url,
        data=b"{}",
        method="POST",
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        # Every ineligible credential deliberately receives the same response. Do not include its
        # body because future server diagnostics must never risk echoing credential material.
        if exc.code == 401:
            raise TokenRefreshUnavailable("Companion credentials need to be refreshed from a new Use prompt") from None
        fail(f"POST {url} failed with HTTP {exc.code}")
    except urllib.error.URLError as exc:
        fail(f"POST {url} failed: {exc.reason}")

    if not isinstance(payload, dict) or payload.get("status") not in {"current", "rotated"}:
        fail(f"POST {url} returned an unexpected response")
    if payload["status"] == "rotated" and not isinstance(payload.get("token"), str):
        fail(f"POST {url} returned a rotated response without a token")
    return payload


def companion_home() -> Path:
    """Return ~/.companion, honoring COMPANION_HOME for tests and overrides."""
    override = os.environ.get("COMPANION_HOME")
    if override:
        return Path(override)
    return Path.home() / ".companion"


def _legacy_mode_enabled() -> bool:
    return os.environ.get("COMPANION_AUTH_MODE", "").strip().lower() == "legacy-pat"


def resolve_credentials_with_source() -> tuple[str, str, str | None, str]:
    api_url = os.environ.get("COMPANION_API_URL")
    token = os.environ.get("COMPANION_TOKEN")
    workspace_id = os.environ.get("COMPANION_WORKSPACE_ID")
    if api_url and token:
        if not _legacy_mode_enabled():
            fail(
                "COMPANION_TOKEN is a legacy PAT; set COMPANION_AUTH_MODE=legacy-pat to use it "
                "explicitly, or connect this workspace with Agent Auth"
            )
        return api_url, token, workspace_id, "environment"

    credentials_path = companion_home() / "credentials.json"
    credentials = load_json(credentials_path)
    if not credentials:
        fail("missing Companion credentials; set COMPANION_API_URL and COMPANION_TOKEN or refresh ~/.companion/credentials.json")

    if credentials.get("schemaVersion") == 3 and isinstance(credentials.get("workspaces"), dict):
        active = credentials.get("activeWorkspaceId")
        if not active:
            fail("credentials.json has no activeWorkspaceId")
        entry = credentials["workspaces"].get(active)
        if not isinstance(entry, dict):
            fail(f"credentials.json has no workspace entry for {active}")
        api_url = entry.get("apiUrl")
        legacy_pat = entry.get("legacyPat")
        if _legacy_mode_enabled():
            if api_url and isinstance(legacy_pat, dict) and legacy_pat.get("token"):
                return str(api_url), str(legacy_pat["token"]), str(active), "credentials_file"
            fail(f"explicit legacy-pat mode was selected, but credentials entry {active} has no preserved PAT")
        agent_auth = entry.get("agentAuth")
        if api_url and isinstance(agent_auth, dict) and agent_auth.get("issuer") and agent_auth.get("agentId"):
            return str(api_url), f"{AGENT_CREDENTIAL_PREFIX}{active}", str(active), "agent_auth"
        if isinstance(legacy_pat, dict) and legacy_pat.get("token"):
            fail(
                f"credentials entry {active} has only a legacy PAT; connect Agent Auth or set "
                "COMPANION_AUTH_MODE=legacy-pat explicitly"
            )
        fail(f"credentials entry {active} is not connected with Agent Auth")

    if credentials.get("schemaVersion") == 2 and isinstance(credentials.get("workspaces"), dict):
        active = credentials.get("activeWorkspaceId")
        if not active:
            fail("credentials.json has no activeWorkspaceId")
        entry = credentials["workspaces"].get(active)
        if not isinstance(entry, dict):
            fail(f"credentials.json has no workspace entry for {active}")
        api_url = entry.get("apiUrl")
        token = entry.get("token")
        if not _legacy_mode_enabled():
            fail(
                "credentials.json schema v2 contains a legacy PAT; run the Agent Auth connect flow "
                "to migrate to schema v3, or set COMPANION_AUTH_MODE=legacy-pat explicitly"
            )
        if not api_url or not token:
            fail(f"credentials entry {active} is missing apiUrl or token")
        return str(api_url), str(token), str(active), "credentials_file"

    api_url = credentials.get("apiUrl")
    token = credentials.get("token")
    if api_url and token:
        if not _legacy_mode_enabled():
            fail(
                "legacy flat Companion credentials require COMPANION_AUTH_MODE=legacy-pat; "
                "connect Agent Auth to create schema v3 credentials"
            )
        return str(api_url), str(token), workspace_id, "credentials_file"
    fail("credentials.json is missing an Agent Auth connection")


def resolve_credentials() -> tuple[str, str, str | None]:
    api_url, token, workspace_id, _source = resolve_credentials_with_source()
    return api_url, token, workspace_id


def _atomic_json_write(path: Path, payload: dict[str, Any]) -> None:
    """Write private JSON through a same-directory temp file and atomic replacement."""
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    temp_path = Path(temp_name)
    try:
        if hasattr(os, "fchmod"):
            os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(payload, stream, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp_path, path)
        os.chmod(path, 0o600)
    except BaseException:
        try:
            os.close(fd)
        except OSError:
            pass
        temp_path.unlink(missing_ok=True)
        raise


@contextmanager
def credentials_write_lock(timeout_seconds: float = 10.0) -> Iterator[None]:
    """Serialize credential read-modify-write cycles across bootstrap and Use prompt processes."""
    directory = companion_home()
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    lock_path = directory / ".credentials.lock"
    deadline = time.monotonic() + timeout_seconds
    while True:
        try:
            lock_path.mkdir(mode=0o700)
            break
        except FileExistsError:
            try:
                stale = time.time() - lock_path.stat().st_mtime > 300
                if stale:
                    lock_path.rmdir()
                    continue
            except FileNotFoundError:
                continue
            except OSError:
                pass
            if time.monotonic() >= deadline:
                fail("timed out waiting to update credentials.json")
            time.sleep(0.05)
    try:
        yield
    finally:
        try:
            lock_path.rmdir()
        except FileNotFoundError:
            pass


def preflight_credentials_write() -> None:
    """Prove the credentials directory accepts a private temp file before server-side rotation."""
    path = companion_home() / "credentials.json"
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, temp_name = tempfile.mkstemp(prefix=f".{path.name}.preflight.", suffix=".tmp", dir=path.parent)
    try:
        if hasattr(os, "fchmod"):
            os.fchmod(fd, 0o600)
    finally:
        os.close(fd)
        Path(temp_name).unlink(missing_ok=True)


def store_refreshed_credential(
    api_url: str,
    workspace_id: str | None,
    previous_token: str,
    replacement_token: str,
) -> None:
    """Replace only the selected credential entry, preserving every other workspace."""
    path = companion_home() / "credentials.json"
    credentials = load_json(path)
    if not isinstance(credentials, dict):
        fail("credentials.json disappeared before the refreshed token could be saved")

    if credentials.get("schemaVersion") == 3 and isinstance(credentials.get("workspaces"), dict):
        active = workspace_id or credentials.get("activeWorkspaceId")
        entry = credentials["workspaces"].get(active) if active else None
        if not active or not isinstance(entry, dict):
            fail("the active workspace credential changed during token refresh")
        legacy = entry.get("legacyPat")
        if entry.get("apiUrl") != api_url or not isinstance(legacy, dict) or legacy.get("token") != previous_token:
            fail("the active workspace legacy credential changed during token refresh")
        next_credentials = dict(credentials)
        next_workspaces = dict(credentials["workspaces"])
        next_workspaces[str(active)] = {
            **entry,
            "legacyPat": {
                **legacy,
                "token": replacement_token,
                "updatedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            },
            "updatedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        }
        next_credentials["workspaces"] = next_workspaces
    elif credentials.get("schemaVersion") == 2 and isinstance(credentials.get("workspaces"), dict):
        active = workspace_id or credentials.get("activeWorkspaceId")
        entry = credentials["workspaces"].get(active) if active else None
        if not active or not isinstance(entry, dict):
            fail("the active workspace credential changed during token refresh")
        if entry.get("apiUrl") != api_url or entry.get("token") != previous_token:
            fail("the active workspace credential changed during token refresh")
        next_credentials = dict(credentials)
        next_workspaces = dict(credentials["workspaces"])
        next_workspaces[str(active)] = {
            **entry,
            "token": replacement_token,
            "updatedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        }
        next_credentials["workspaces"] = next_workspaces
    else:
        if credentials.get("apiUrl") != api_url or credentials.get("token") != previous_token:
            fail("the legacy credential changed during token refresh")
        next_credentials = {
            **credentials,
            "token": replacement_token,
            "updatedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        }

    _atomic_json_write(path, next_credentials)


def parse_semver(version: str | None) -> tuple[int, int, int, list[str]] | None:
    if not version:
        return None
    without_build = version.strip().split("+", 1)[0]
    core, prerelease_sep, prerelease = without_build.partition("-")
    parts = core.split(".")
    if len(parts) != 3 or not all(part.isdigit() for part in parts):
        return None
    prerelease_parts = prerelease.split(".") if prerelease_sep else []
    return int(parts[0]), int(parts[1]), int(parts[2]), prerelease_parts


def compare_prerelease(left: list[str], right: list[str]) -> int:
    if not left and not right:
        return 0
    if not left:
        return 1
    if not right:
        return -1
    for index in range(max(len(left), len(right))):
        if index >= len(left):
            return -1
        if index >= len(right):
            return 1
        left_part = left[index]
        right_part = right[index]
        left_numeric = left_part.isdigit()
        right_numeric = right_part.isdigit()
        if left_numeric and right_numeric:
            left_num = int(left_part)
            right_num = int(right_part)
            if left_num != right_num:
                return -1 if left_num < right_num else 1
        elif left_numeric != right_numeric:
            return -1 if left_numeric else 1
        elif left_part != right_part:
            return -1 if left_part < right_part else 1
    return 0


def compare_semver(left: str | None, right: str | None) -> int:
    parsed_left = parse_semver(left)
    parsed_right = parse_semver(right)
    if not parsed_left and not parsed_right:
        return 0 if left == right else (-1 if str(left) < str(right) else 1)
    if not parsed_left:
        return -1
    if not parsed_right:
        return 1

    for left_part, right_part in zip(parsed_left[:3], parsed_right[:3]):
        if left_part != right_part:
            return -1 if left_part < right_part else 1
    return compare_prerelease(parsed_left[3], parsed_right[3])


def is_older(local: str | None, current: str | None) -> bool:
    if not local or not current:
        return False
    return compare_semver(local, current) < 0


def lockfile_path() -> Path:
    return companion_home() / "skills.lock.json"


def legacy_log_path() -> Path:
    return companion_home() / "skills.log.json"


def lockfile_candidates() -> list[Path]:
    return [lockfile_path(), legacy_log_path()]


# --- Multi-tool support -------------------------------------------------------
#
# A skill can be installed into several local coding tools (Claude Code, Codex, OpenCode, …) at once.
# The tool registry (scripts/tools.json) is the single, extensible source of truth for each
# tool's on-disk skill directories; ~/.companion/config.json records which tools this machine
# uses; and lockfile records grow a `targets[]` array so every install location stays tracked.


def tool_registry_path() -> Path:
    return Path(__file__).resolve().parent / "tools.json"


def load_tool_registry(path: Path | None = None) -> dict[str, Any]:
    """Return the {tool_key: spec} registry from tools.json."""
    raw = load_json(path or tool_registry_path())
    if not isinstance(raw, dict) or not isinstance(raw.get("tools"), dict):
        fail("tools.json is missing or has no `tools` object")
    return raw["tools"]


def config_path() -> Path:
    return companion_home() / "config.json"


def load_tool_config() -> list[str]:
    """Return the user's confirmed tool set from ~/.companion/config.json (never holds secrets)."""
    raw = load_json(config_path())
    if isinstance(raw, dict) and isinstance(raw.get("tools"), list):
        return [str(tool) for tool in raw["tools"] if isinstance(tool, str)]
    return []


def save_tool_config(tools: list[str], detected_at: str | None = None) -> Path:
    path = config_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    payload: dict[str, Any] = {"schemaVersion": 1, "tools": sorted(dict.fromkeys(tools))}
    if detected_at:
        payload["detectedAt"] = detected_at
    path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    return path


def detect_tools(registry: dict[str, Any] | None = None) -> list[str]:
    """Auto-detect which registered tools are present on this machine via their `detect` paths."""
    registry = registry if registry is not None else load_tool_registry()
    found: list[str] = []
    for key, spec in registry.items():
        for probe in spec.get("detect", []) or []:
            if Path(probe).expanduser().exists():
                found.append(key)
                break
    return sorted(found)


def resolve_target_dir(
    tool: str,
    scope: str,
    skill_name: str,
    project_root: Path | None = None,
    registry: dict[str, Any] | None = None,
) -> Path:
    """Resolve the on-disk skill folder for a (tool, scope) target."""
    registry = registry if registry is not None else load_tool_registry()
    spec = registry.get(tool)
    if not spec:
        fail(f"unknown tool {tool!r}")
    template = (spec.get("skillsDir") or {}).get(scope)
    if not template:
        fail(f"tool {tool!r} has no {scope!r} skills directory in tools.json")
    if scope == "user":
        base = Path(template).expanduser()
    elif scope == "project":
        if project_root is None:
            fail("project scope requires a project root")
        base = Path(project_root) / template
    else:
        fail(f"unknown scope {scope!r}")
    return base / skill_name


def find_project_root(start: Path | None = None) -> Path | None:
    """Walk up from `start` (default cwd) to the nearest repo root (directory holding .git)."""
    current = (start or Path.cwd()).resolve()
    for candidate in [current, *current.parents]:
        if (candidate / ".git").exists():
            return candidate
    return None


def project_lockfile_path(project_root: Path) -> Path:
    """Per-project lockfile, so multiple projects never overwrite each other's project-scope installs."""
    return Path(project_root) / ".companion" / "skills.lock.json"


def compute_dir_checksum(path: Path) -> str:
    """Deterministic sha256 over a skill folder, used to detect locally customized targets."""
    digest = hashlib.sha256()
    for file in sorted(p for p in Path(path).rglob("*") if p.is_file()):
        rel = file.relative_to(path).as_posix()
        digest.update(rel.encode("utf-8"))
        digest.update(b"\0")
        digest.update(file.read_bytes())
        digest.update(b"\0")
    return f"sha256:{digest.hexdigest()}"


def normalize_targets(value: dict[str, Any]) -> list[dict[str, Any]]:
    """Read a lockfile record's install targets, tolerating the legacy single-`installPath` shape."""
    targets: list[dict[str, Any]] = []
    raw = value.get("targets")
    if isinstance(raw, list):
        for entry in raw:
            if isinstance(entry, dict) and entry.get("path"):
                targets.append(
                    {
                        "tool": entry.get("tool") or "claude-code",
                        "scope": entry.get("scope") or "user",
                        "path": entry.get("path"),
                        "checksum": entry.get("checksum"),
                        # Preserve the per-target version (falls back to the record-level version) so a
                        # partial update never rewrites an up-to-date target with a stale version.
                        "version": entry.get("version") or value.get("version"),
                    }
                )
    if not targets:
        legacy_path = value.get("installPath") or value.get("path")
        if legacy_path:
            # Pre-multi-tool lockfiles recorded a single user-scope Claude Code install. Their stored
            # checksum is the package checksum, NOT compute_dir_checksum(folder), so it is not a
            # comparable folder checksum — expose None so callers don't false-positive on customization.
            targets.append(
                {
                    "tool": "claude-code",
                    "scope": "user",
                    "path": legacy_path,
                    "checksum": None,
                    "version": value.get("version"),
                }
            )
    return targets


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def ensure_workspace_lock_entry(raw: dict[str, Any], workspace_id: str | None, api_url: str) -> dict[str, Any]:
    """Return (creating if needed) the workspace-keyed entry that holds the `skills` map, for writes."""
    key = workspace_id or api_url
    workspaces = raw.setdefault("workspaces", {})
    if not isinstance(workspaces, dict):
        raw["workspaces"] = workspaces = {}
    entry = workspaces.get(key)
    if not isinstance(entry, dict):
        entry = {}
        workspaces[key] = entry
    entry.setdefault("apiUrl", api_url)
    entry.setdefault("skills", {})
    if not isinstance(entry["skills"], dict):
        entry["skills"] = {}
    return entry


def existing_target_rows(record: dict[str, Any] | None) -> list[dict[str, Any]]:
    """A prior record's target rows, preserving each target's own version (legacy-aware)."""
    if not isinstance(record, dict):
        return []
    rows: list[dict[str, Any]] = []
    for target in normalize_targets(record):
        rows.append(
            {
                "tool": target["tool"],
                "scope": target["scope"],
                "path": target["path"],
                "checksum": target.get("checksum"),
                "version": target.get("version") or record.get("version"),
            }
        )
    return rows


def upsert_skill_lock_record(
    path: Path,
    workspace_id: str | None,
    api_url: str,
    skill: dict[str, Any],
    targets: list[dict[str, Any]],
    relative_to: Path | None,
) -> None:
    """Upsert one skill record, MERGING the run's targets with any already tracked at this scope.

    The single canonical lockfile writer (companion_lib owns read, normalize, AND write). Only the
    targets touched by this run are replaced (matched by tool+scope); every other tracked target — a
    different tool, an untouched project, or a skipped one not in `targets` — is preserved so a scoped
    or partial install never erases the rest of the lockfile. Never writes the token.
    """
    if not targets:
        return
    raw = load_json(path)
    if not isinstance(raw, dict):
        raw = {}
    raw.setdefault("lockfileVersion", 2)
    entry = ensure_workspace_lock_entry(raw, workspace_id, api_url)

    new_rows = []
    for target in targets:
        stored_path = target["path"]
        if relative_to is not None:
            try:
                stored_path = Path(target["path"]).relative_to(relative_to).as_posix()
            except ValueError:
                stored_path = target["path"]
        new_rows.append(
            {
                "tool": target["tool"],
                "scope": target["scope"],
                "path": stored_path,
                "checksum": target["checksum"],
                "version": skill["version"],
            }
        )

    overridden = {(row["tool"], row["scope"]) for row in new_rows}
    kept = [row for row in existing_target_rows(entry["skills"].get(skill["name"])) if (row["tool"], row["scope"]) not in overridden]
    merged = kept + new_rows

    # Top-level version reflects the OLDEST target so "update available" fires whenever any target is
    # behind the published version; per-target `version` keeps the granular truth.
    versions = [row.get("version") for row in merged if row.get("version")]
    oldest = min(versions, key=cmp_to_key(compare_semver)) if versions else skill["version"]

    entry["skills"][skill["name"]] = {
        "name": skill["name"],
        "slug": skill["slug"],
        "skillId": skill.get("skillId"),
        "companionSkillId": skill.get("companionSkillId"),
        "version": oldest,
        "checksum": skill.get("checksum"),
        "targets": merged,
        "addedAt": now_iso(),
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(raw, indent=2) + "\n", encoding="utf-8")


def workspace_lock_entry(raw: dict[str, Any], workspace_id: str | None, api_url: str) -> dict[str, Any] | None:
    workspaces = raw.get("workspaces")
    if isinstance(workspaces, dict):
        keys = [workspace_id, raw.get("activeWorkspaceId"), api_url]
        for key in keys:
            if key and isinstance(workspaces.get(key), dict):
                return workspaces[key]
    return raw


def skill_records_from_lock(entry: dict[str, Any] | None) -> list[dict[str, Any]]:
    if not entry:
        return []
    source = None
    for key in ("skills", "installedSkills", "installs"):
        value = entry.get(key)
        if isinstance(value, (dict, list)):
            source = value
            break
    if source is None and any(key in entry for key in ("name", "version", "resolved", "installPath")):
        source = [entry]
    if source is None:
        return []

    items = source.items() if isinstance(source, dict) else enumerate(source)
    records: list[dict[str, Any]] = []
    for key, value in items:
        if not isinstance(value, dict):
            continue
        name = value.get("name") or value.get("slug") or (key if isinstance(key, str) else None)
        if not name:
            continue
        records.append(
            {
                "name": str(name),
                # `slug` and `companionSkillId` are surfaced distinctly (in addition to the
                # legacy `name`/`skillId` aliases) so the guard can reason about identity.
                "slug": str(value.get("slug") or name),
                "version": value.get("version") or value.get("resolved") or value.get("installedVersion"),
                "checksum": value.get("checksum"),
                "path": value.get("installPath") or value.get("path"),
                # Every install location for this skill at this scope level (multi-tool aware),
                # with a legacy single-`installPath` lockfile folding into one user-scope target.
                "targets": normalize_targets(value),
                "skillId": value.get("skillId") or value.get("workspaceSkillId") or value.get("companionSkillId"),
                "companionSkillId": value.get("companionSkillId"),
            }
        )
    return sorted(records, key=lambda row: row["name"])


def load_inventory_from(path: Path, workspace_id: str | None, api_url: str) -> list[dict[str, Any]]:
    """Read skill records from one specific lockfile path (returns [] when absent)."""
    raw = load_json(path)
    if raw is None:
        return []
    entry = workspace_lock_entry(raw, workspace_id, api_url)
    return skill_records_from_lock(entry)


def load_local_inventory(workspace_id: str | None, api_url: str) -> tuple[Path | None, list[dict[str, Any]]]:
    for path in lockfile_candidates():
        raw = load_json(path)
        if raw is None:
            continue
        entry = workspace_lock_entry(raw, workspace_id, api_url)
        return path, skill_records_from_lock(entry)
    return None, []


def load_project_inventory(
    workspace_id: str | None, api_url: str, start: Path | None = None
) -> tuple[Path | None, list[dict[str, Any]]]:
    """Records from the current project's lockfile (`<repo>/.companion/skills.lock.json`).

    The single canonical loader for project-scope installs so every consumer (bootstrap inventory,
    the preflight guard) reads the two-level lockfile model the same way. Returns (path, records),
    or (None, []) when not inside a repo or the project lockfile is absent.
    """
    project_root = find_project_root(start)
    if project_root is None:
        return None, []
    path = project_lockfile_path(project_root)
    records = load_inventory_from(path, workspace_id, api_url)
    return (path if records else None), records


def status_for_local(row: dict[str, Any], workspace_by_slug: dict[str, dict[str, Any]], reported_by_slug: dict[str, dict[str, Any]]) -> tuple[str, str]:
    slug = row["name"]
    workspace = workspace_by_slug.get(slug)
    if not workspace:
        return "missing", "not published or not visible in this workspace"
    current = workspace.get("current_version")
    local_version = row.get("version")
    if not local_version:
        return "unknown", "local version is missing from the lockfile"
    if is_older(str(local_version), current):
        return "update", f"newer published version {current}"
    reported = reported_by_slug.get(slug)
    if reported and reported.get("install_status") == "update":
        return "update", "reported install or dependency closure is behind"
    return "current", "up to date"


def status_for_local_guarded(
    row: dict[str, Any],
    workspace_by_slug: dict[str, dict[str, Any]],
    reported_by_slug: dict[str, dict[str, Any]],
    archived_slugs: set[str],
) -> tuple[str, str]:
    """Like status_for_local, but an archived or absent skill can never read as ``current``."""
    slug = row["name"]
    workspace = workspace_by_slug.get(slug)
    if not workspace or slug in archived_slugs or workspace.get("archived") is True:
        if slug in archived_slugs or (workspace and workspace.get("archived") is True):
            return "missing_or_archived", "archived in the workspace but still tracked locally"
        return "missing_or_archived", "not published or not visible in this workspace"
    return status_for_local(row, workspace_by_slug, reported_by_slug)


def print_rows(title: str, rows: list[list[str]]) -> None:
    print(f"\n{title}")
    if not rows:
        print("  none")
        return
    widths = [max(len(row[i]) for row in rows) for i in range(len(rows[0]))]
    for row in rows:
        print("  " + "  ".join(value.ljust(widths[i]) for i, value in enumerate(row)))
