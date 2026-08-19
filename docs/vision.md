# Companion v2 vision

Companion v2 is a self-hostable Skills Hub with an optional, tightly bounded Companions runtime.
The Skills Hub remains the product core: organizations create, validate, version, organize, share,
install, and publish portable `SKILL.md` packages. A hosted Companion is an additional way to use
that governed library: one named teammate, one durable thread, one persistent box.ascii.dev Box,
and one Pi daemon that can work asynchronously after the browser closes.

The control plane owns identity, authorization, durable intent, selected Skills and plugins,
provider connections, transcript projections, and observable outcomes. A dedicated runtime service
alone contacts Box and Pi. Pi sessions and working files remain on Box disk; ordinary reads and all
Viewer access remain control-plane-only.

External coding agents continue to use delegated Agent Auth as Skills Hub clients. They are not
hosted Companions, and their grants do not authorize Companion lifecycle or chat operations.

## Principles

- Skills are portable files, not opaque hosted behavior.
- Organization and personal libraries have explicit, predictable ownership.
- Validation, immutable versions, dependencies, comments, public releases, and install records make
  reuse trustworthy.
- Labels organize skills without changing access.
- Secrets remain write-only and are disclosed only through scoped, short-lived grants or the
  authorized runtime injection boundary.
- Skill Databases provide declared, tenant-scoped state without executing package scripts.
- GitHub sync, the CLI, Agent Auth, and hosted Companions use the same service-layer authorization.
- A message is durable before wake or delivery; every accepted turn ends in a reply, decision,
  explicit failure, interruption, or cancellation.
- Runtime work survives API, browser, and runtime replica failure through durable attempts,
  operations, leases, checkpoints, and fenced settlement.
- Ambiguity is visible. Companion never guesses that a prompt was not executed and never silently
  replays a possibly accepted attempt.

## Product boundary

Companions deliberately stop short of the broader Grok Bot vision. This version has no generic
Projects, multi-Bot teams or handoffs, proactive jobs, voice, file library, artifact surface, or
arbitrary computer-provider marketplace. Scheduled Companion routines are in scope: they fire
named prompts on a cron+timezone schedule as ordinary turns. A message may carry files and a turn
may hand images back, because showing a teammate something is part of talking to them; nothing
about that becomes a store of files with a life of its own. It does not add a generic model platform,
agent builder, container catalog, deployment manager, or harness selection UI.

Pi is the only harness, box.ascii.dev is the only Box provider, one Companion is always one Box plus
one Pi plus one thread, and sending a message is the only normal wake action. Full Box restart and
permanent deletion remain explicit operator actions; automatic recovery is Pi-only.
