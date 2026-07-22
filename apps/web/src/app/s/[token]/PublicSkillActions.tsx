"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@/components/Icon";
import type { PublicReleasePreview } from "./preview";

function publicPackageUrl(token: string, version: string): string {
  return `/v1/public/skills/${encodeURIComponent(token)}/versions/${encodeURIComponent(version)}/package`;
}

export function buildPublicInstallPrompt(input: {
  origin: string;
  token: string;
  slug: string;
  release: PublicReleasePreview;
}): string {
  const { origin, token, slug, release } = input;
  return `Install the public Companion skill ${slug}@${release.version} from ${origin}.

Authenticate through Companion Agent Auth. Use the official CLI pinned to @auth/agent-cli@0.5.1 and the instance discovery document at ${origin}/.well-known/agent-configuration. Reuse an existing grant for public-skills:install on this instance when available; otherwise start the delegated device flow and wait for the user to approve it.

Use only the pinned CLI commands (never an unversioned global binary):
npx --yes @auth/agent-cli@0.5.1 --url=${origin} discover ${origin}
# Look up the non-secret connection record for this exact origin in
# ~/.companion/public-agent-connections.json. Set storage_dir from that record, or default it to the
# CLI's existing ~/.agent-auth directory when the record is absent or is a legacy string-valued
# agent id. Then check that the local key material still exists without printing private state:
npx --yes @auth/agent-cli@0.5.1 --storage-dir "$storage_dir" --url=${origin} connection "$agent_id"
# connection reads local state only. Always revalidate the live server state immediately afterward:
status_response="$(npx --yes @auth/agent-cli@0.5.1 --storage-dir "$storage_dir" --url=${origin} status "$agent_id")"
# Parse status_response in memory. Reuse the connection only when status is exactly "active" and
# agent_capability_grants contains public-skills:install with status exactly "active".
# If the agent is active but that active grant is absent, request it on the existing agent:
request_response="$(npx --yes @auth/agent-cli@0.5.1 --storage-dir "$storage_dir" --url=${origin} request "$agent_id" --capabilities public-skills:install --preferred-method device_authorization --reason "Install public Companion skills from this instance")"
# After approval, discard request_response and revalidate instead of trusting cached grant state:
status_response="$(npx --yes @auth/agent-cli@0.5.1 --storage-dir "$storage_dir" --url=${origin} status "$agent_id")"
# If the local connection is absent, live status is not active (including revoked, rejected, or
# expired), or the CLI reports agent_not_found, create a new delegated agent with the same pinned CLI:
connect_response="$(npx --yes @auth/agent-cli@0.5.1 --storage-dir "$storage_dir" --url=${origin} connect --provider ${origin} --mode delegated --preferred-method device_authorization --capabilities public-skills:install --name "Companion installer" --reason "Install public Companion skills from this instance")"
# If status or connect reports host_revoked or host_not_found, do not reuse that host identity.
# Create a fresh empty mode-0700 storage directory, set storage_dir to it, and rerun the exact connect
# command above with --storage-dir "$storage_dir". Do not copy the revoked host.json into it.
# Parse agentId from connect_response in memory. Atomically store only the non-secret
# { origin: { agentId, storageDir } } record in ~/.companion/public-agent-connections.json with mode
# 0600. The CLI keeps all private key material separately. Before continuing, run status once more
# and require both the active agent status and the active public-skills:install grant described above.
status_response="$(npx --yes @auth/agent-cli@0.5.1 --storage-dir "$storage_dir" --url=${origin} status "$agent_id")"
# Then execute with that id, capturing the JSON without echoing it:
install_response="$(npx --yes @auth/agent-cli@0.5.1 --storage-dir "$storage_dir" --url=${origin} execute "$agent_id" public-skills:install --args '{"token":"${token}","version":"${release.version}"}')"

Request an install ticket for this exact release with token ${token} and version ${release.version}. Pipe the captured JSON over stdin to a small local program that parses the ticket in memory and performs the HTTP request itself. Never interpolate the ticket into a shell command, URL, argv, log, file, or chat output. Send it only as the X-Companion-Transfer-Ticket request header, then download the package from:
${origin}${publicPackageUrl(token, release.version)}

Before writing anything:
1. Verify SHA-256 ${release.checksum} and an exact size of ${release.size_bytes} bytes.
2. Inspect the ZIP without executing package scripts. Reject absolute paths, .. traversal, duplicate/case-colliding paths, symlinks, hardlinks, devices, and any entry escaping the destination.
3. Require SKILL.md at the archive root. Install only this root package; do not resolve dependencies, secrets, skill_installs, or scripts. Report declared prerequisites as warnings.
4. Ask whether to install globally or in the current project, then show the resolved destination. If it exists, ask before replacing it.
5. Extract to a sibling temporary directory, fsync where supported, and atomically swap it into place. On failure, leave the previous installation intact.

Finish by reporting ${slug}@${release.version}, the destination, and any declared prerequisites. Never print credentials or ticket values.`;
}

export function PublicSkillActions({
  token,
  slug,
  release,
  authenticated,
  startDownload = false,
}: {
  token: string;
  slug: string;
  release: PublicReleasePreview | null;
  authenticated: boolean;
  startDownload?: boolean;
}) {
  const [copyState, setCopyState] = useState<"idle" | "copying" | "copied" | "error">("idle");
  const downloadStarted = useRef(false);
  const packageUrl = release ? publicPackageUrl(token, release.version) : null;
  const returnPath = `/s/${encodeURIComponent(token)}?download=1`;
  const loginHref = `/login?next=${encodeURIComponent(returnPath)}`;

  const prompt = useMemo(() => {
    if (!release || typeof window === "undefined") return null;
    return buildPublicInstallPrompt({ origin: window.location.origin, token, slug, release });
  }, [release, slug, token]);

  useEffect(() => {
    if (!startDownload || !authenticated || !packageUrl || downloadStarted.current) return;
    downloadStarted.current = true;
    // Keep the stable public page mounted after the browser starts the transfer. Removing the query
    // flag prevents refresh/back from downloading a second copy.
    window.history.replaceState(window.history.state, "", `/s/${encodeURIComponent(token)}`);
    window.location.assign(packageUrl);
  }, [authenticated, packageUrl, startDownload, token]);

  const copyPrompt = async () => {
    if (!prompt || !navigator.clipboard) {
      setCopyState("error");
      return;
    }
    setCopyState("copying");
    try {
      await navigator.clipboard.writeText(prompt);
      setCopyState("copied");
      window.setTimeout(() => setCopyState("idle"), 2200);
    } catch {
      setCopyState("error");
    }
  };

  if (!release) {
    return (
      <div className="spreview__release-empty" role="status">
        <Icon name="lock" size={15} />
        <div>
          <strong>No public release</strong>
          <span>The creator has not made a package available for installation.</span>
        </div>
      </div>
    );
  }

  return (
    <div className="spreview__install">
      <div className="spreview__actions" aria-label="Install this skill">
        <button
          type="button"
          className="btn-primary spreview__cta"
          onClick={copyPrompt}
          disabled={copyState === "copying"}
        >
          <Icon name={copyState === "copied" ? "check" : "copy"} size={15} />
          {copyState === "copying"
            ? "Copying..."
            : copyState === "copied"
              ? "Install prompt copied"
              : "Copy install prompt"}
        </button>
        {authenticated ? (
          <a className="btn-sec spreview__cta" href={packageUrl ?? undefined} download>
            <Icon name="download" size={15} />
            Download ZIP
          </a>
        ) : (
          <Link className="btn-sec spreview__cta" href={loginHref}>
            <Icon name="log-in" size={15} />
            Sign in to download
          </Link>
        )}
      </div>
      <p className={`spreview__action-note${copyState === "error" ? " is-error" : ""}`} role="status" aria-live="polite">
        {copyState === "error"
          ? "Could not copy the prompt. Check browser clipboard access and try again."
          : authenticated
            ? "The ZIP is pinned to the public release shown above."
            : "Agent installs use delegated approval. Direct downloads require a Companion account."}
      </p>
    </div>
  );
}
