# Companion v2 product

## Product definition

Companion v2 is a multi-tenant Skills Hub organized as **Organization → User**, with optional
hosted Companions. Skills are the durable capability layer. A Companion is one named, asynchronous
teammate that applies selected Skills and member-connected MCP plugins inside one persistent Box
through Pi.

Members use the web or CLI for Skills Hub workflows. External coding agents use delegated Agent
Auth to consume the same skill APIs. Hosted Companions use a separate authenticated chat and runtime
boundary; Agent Auth never grants Box lifecycle access.

## Users and authorization

- **Organization Owner** manages organization identity, membership, billing, GitHub, provider
  connections, and policy.
- **Organization Admin** manages the same workspace settings allowed by RBAC.
- **Developer** creates, organizes, publishes, installs, comments on, and uses skills.
- **External coding agent** is a delegated Skills Hub client with only approved capabilities for one
  organization. Companion does not launch it.
- **Companion Owner** owns one hosted Companion, manages its sharing/provider, and alone may
  permanently delete it.
- **Companion Editor** may send messages, answer decisions, change allowed settings, and use explicit
  runtime actions.
- **Companion Viewer** reads the PostgreSQL projection only. Viewer access never contacts or wakes
  Box and exposes no mutation controls.

The Companion Owner is immutable. Sharing is workspace-wide Editor or Viewer access; it does not
change Skills Hub ownership and does not grant access to another member's personal Skills or plugin
credentials.

## Libraries and ownership

- `org`: flat organization-wide library. Every member can read and manage its skills.
- `personal`: private **My Skills** library. Only `creator_id` can read or manage the skill; admins
  have no override.
- A slug is unique across both scopes in an organization.
- **Share** is the sole, owner-only, one-way `personal → org` transition.
- **Installed** is a view: a member's personal skills plus org skills with a `skill_installs` row.

Organization labels form a shared tree. Personal labels form a private per-member tree. Labels are
slash-separated, multi-assigned, and may exist without skills.

## Core journeys

1. Create or upload a package; validate archive safety, `SKILL.md`, manifest, dependencies, secrets,
   and database declarations.
2. Publish an immutable version and review its files, history, dependency graph, comments, and
   activity.
3. Share a personal skill to the organization with its required private dependency closure.
4. Install or update a skill into supported external coding tools and report the installed version.
5. Publish one pinned organization version as a checksum-addressed public release.
6. Mirror organization skills to GitHub deterministically.
7. Let an approved external coding agent read/write skills, use Skill Databases, or retrieve bound
   secrets through constrained grants.
8. When Companions are enabled, create a named Companion with one connected provider/model, selected
   Skills, and selected member MCP accounts; send work and leave while it continues.
9. Return to a durable thread that truthfully shows queued, active, input-needed, completed, failed,
   interrupted, or cancelled work, and explicitly Retry or Cancel an ambiguous attempt.

## Hosted Companion boundary

`COMPANION_COMPANIONS_ENABLED` plus the existing exact email-domain allowlist gates the entire
surface. Disabled means routes, navigation, and new runtime claims fail closed.

Each Companion has exactly one thread, one Box, and one Pi daemon. The API persists messages, turns,
decisions, settings, and lifecycle operations and returns `202`; it never contacts Box or Pi. A
dedicated runtime service serializes work per Companion, revalidates current authority and selected
resources, and owns every provider side effect.

Sending is the only normal wake path. There is no Wake button and no keystroke prewarm. Pi must be
idle before dispatch, only one attempt may be active, and queued turns preserve order. An attempt
without a provable Pi acknowledgement becomes `interrupted` and is never replayed automatically.
Retry creates a new attempt; Cancel releases the queue. Full Box restart is always an explicit,
confirmed Editor/Owner action. Automatic repair may recycle Pi only.

Provider connections and member MCP accounts are envelope-encrypted and survive the one-time legacy
Companion purge. Old Companions, Boxes, transcripts, runtime rows, pools, and leases do not migrate.

## Explicit exclusions

Historical Projects and generic skill runs remain removed. This release adds no multi-Bot
coordination, group Bot chat, handoffs, routines, schedules, proactive jobs, voice, file library,
file versioning, artifact surface outside the thread, harness selection, Box-provider marketplace,
container catalog, deployment management, or generic AI application builder. Chat files are in
scope and bounded: images and documents sent with a message, and images Pi hands back from a turn. Native mobile remains outside Skills, Plugins, and Companion
settings; it receives no injected Skills or MCP accounts.
