# Companion v2 vision

Companion v2 is the self-hostable Skills Hub and optional Companions control plane for an
organization. It is a trusted registry for creating, validating, versioning, organizing, sharing,
installing, and publishing `SKILL.md` packages.

By default Companion does not operate agents. When the `companions` feature is enabled, the API may
create and resume an isolated box.ascii.dev Box and control a Pi daemon inside it. Pi and its
sessions execute on Box disk; the Companion services remain a metadata and authorization control
plane. External coding agents can still use delegated Agent Auth as Skills Hub clients.

## Principles

- Skills are portable files, not opaque hosted behavior.
- Organization and personal libraries have explicit, predictable ownership.
- Validation, immutable versions, dependencies, comments, public releases, and install records make reuse trustworthy.
- Labels organize skills without changing access.
- Secrets remain write-only and are disclosed only through scoped, short-lived grants.
- Skill Databases provide declared, tenant-scoped state without turning Companion into an execution platform.
- GitHub sync and the CLI use the same service-layer authorization as the web.
- The control plane never executes package scripts.

## Non-goals

- Control-plane execution of agent code, prompts, transcripts, or runtime files.
- Persistent Cowork or Project workspaces.
- Runtime providers other than Box, harnesses other than Pi, prewarming, or deployment management.
- A generic AI application builder.
