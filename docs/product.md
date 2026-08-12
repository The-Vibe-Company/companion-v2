# Companion v2 product

## Product definition

Companion v2 is a multi-tenant Skills Hub organized as **Organization → User**. The product workspace is Skills. Members use the web or CLI; external coding agents use delegated Agent Auth to consume the same skill APIs.

## Users

- **Owner** manages organization identity, membership, billing, GitHub, and policy.
- **Admin** manages the same workspace settings allowed by RBAC.
- **Developer** creates, organizes, publishes, installs, comments on, and uses skills.
- **External coding agent** is a delegated client. It can receive only approved skill, Skill Database, and skill-secret capabilities for one organization. Companion never launches it.

## Libraries and ownership

- `org`: flat organization-wide library. Every member can read and manage its skills.
- `personal`: private **My Skills** library. Only `creator_id` can read or manage the skill; admins have no override.
- A slug is unique across both scopes in an organization.
- **Share** is the sole, owner-only, one-way `personal → org` transition.
- **Installed** is a view: a member's personal skills plus org skills with a `skill_installs` row.

Organization labels form a shared tree. Personal labels form a private per-member tree. Labels are slash-separated, multi-assigned, and may exist without skills.

## Core journeys

1. Create or upload a package; validate archive safety, `SKILL.md`, manifest, dependencies, secrets, and database declarations.
2. Publish an immutable version and review its files, history, dependency graph, comments, and activity.
3. Share a personal skill to the organization with its required private dependency closure.
4. Install or update a skill into supported external coding tools and report the installed version.
5. Publish one pinned organization version as a checksum-addressed public release.
6. Mirror organization skills to GitHub deterministically.
7. Let an approved external coding agent read/write skills, use Skill Databases, or retrieve bound secrets through constrained grants.

## Runtime boundary

Historical Projects, skill runs, attachments/artifacts, provider settings, and deployment surfaces
remain removed and fail closed. Behind the `companions` flag, an API-only control plane stores
Companion list/open metadata and controls Pi in box.ascii.dev. Sessions remain on Box disk, and
viewer reads never wake or contact Box.
