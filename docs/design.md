# Companion v2 architecture — Skills Hub and optional Companions

This document is the authoritative architecture. Companion is always a Skills Hub; behind the
`companions` flag it is also a control plane for Pi daemons that execute inside box.ascii.dev.

## System shape

```text
apps/web       Next.js Skills workspace and settings
apps/api       REST/tRPC gateway over shared services
apps/worker    GitHub sync, billing reconciliation, Skill Database object cleanup
cli            REST client for skill workflows

packages/contracts       shared Zod/API contracts
packages/db              Drizzle schema, forward migrations, RLS
packages/core            tenant/authz and domain services; no Next.js dependency
packages/skills          package parsing, validation, versioning
packages/skilldb         hosted SQLite execution for declared Skill Databases
packages/storage         archives, releases, images, logos, database objects
packages/github          GitHub App and deterministic repository writer
packages/auth            Better Auth
packages/billing         Stripe integration
packages/companion-skill bundled external-agent workflow
```

There is no Project/skill-run supervisor, model catalog, deployment reconciler, or runtime UI.
The API owns one Box HTTP adapter for the gated Companions lifecycle; Pi remains inside Box.

## Data model

Every tenant-owned row carries `org_id`. The current Drizzle schema in `packages/db/src/schema.ts` is the source of truth.

Core entities are organizations, users, memberships, invitations, skills, immutable skill versions/files, dependencies, installs, labels and personal labels, comments/images, public releases and transfer tickets, GitHub connections/destinations, skill-secret declarations/bindings/suggestions, encrypted secrets/versions/recipients, Skill Database declarations/realms/shares/object deletions, audit records, billing, tokens, onboarding/preferences, Agent Auth identities/grants, and gated Companion control-plane metadata plus encrypted workspace provider connections.

The forward migration `0063_skills_hub_only.sql` intentionally drops all historical Project, skill-run, sandbox-usage, model-provider, prompt, transcript, attachment, artifact, and runtime worker state. The cutover is fail-closed: its first statement refuses to drop ownership rows while Project workspaces, unsettled sandboxes, active usage, or S3-backed runtime metadata remain. Operators must quiesce the old release and drain or explicitly delete those external resources before upgrading. Because the release that owned the cleanup worker no longer exists, the one-shot `apps/api` `cutover` command performs that cleanup once: it reports every referenced object key and provider identity, deletes each object before removing the row that names it, and refuses to discard provider-backed rows without an explicit operator confirmation. Historical migrations remain immutable so already-migrated databases can upgrade safely.

## Authorization

Every service-layer decision combines:

1. membership in the exact organization;
2. the org-role capability;
3. resource ownership where applicable.

Organization skills are readable and manageable by every member. Personal skills are visible and manageable only by `creator_id`; Owner/Admin has no override. Personal Skill Database realms and personal labels use the same owner-private boundary. Cross-tenant access fails closed. Public release reads go only through purpose-built, checksum-bound public functions and tickets.

## Skills lifecycle

Packages are validated without executing scripts. Publication writes immutable version/file metadata, dependency edges, secret slots, database declarations, and an audit event. Share performs the only personal-to-org transition and includes required personal dependencies after an explicit plan. Install records are per member and do not copy skill rows.

Public release promotion pins one exact organization skill version and checksum. Upload/download transfer tickets are short-lived, purpose-specific, single-use where applicable, and revalidated at redemption. GitHub sync writes deterministic, digest-verifiable repository state.

## Secrets

Secret plaintext is accepted only on write/rotation, envelope-encrypted, and never returned by ordinary CRUD. Skill bindings refer to stable slots. External clients retrieve authorized values only through preflight plus short-lived, non-replayable grants. Logs and audit metadata remain value-free. The database usage helper counts active skill bindings only.

## Skill Databases

Skills may declare bounded SQLite tables. Core validates additive schema evolution and access, `packages/skilldb` executes parameterized statements, and object storage persists the realm with conditional generation checks. Organization realms are shared; personal realms are creator-private unless explicitly shared with a current member. The worker cleans queued database objects only.

## Delegated Agent Auth

Agent Auth connects an external coding agent to the Skills Hub. Tenant capabilities are limited to `skills:read`, `skills:write`, `database:read`, `database:write`, `secrets:read`, and `secrets:write`, each constrained to one exact workspace; `public-skills:install` remains instance-wide. This is client authorization, not an internal agent product. Host defaults cannot silently grant tenant capabilities, and transfer-ticket operations are separately registered and revalidated.

An authenticated Agent Auth identity may issue a short-lived child PAT only through the registered inheritance form. The server snapshots its active exact-workspace grants, expands database write to read, caps expiry at seven days and the earliest source expiry, and persists value-free source/target provenance. Request bodies cannot select scopes or another organization, PATs cannot mint or refresh child PATs, and target-bound tokens require the matching delegation-target header. This is bearer binding rather than runtime attestation: possession of both values remains sufficient until expiry or revocation.

## API, Companions, and fail-closed removal

The API exposes auth, organizations, skills, labels, dependencies, comments, files/versions, installs, public releases, GitHub, secrets, Skill Databases, billing, tokens, onboarding, and skill-facing Agent Auth. Historical Project, skill-run, prompt, attachment/artifact, and model-provider endpoints remain unregistered.

`COMPANION_COMPANIONS_ENABLED=true` additionally registers authenticated, tenant-scoped Companion
metadata, ACL, chat thread, provider, and Box/Pi lifecycle endpoints. A required
`COMPANION_COMPANIONS_ALLOWED_EMAIL_DOMAINS` exact-domain allowlist is also required before routes
are registered. An unset or empty allowlist keeps Companions disabled even when the master flag is
true. Once enabled, the allowlist gates every endpoint after authentication and before tenant
resolution; missing or malformed emails fail closed.
List, detail, ACL,
thread, provider metadata, and default status reads use PostgreSQL only. Companion sharing is
workspace-only: a Companion Owner grants Editor or Viewer access to the whole workspace, or keeps it
private. There are no per-member grants and no email invites, and authorization ignores any legacy
member-grant row so a stale grant can never open a Companion. Live status, start/stop, plugin
injection, and desktop require owner/editor access before the Box adapter is created, while provider
and share management remain owner-only. Each Companion owns exactly one chat thread. `companion_threads` carries its ordinal and
delivery watermarks and `companion_transcript_entries` carries its messages, so sending persists in
the control plane before any Box contact and an undelivered message stays pending for the same
idempotent send to retry. An Owner/Editor send uses a lightweight runtime observation to deliver
directly when Box and Pi are already running; otherwise it starts the Companion through the same lifecycle path as `/runtime/start`, so an
archived Box resumes and a stopped Pi starts without making the common online path claim or inject
anything. One send is one turn: the sender names the message it is creating with a
`client_message_id` UUID that becomes the entry's event id, so the transcript's
`(companion_id, event_id)` primary key decides how many turns a send produces and the same send
arriving twice — retried, replayed by a proxy, submitted twice — resolves to the turn already stored
rather than persisting a second one. Because that message is then no longer pending it is never handed
to Pi again either, so a replayed send cannot produce a second reply. Since persistence precedes the
wake, that request can stay open for the wake (~45–65s, up to the start budget), so the web rewrite's
proxy timeout is raised past that budget rather than the 30s default that cut the send off mid-wake;
and the composer holds its `client_message_id` beside a draft until the send confirms, so retrying a
draft a lost request left behind names the durable turn instead of a second one. Sent messages and projected Pi
output keep separate event-id namespaces, so a sender can never name an entry the Pi log will claim.
Send and sync reach Pi through its owner-only FIFO, while sync also projects new Pi output from a
recorded byte offset. A send that Pi accepts refreshes the Box TTL to six hours, so idle is measured
from the last successful message rather than the last wake. Every user message records its author,
and the thread payload names the reading member,
so a thread shared with Editors attributes each message to the member who sent it. Companion reads
also project each thread's newest chat line onto the row itself as `last_message`, in one
`DISTINCT ON (companion_id)` query, so a conversation list can say what was last said without opening
every thread. Only `user` and `assistant` entries qualify, and the exclusion is in the query rather
than after it: a list is read by everyone who can see the Companion, and a tool title is a command, a
path, or a URL, while a pending decision is a question nobody has answered, so a Companion whose
newest entry is a tool run still previews the last thing that was actually said. The projection adds
no visibility of its own — only ids the actor may already read are asked about — and mutations, which
answer about the settings they just wrote, carry null, so a surface keeping a list merges the field
rather than replacing the row. The read that opens a thread also returns `last_read_ordinal`, THE-351's
per-member watermark as it stood *before* that read advanced it, so the transcript can draw one divider
where the reader left off; a send or a sync answers about what it just wrote and carries null, as does
a reader who has never opened the thread. Viewers can read the control-plane thread but cannot send or contact Box. The default remains fail-closed: when
the flag is absent or false, none of these routes are registered. Owner/Admin-managed workspace
model-provider credentials are envelope-encrypted, write-only, and decrypted only after the
Companion wake guard. API-key connections cover Pi's pinned Kimi, Moonshot, OpenAI, Google, and z.ai
auth keys. Claude Pro/Max uses browser PKCE and Codex uses ChatGPT device authorization; the API
stores the resulting Pi OAuth entry without returning access or refresh tokens to the browser.
Start never accepts caller-supplied model-provider credentials; it writes only the selected
provider's Pi auth entry to the owner-only Box auth file.
Owner/editor web and mobile-web starts resolve the Companion's `selected_skill_ids` allow-list and
expose those packages through Pi's explicit native Skills source. Native-mobile starts always replace that source
with an empty tree. Member-private labeled MCP accounts attached via `selected_mcp_account_ids` are
translated into an isolated
`pi-mcp-adapter` config; durable Box JSON contains environment references only. Connector values are
write-only and envelope-encrypted in PostgreSQL, then decrypted after the runtime guard and passed
through the transient `mcp_credentials` channel. Their staged disk file is moved into the Box user
runtime tmpfs: systemd can reread it when Pi auto-restarts, while Box stop/reboot destroys it and
cannot snapshot it. Empty attachment stages no member MCP pins. Native mobile receives no MCP accounts. Viewer
authorization completes before skill storage, connector decryption, or Box is contacted.

Tool execution is bounded independently of Box lifecycle. The staged Pi extension refuses image
paths before built-in `read` enters vision and gives every accepted execution tool a scoped
90-second deadline, clearing sibling timers before it aborts the active turn; interactive
`ask_user` keeps the decision system's five-minute deadline. Live sync and the read-only
control-plane thread fallback close any chip whose result is still absent at that deadline, using
compare-and-set settlement so a late result cannot overwrite the timeout. The control plane sends no
unscoped Pi abort, touches no Box on the read fallback, never marks the Box Starting, and never
exposes Wake. A settled `browse` or `computer` run receives
exactly one frame, attributed by the run id whose settlement won and captured directly from the
existing Box desktop source, never through Pi `read`; the stored frame remains read-only for Viewers.

The web has no `/projects` route and no Run/Session state in the Skills URL grammar. Old query parameters are ignored and canonical navigation returns to the Skills detail. By default the only product workspace navigation is Skills. The `COMPANION_COMPANIONS_ENABLED` server-side flag plus a non-empty email-domain allowlist expose an authenticated `/companions` list/create shell, the 1:1 chat thread it opens into, plus the Skills | Companions sidebar mode segment that reaches it; without either setting neither the route nor the segment exists. The route and segment are also absent for authenticated users without a matching email. Opening a Companion replaces the list with its thread and deep-links through a `companion` search parameter. The web and mobile-web list also opens a separate Plugins surface for member-private labeled MCP accounts; native mobile has no Plugins surface. That surface exposes a product-owned catalog shipped with Companion containing Linear, GitHub, and Notion; neither the browser nor the API queries an external MCP registry. Those three entries use an authorization-code + PKCE broker: Linear and Notion dynamically register the deployment callback, GitHub uses the deployment's configured OAuth App, and callback state plus the pending client credential stay signed and envelope-encrypted until the provider grant is saved. The resulting access/refresh grant reuses THE-321's member-private `saveCompanionPlugin` row and encrypted credential column, refreshes before runtime injection, and is never returned to the browser. Custom servers retain THE-321's explicit token/header form. Both paths require an account label, so the same server can be connected under several labels and a duplicate label still fails closed. The Plugins surface and OAuth remain gated by the same flag and email-domain allowlist as the rest of Companions.

The thread shows the conversation, one chip per tool Pi ran, one Box status chip, a settings action, and a context-panel toggle for a runner; it exposes no Wake action because sending a message is the normal start path. Pi's Skills and plugin chrome stays out of it, and a Viewer gets the transcript with no composer. That conversation and its composer are rendered with `@assistant-ui/react` and its shadcn registry components — the Thread, Message, Composer, and ActionBar primitives plus the vendored, hand-pruned `thread`, `markdown-text`, and `reasoning` components (the registry's tool fallback is deliberately not vendored because Companion owns its question-card authorization boundary) — over an ExternalStore runtime whose only source is the control-plane thread payload and whose only write is the existing `POST /v1/companions/:id/messages` call, so persistence, delivery, and the Owner/Editor boundary stay where they already are: no assistant-ui Cloud, history, thread list, model adapter, attachment, or generative-UI surface is wired up, and the runtime has nothing of its own to contact, so rendering a Viewer's thread still reaches no Box. The flat entry log is grouped into chat messages before it reaches the runtime: a member's message and a run note are each their own message, and every consecutive reply, tool run, and question card Pi produced is one assistant message whose parts are those entries in the order they happened, keyed by the first entry's event id so a growing turn is extended rather than replaced. Day boundaries and the unread `New` divider are drawn on those messages, so neither can land inside a turn. A reply renders as markdown; reasoning renders behind a collapsed disclosure; a tool run and a question card ride in as `tool-call` parts named `companion_tool` and `companion_decision`, which is how answers reach `POST /v1/companions/:id/decisions/:requestId` from inside a message part. Nothing streams — the transport is the same control-plane poll — so the smoothing and deferred parsing the registry turns on for token streams are off, and a part is the entry exactly as the last poll saw it. Tailwind v4 is scoped to this one surface: it is imported without preflight and with source detection off, under an `.aui-scope` mini-reset, with the shadcn semantic colour names bridged onto the existing OKLCH tokens, so the fifteen hand-authored stylesheets that own every other page are untouched and dark mode and the accent presets keep working here. The composer keeps a refused message's text, a message appears in the transcript as soon as it is sent already carrying the event id the control plane will store it under — so the saved entry replaces it rather than joining it even if a thread read lands mid-send — and a second submit while one send is in flight is a no-op. A turn that thought before it answered keeps that thinking in `companion_transcript_entries.reasoning`, beside the reply rather than inside it, so the thread can disclose why an answer happened without the thinking outliving, reordering ahead of, or being readable without the turn it belongs to; a check constraint couples the column to the `assistant` role, a second bounds it, and a turn whose thinking already is its reply — a model that answered inside the thinking block and stopped — carries none, so no reader is shown the same passage twice. Each tool Pi calls is projected as its own `tool` entry carrying the run in `companion_transcript_entries.tool`, so a shell, file, or browse run takes an ordinal between the turns and renders as a collapsible chip that spins while the run is open and settles to a check or a cross when Pi reports its result; a check constraint couples the `tool` role to that column so no other role can carry a run. Pi executes `bash`, `write`, and `edit` without approval. Only `ask_user` blocks on an `extension_ui_request` that sync projects as a question card; Owner and Editor answer or deny through `POST /v1/companions/:id/decisions/:requestId`, timeout cancels the question, and the answer record stays on the transcript so a Viewer can read it without acting. Historical shell/file Allow / Deny cards remain readable and settleable, but the current Box extension never creates new ones. When a visual run settles, the Owner/Editor sync captures one frame of the Box desktop and stores it on that run as a bounded `data:` URL shown inside the chip, so a screenshot never means a second desktop mint, an object-storage upload, or a new tab, and a Viewer sees the chips and the frames already stored without contacting a Box. The chip reports that compute as a dot and one state word — Online, Starting, Asleep, or Error — keeping `Box · online` and its siblings as its accessible name and tooltip so the word itself never has to give way on a narrow header; a runner whose Box is already running clicks it to open the Box desktop Lux drives in a new tab, and for a Viewer it is text only. Beside the conversation, that same runner keeps a context panel: the Box screen as a non-interactive 16:10 preview, a Routines placeholder, and the library skills this Companion stages as chips with a link into its settings. It is a second pane rather than a change to the transcript, open by default where there is room for it and remembered per device, and below 1024px it comes over the conversation with Esc and a scrim to dismiss it. The screen's stream is minted fresh on every join — opening the panel, reconnecting it, and `Open desktop` are each their own mint over the one `POST /v1/companions/:id/runtime/desktop` route — and never held past the join it belonged to, so closing the panel, moving to another Companion, or a Box that stops under the stream drops it. The framed desktop is another origin's document, granted no top-level navigation and no popups, with pointer events stopped at the card so it is watched rather than driven, and no part of the secret-bearing URL is ever printed. A sleeping Box reads as asleep in the panel and tells the runner to send a message, because a desktop request cannot resume a Box, and a Viewer gets neither the panel nor its toggle. Opening a runner's thread and beginning a send each trigger an immediate status refresh. While the send is open or the Companion is transitioning, the web observes every three seconds, then returns to its slower cadence; an already-online runner may use the live Box observation, while a Viewer uses only the control-plane projection. Each response is applied only while it is the newest for that Companion, so an older Starting observation cannot overwrite Online. The chip, composer footer, and reply cadence therefore leave the pre-send state while the POST is still open, without reload, and neither a Viewer read nor any status observation can wake a Box.

A Companion carries optional instructions of at most 280 characters, also shown as its short persona in the list. Creation asks for the name, those instructions, one connected provider and one model from that provider's live pi.dev catalog, then which Skills Hub packages this Companion may use, whether it may create or update skills on the owner's behalf (`can_write_skills`, off by default), and which already-connected MCP plugins it may stage (`selected_mcp_account_ids`, empty by default). The API caches the last-known catalog with a bundled-pin fallback and a bounded fetch, so the picker never becomes empty when pi.dev is unavailable. The same provider-then-model picker, Skills multi-select, and Plugins multi-select are reused by `/companions/:id/settings`, and the catalog response supplies both model lists. Owner and Editor can later change those settings on that separate web and mobile-web page entered from the list; Viewer reads them but has no writes, and only Owner can delete. The same page gives Owner and Editor an online-only Runtime control: `Pi only` is selected by default and restarts Pi directly, while `Full Box` requires explicit confirmation that the Box and work in progress will be interrupted. Viewer sees no restart control, and unsaved settings or another operation disable it. Saving settings never wakes a sleeping Box: an online provider, model, skill-selection, write-on-behalf, or plugin-selection change recycles only Pi, while an asleep Companion applies it on the next start. Provider changes keep the bundled default when Pi still lists it, otherwise select Pi's first model, and rewrite auth; model-only changes preserve the credential generation. Empty `selected_skill_ids` stages no library skills; the bundled Companion agent skill remains on web/mobile-web Boxes for Skills Hub access. Empty `selected_mcp_account_ids` stages no member MCP pins; detach never disconnects the member's Plugins connection. Native mobile clients get the Companion list and its thread only; Skills, Plugins, and Companion settings stay on web and mobile web. Each member keeps private list preferences on `companion_member_state`: pin order (stable among pins, then unpinned by updated time), an unread badge cleared by opening the thread, and hide (remove from the main list without archiving the Box; unhide from settings or the Hidden section). Owner may duplicate a Companion into a new id with a new Box, copying name, instructions, model, skill selection, and plugin selection, never workspace share. Pi/Box controls, provider catalogs, and desktop chrome remain invisible.

A failed start or stop records one sanitized line in `companions.last_error` beside the `error`
state and returns that same line, so an `Error` status is never a bare word: the thread explains it,
the list carries it on the status pill, and a reload still shows the reason. Only recognized
configuration, Box, Pi, provider, and lifecycle failures explain themselves; anything else stores a
generic line, and credential-shaped text, signed URL query strings, and every line after the first
are removed. Owner and Editor read the recorded reason. A Viewer reads a generic unavailable line
instead, because an operator hint such as a missing `COMPANION_BOX_API_KEY` would only invite a
reader who cannot run Box to try. Any lifecycle write that leaves `error`, including the claim a
retry takes, clears the line.

Pi sessions, RPC events, and logs live only under `~/.companion/runtime` on snapshotted Box disk.
PostgreSQL stores Box id and last-observed lifecycle metadata so list/open never wakes Box. A start
whose assigned Box failed Pi setup, reached its terminal error state, or no longer exists retires
that Box and provisions a replacement, and a start also clears the start-limit failure systemd
latches onto a unit that crash-looped, so no Companion becomes permanently un-wakeable. The daemon
wrapper records its own failures in the log that reason is read from, so a start that dies before Pi
runs still names itself rather than reporting only an exit status. A warm start whose current-layout
unit is already active with its runtime credential file returns without resource injection or a
systemd start. A provider-auth replacement or selected-model change restarts Pi after rewriting its
state; other cold paths keep idempotent `systemctl start` so they do not interrupt an active turn. Desktop URLs are
secret-bearing response-only values minted fresh on every join, VNC stream first and WebRTC as the
fallback, and minting one never creates or resumes a Box. See `docs/companions-runtime.md`.

## Process and database roles

The API and worker use distinct `NOSUPERUSER NOBYPASSRLS NOINHERIT` roles in production. `runtime-role-grants.sql` grants the API narrow pre-tenant/public/skill functions and grants the worker only billing, GitHub sync, and Skill Database cleanup functions. No runtime execution function or table grant remains.

## Deployment

Self-hosted development runs PostgreSQL, S3-compatible storage, and email plus API, worker, and web.
The API needs a Box service key only when Companions lifecycle is enabled; the worker needs no Box,
Vercel, OpenCode, or model-provider credentials. ascii.dev hosts the deployed control plane. Conductor
runs native per-workspace PostgreSQL with optional MinIO/Mailpit as documented in `CLAUDE.md`.
