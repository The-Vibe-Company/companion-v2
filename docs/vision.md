# Companion v2 vision

Companion v2 is the self-hostable Skills Hub for an organization and the coding agents its members already use. It is a trusted registry for creating, validating, versioning, organizing, sharing, installing, and publishing `SKILL.md` packages.

Companion does not create, launch, host, resume, or execute agents. It has no chat runtime, Project workspace, sandbox, model router, container catalog, or deployment provider. External coding agents are clients of the Skills Hub through delegated Agent Auth; they execute outside Companion.

## Principles

- Skills are portable files, not opaque hosted behavior.
- Organization and personal libraries have explicit, predictable ownership.
- Validation, immutable versions, dependencies, comments, public releases, and independent Remote/Local delivery records make reuse trustworthy.
- An optional external local gateway exposes metadata-only native skill proxies and resolves approved packages on demand; it remains a client, never a Companion runtime.
- Labels organize skills without changing access.
- Secrets remain write-only and are disclosed only through scoped, short-lived grants.
- Skill Databases provide declared, tenant-scoped state without turning Companion into an execution platform.
- GitHub sync and the CLI use the same service-layer authorization as the web.
- The control plane never executes package scripts.

## Non-goals

- Agent lifecycle, chat, prompts, transcripts, attachments, artifacts, or runtime cleanup.
- Persistent Cowork or Project workspaces.
- Sandboxes, prewarming, model credentials, runtime providers, containers, or deployments.
- A generic AI application builder.
