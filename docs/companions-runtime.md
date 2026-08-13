# Companions runtime

Companion is the control plane; Pi is the only agent harness and runs inside a no-env
[Box](https://box.ascii.dev). The integration uses the Box v1 HTTP API directly and has no Cursor,
OpenCode, or Vercel runtime dependency.

## Control-plane and wake boundary

PostgreSQL stores list/open metadata plus workspace provider connections. Provider credential
payloads are envelope-encrypted in `companion_provider_connections`; ordinary reads expose only the
provider id, authentication method, and timestamps. `GET /v1/companions`,
`GET /v1/companions/:id`, and the default
`GET /v1/companions/:id/runtime` read only this projection and never call Box.

Lifecycle claims are conditional updates. A claim abandoned by a crashed API process becomes
retryable after five minutes; starts recover a Box by its deterministic `Companion <uuid>` name
before creating another one, following every Box-list page. A new Box initially gets a maximum
five-minute TTL; only after its id is durable does the adapter apply the configured TTL and name.
If the id cannot be persisted, the adapter best-effort archives the Box immediately.

One Companion is one Box is one Pi, and that deterministic name is the only evidence of it. A start
adopts a recorded Box id only while the Box carries this Companion's own name, or no name yet — the
window in which a Box the adapter just created is not named until its id is durable. A recorded id
that names a workspace-shared `Companion org <uuid>`/`Companion personal <uuid>` Box or a sibling's
Box is treated as no assignment: the row's Box id is cleared through the same assignment callback so
no stop, live status, or thread sync reaches that machine either, and the Companion is moved onto its
own Box. Such a Box is never renamed or archived, because it is not this Companion's to retire and
another row may still be pointing at it, and an archived one is never resumed. Migration 0075 drops
the same ids from rows the shared-pool restore had copied them onto.

Box setup runs once per disk, so a Box whose Pi setup reports `failed`, that reached the terminal
`error` state, or that the provider no longer knows about can never run Pi again. A start replaces
such a Box instead of failing: it renames the broken Box out of the deterministic name, best-effort
force-stops it so the unusable disk is discarded rather than snapshotted, creates a replacement Box,
and records the new id through the same assignment callback. Renaming happens before the
replacement is created, so no later start can re-adopt the retired disk, and both retirement calls
are best-effort because a Box the provider will not rename or stop must never leave a Companion
permanently un-wakeable. A replacement disk always receives Pi's auth file again, whatever provider
generation the control plane recorded for the Box it replaced, including on a later start that finds
the file missing on a disk an earlier start had already assigned. A Box that is merely still
provisioning, including one whose setup is `pending` or `running`, is waited on as before.

Each Companion has one immutable Owner, an optional workspace-wide Editor/Viewer grant, and
member-specific Editor/Viewer grants. A member grant overrides the workspace default. Only the Owner
manages sharing or the selected provider. Owner and Editor may chat and use lifecycle, plugin
injection, live status, and desktop routes. Viewer is read-only: authorization completes before
skill storage or a Box adapter is created.

Runtime starts identify their client surface as `web`, `mobile_web`, or `native_mobile`. Web and
mobile-web starts resolve the actor's Installed library (personal skills they own plus organization
skills they installed) and inject only valid current packages. Native-mobile starts always inject
an empty skill set. This is enforced by the API and again by the Box adapter before Pi is started.

| Method | Path | Box contact |
|---|---|---|
| `POST` | `/v1/companions` | Never |
| `GET` | `/v1/companions` | Never |
| `GET` | `/v1/companions/:id` | Never |
| `PUT` | `/v1/companions/:id/provider` | Never; owner-only, unconfigured Companions only |
| `GET/PUT/PATCH/DELETE` | `/v1/companions/:id/shares/...` | Never; owner-only |
| `GET` | `/v1/companions/:id/thread` | Never; authorized read-only control-plane projection |
| `POST` | `/v1/companions/:id/messages` | Owner/editor only; persists first, starts through the warm lifecycle path, then delivers |
| `POST` | `/v1/companions/:id/thread/sync` | Owner/editor only; delivers and projects without resuming Box |
| `GET` | `/v1/companions/:id/runtime` | Never |
| `GET` | `/v1/companions/:id/runtime?live=true` | Owner/editor only; observes without resuming |
| `POST` | `/v1/companions/:id/runtime/start` | Creates or resumes Box, then starts Pi |
| `POST` | `/v1/companions/:id/runtime/stop` | Stops Pi, then snapshots/archives Box |
| `POST` | `/v1/companions/:id/runtime/desktop` | Owner/editor only; never resumes Box |
| `GET` | `/v1/companion-providers` | Never |
| `PUT` | `/v1/companion-providers/:provider` | Never; Owner/Admin only |
| `DELETE` | `/v1/companion-providers/:provider` | Never; Owner/Admin only |
| `PUT` | `/v1/companion-providers/default` | Never; Owner/Admin only |
| `GET/POST/DELETE` | `/v1/companion-plugins` | Never; current member's private MCP accounts only |

Desktop responses are secret-bearing and are returned only to the authorized caller. They are never
stored. The response advertises `automation: "lux"`, so computer use is the Box desktop Lux drives
and nothing else; no second computer-use surface may be added beside it.

The web chat header carries that boundary as one chip. It reads `Box · online`, `Box · starting`,
`Box · asleep`, or `Box · error` from the same runtime state the list and sidebar show, and for an
Owner or Editor whose Box is already running the chip itself requests the desktop and opens the
returned URL in a new tab. Because a browser only honours a tab the click itself asked for, the click
claims an `about:blank` tab before the request and points it at the URL when it answers. The claim
names `about:blank` rather than the empty URL, which a browser may read as the current page and so
leave a copy of the app behind instead of a tab to hand off, and the claimed tab disowns the thread
only once it is on its way to the desktop, because severing that handle first can detach the tab and
leave the handoff silently unmade. A still-provisioning Box, a blocked tab, or a refused handoff
closes that tab and states why on the thread without ever naming the secret-bearing URL. That reason is held apart from the thread's own load failure, so the
two-second refresh of an awake thread cannot clear it and leave a failed handoff looking like nothing
happened. The URL is used once and never stored by the browser surface either. A
Companion that is asleep offers Wake instead, because a desktop request cannot resume a Box, and a
Viewer reads the chip as text: their thread polls only the control-plane projection, while a runner's
open thread refreshes `GET /v1/companions/:id/runtime?live=true` on a slow interval, so a stale chip
is corrected by an observation rather than by a wake.

## Lifecycle failure reporting

A failure is diagnosable without server logs. A failed start or stop records `runtime_state: error`
together with one sanitized line in `companions.last_error`, and the failing start, stop, and sync
responses carry that same line as `error`, so the operator who pressed Wake and the operator who
reloads later read the same reason.

Only recognized failures explain themselves: Box configuration (`COMPANION_BOX_API_KEY` unset), Box
and Pi provider failures, provider resolution, and lifecycle conflicts. Every other failure — object
storage, PostgreSQL, an unexpected adapter fault — records a generic line, so internal text cannot
reach a stored row or a response. Sanitizing keeps the first line only, redacts credential-shaped
text and the query string of any URL, and truncates to one status line.

`runtime.last_error` is returned only while the state is `error`. Owner and Editor read the recorded
reason. A Viewer reads a generic unavailable line instead: a Viewer never runs Box, so a hint about a
missing service key would only invite them to try. Any lifecycle write that leaves `error` — a
successful start, a live observation, or the claim a retry takes — clears the line, so a recovered
Companion never keeps explaining a failure it already retried past.

## Chat thread

One Companion owns exactly one thread; there are no rooms and no multi-party chats.
`companion_threads` holds that thread's ordinal counters and delivery watermarks, and
`companion_transcript_entries` holds its messages. Both are control-plane tables, so the whole
conversation is readable without Box.

`GET /v1/companions/:id/thread` reads PostgreSQL only. A Viewer opening a thread therefore never
reads Box disk, starts Pi, or wakes Box, and the payload carries `can_send: false` so the surface
renders read-only.

A shared thread has several writers, so each user message records its author
(`companion_transcript_entries.author_id`) and the payload carries the reading member as
`viewer_id`. Only a reader's own messages render as their own; a teammate's message keeps that
teammate's name. Pi output carries no author.

`POST /v1/companions/:id/messages` is Owner/Editor only and persists first. It then claims the same
lifecycle start as Wake: an archived Box resumes, a stopped Pi starts, and an already-active
layout-6 Pi takes the warm path without resource injection or a systemd start. Only after that start
does delivery hand Pi every still-pending message oldest first, not just the new one, so a backlog a
sleeping Box missed keeps its order and never skips the watermark. An undelivered message stays
pending under its idempotency key; if automatic wake fails, the lifecycle records `last_error` and a
composer retry resumes the same durable turn instead of storing another one. Viewers fail
authorization before persistence or Box construction.

One send is one turn. The sender names the message it is creating with `client_message_id`, a UUID,
and the control plane stores it as that entry's event id (`msg:<client_message_id>`), so the
transcript's `(companion_id, event_id)` primary key is what decides how many turns a send produces.
The same send arriving twice — a retried request, one a proxy replayed, a client that submitted twice
— resolves to the turn already stored instead of a second copy of it, and because that message is no
longer pending it is never handed to Pi again either, so the reply cannot be produced twice. A send
that is durable but undelivered is still pending, so resending it completes the delivery its first
attempt never made. Sent messages and projected Pi events keep separate id namespaces (`msg:` against
`pi:`), so a sender can never name an entry the log will claim later. A request without the id is
still accepted and gets a server-generated one, which is the pre-THE-337 behavior and carries no
protection; the web composer always sends one, and it is the same id the message carries on screen
before the control plane answers, so an optimistic message and its saved entry are one message.

`POST /v1/companions/:id/thread/sync` is the single Owner/Editor step that reconciles a live thread.
It hands pending messages to the running Pi daemon in ordinal order through the owner-only
`pi.rpc.in` FIFO, reads `pi.rpc.ndjson` from the recorded byte offset, and appends the projected
entries. `delivered_ordinal` is claimed as soon as Pi accepts a prompt and before the log is read, so
a failed read or projection cannot make a retry hand Pi the same message again. `pi_log_offset` then
advances with the projection, and event ids derive from log byte offsets, so a retried sync appends
nothing new. Both watermarks only move forward, except when Pi's log shrank: that read starts at the
log's beginning and owns the offset outright. When the Box is asleep, sync degrades to the same
read-model response as the thread read and reports `source: "control_plane"`.

One sync reads at most 256 KiB of that log, and the projection consumes whole lines only, so a busy
thread arrives across consecutive syncs and a chunk cut mid-line leaves the remainder to the next
read. A log that is missing, that cannot be read, or whose size the Box will not report is an empty
read rather than a failure, because none of those mean the thread is broken; the unreadable ones keep
the offset the sync came in with instead of rewinding and reprojecting the transcript. The read opens
by printing the offset its bytes start at, and that line is what makes the rest a chunk: a reader that
stops partway — because it hit the read limit, or because whatever captured the command's output
stopped accepting bytes before it — still produced a chunk plus the point the next sync resumes from,
so neither the Box script nor the adapter treats it as a failed read. Only output with no offset line
in it means the Box never ran the read, and only that fails, carrying the exit status and the last
line the Box printed.

The projection deliberately keeps only conversation: Pi assistant text, plus a system note when a
turn errors or is aborted. Tool calls and tool results are dropped, so no Pi tool or Skills chrome
reaches the thread UI. Thinking is dropped the same way whenever the turn produced text; a turn that
ended with thinking and no text part at all shows that reasoning as the reply, because some models
answer a short question inside the thinking block. A turn that ends with nothing visible records a
system note instead, so a settled turn is never silence the reader has to interpret as a hang. A
mid-turn tool step carries no visible content either and stays out of the thread.

Delivery reads the pending list before it claims the watermark, so two requests that overlap inside
that window can hand Pi the same prompt twice. One client cannot do this: the web surface runs its
sends and syncs one at a time, skipping a poll that an in-flight request already covers. Two clients
syncing the same thread in the same instant still can, and V1 accepts that: the transcript stays
correct because projection is keyed by log byte offset, and the visible cost is a repeated prompt.

## Box disk layout

Box stop archives the disk, so runtime sessions survive stop/resume at:

```text
~/.companion/
├── bin/pi-daemon
├── pi/                    # isolated PI_CODING_AGENT_DIR
│   ├── auth.json          # owner-only Pi API key or refreshable OAuth entry
│   └── mcp.json           # pi-mcp-adapter config; environment references only
└── runtime/
    ├── skills/            # exact current packages exposed through Pi native Skills
    ├── sessions/          # Pi session tree files (`pi --session-dir`)
    ├── state/
    │   ├── mcp-accounts.json # account ids, labels, adapter names, and transports
    │   ├── skills.json    # injected surface/version/checksum projection
    │   └── pi.rpc.in      # owner-only FIFO for the Pi JSON RPC stream
    └── logs/
        ├── pi.rpc.ndjson  # Pi JSON RPC output
        └── pi.stderr.log  # Pi's stderr and the daemon wrapper's own account of a failed start
```

Layout version `6` is written to the control-plane row after a successful Skills/MCP-aware start and
to an on-disk marker keyed by the adapter package. Starts repair older Box snapshots before resource
injection. Runtime transcripts and files do not enter PostgreSQL. A systemd user unit supervises Pi
while Box is active; the lifecycle API starts it after a Box resume.

MCP credential values are not part of that snapshotted tree. A start stages them through the
owner-only Box file channel, moves the file into `%t/companion/providers.env` in the systemd user
runtime tmpfs, and removes the staged disk copy before it returns. The unit reads that same tmpfs
file on every `ExecStart`, so `Restart=on-failure` does not silently come back without MCP servers.
An explicit stop removes it after Pi is down, and Box stop/reboot destroys the runtime tmpfs.

A start repairs the layout of a Box that already exists by running the same script the create path
uses, and it runs it the same way: the script is staged onto the disk through the file API as
`~/.companion/bin/ensure-pi-layout.sh`, and the only thing handed to the command API is the short
`bash "$HOME/.companion/bin/ensure-pi-layout.sh"`. The identical text sent directly as a command
string does not survive that transport — it carries heredocs, nested single and double quotes, and
several kilobytes — which is how a Box whose disk was already correct still reported `Pi runtime
layout failed to install`. Layout failures now record the command's exit code and the last line the
shell emitted, so the next one names itself instead of costing a production probe.

The script checks the on-disk marker before anything else, so repairing a Box that is already at
`<layout version>:<adapter package>` costs one file read and cannot fail on a dependency it does not
need. When a relayout is genuinely required it resolves Pi's absolute path, bakes that path into the
daemon wrapper, and pins the unit's `Environment=PATH` to Pi's bin directory, because the systemd
user manager gives the supervised daemon a minimal PATH that a login shell's would never match.

The create `setupScript` installs Pi, writes the daemon wrapper, and writes the systemd user unit,
and it deliberately runs no user-manager command. A Box executing its create script has no user D-Bus
session, so `systemctl --user` there fails with `Failed to connect to bus: No medium found` and marks
the whole setup `failed` even when Pi installed correctly. Loading the unit is therefore deferred to
the post-ready control-plane command that starts Pi. That command locates the bus itself: every Box
command runs in its own shell, so it exports `XDG_RUNTIME_DIR`, and when the user manager still does
not answer it enables lingering for the account, asks the system manager to start `user@<uid>`, and
waits briefly before failing with a message that names the missing user bus. Stopping is idempotent
for the same reason: a Box that never started Pi has no loaded unit, so only a daemon still active
after the stop attempt is reported as a failure.

A successful `systemctl --user start` only means systemd accepted the job. The unit is
`Type=simple` with `Restart=on-failure`, so a daemon that is merely slow to open its RPC FIFO and one
that is crash-looping both answer `activating` for the first seconds, and reading a single `is-active`
probe as the verdict turned healthy starts into `Pi daemon is not running after start` wakes. A start
therefore polls `is-active` for up to `COMPANION_PI_DAEMON_ACTIVE_TIMEOUT_MS` (20s by default) at the
Box poll interval and returns running on the first probe that observes `active`. Between restart
attempts the unit reports `failed` rather than `activating`, so the poll runs to its deadline instead
of ending on the first answer that is not `active`. The window also outlasts systemd's own
`StartLimitBurst`, which gives up after five `RestartSec=2` attempts: a daemon that is genuinely
crash-looping reaches its terminal `failed` state inside the window, so the wake reports that verdict
rather than a start still in flight. A daemon that never
gets there fails the wake with what the Box actually reported: the unit's `Active:` line from
`systemctl --user status`, the `code=exited, status=` detail systemd recorded for the process, the
restart count systemd is keeping, the last non-empty line of
`~/.companion/runtime/logs/pi.stderr.log`, and the last thing the unit's journal said, gathered by one
command that reads neither the provider auth file nor the transient MCP credential file.

The restart count is what separates a Pi that is merely slow to start from one that keeps dying and
being brought back, and it is stored whenever it is not zero: the wake that motivated this reported
`activating`, an auto-restart, and `exit 1`, and nothing in that line said whether the daemon had
died once or five times.

The daemon wrapper reports its own failures. It redirects its stderr into Pi's stderr log before it
does anything that can fail and writes one line naming the invocation it is about to make, so a start
that dies before `exec` — a directory it cannot create, a FIFO it cannot replace, a Pi binary it
cannot run — names the failing line and command in the log the control plane reads, and a Pi that
dies without complaining is still attributable to the command it was. Redirecting only Pi left those
failures in the journal alone with the log's timestamp untouched, which is how a crash-looping wake
reported an exit status and no reason at all. A crash loop appends a line every couple of seconds, so
the wrapper rolls the log aside once it passes 1 MiB rather than growing it until the disk notices.

Fragments claim the stored line in priority order — `Active:`, the exit status, the restart count,
the Pi stderr line, then the journal line — and one the Box had nothing to say for spends nothing.
`is-active` prints the same word `Active:` opens with, so it is stored only for a unit whose status
the Box would not print, and the `Active:` line's trailing timestamp is dropped because the control
plane already knows when it asked; both were spending room the reason needed. A systemd `Process:` or
`Main PID:` line opens with the full `ExecStart` path and closes with the code that matters, so its
`(code=…)` is parsed out first and only that token is then clamped to its budget; clamping the raw
line would have dropped the code and kept the path. The status lines are selected by what they say
rather than by where they landed, so a unit that prints only one of them cannot have it read as the
other, and the diagnostic runs under `LC_ALL=C` so those names are the ones the Box prints. A quoted
fragment left too short to read is dropped whole instead of stored as a stub; a count is stored at
whatever length fits, because its digits are all of what it has to say.

Pi's stderr log and the journal are both read only for the couple of minutes around this start. They
outlive the start that wrote them, so an untouched log still holds whatever an earlier run left
behind; without a freshness window a line from hours ago would be reported as the reason a wake just
failed. The journal is read last and only for what systemd could not have written down elsewhere: its
narration of ordinary starts and stops is dropped, so what survives is a unit systemd refused to
execute, a process the kernel killed, or a restart loop systemd gave up on. The result fits the single
sanitized line `companions.last_error` stores.

A cold start clears any latched start-limit failure before it starts the unit. systemd stops restarting
a unit that failed too often and refuses every later start until that failure is cleared, so a
Companion that crash-looped once answered the next wake with systemd's own rate-limit complaint
instead of a real start attempt, for as long as the Box lived. Neither the poll nor the failure stops,
archives, or retires the Box: only a Box already beyond recovery — terminal `error` state or failed
Pi setup — is replaced, and that decision is made before the daemon is ever started.

A start first checks the warm path when the control-plane row already records the current layout and
provider generation. If the unit is `active` and its tmpfs MCP credential file is present, start
returns that observation without repairing layout, injecting resources, or calling systemd start at
all. This keeps an in-flight turn alive. The first start after a layout or credential change still
refreshes the files, but uses idempotent `systemctl start`, never `restart`, so an active unit is not
killed during the upgrade. An already-running process keeps the environment it inherited; refreshed
layout and MCP environment take effect on its next automatic start or after an explicit stop/wake.

After Pi accepts at least one durable message, the API PATCHes that Box with the configured TTL. The
default is six hours (`21600` seconds), so provider idle expiry is measured from the last successful
message rather than from provisioning, resume, or an explicit Wake. A refused prompt does not move
the idle clock.

## Pi Skills injection

Pi starts with `--no-skills` so ambient Box or package skills cannot leak into a Companion. For a
web or mobile-web start, the API:

1. resolves the authorized actor's Installed library in the tenant transaction;
2. reads each exact current archive from object storage;
3. stages the archives through the Box file API and extracts them into a replacement
   `~/.companion/runtime/skills` tree;
4. starts Pi with that tree as an explicit repeatable native `--skill` source.

The file API takes one whole body per JSON request, refuses content over 5 MiB, and offers no
append, multipart, or streaming write, so a base64 archive of a few megabytes cannot be written in a
single call — which is how a wake that had already laid the disk out died with `File is too large for
write_file`. Any payload at or over the cap is therefore staged as `<path>.part<n>` writes, each a
base64 slice a megabyte clear of the limit, and one short `cat` command joins the parts back into
`<path>` and removes them. Parts are split on byte boundaries and sent base64, so a payload that is
not plain ASCII cannot lose a character to the split, and the payload itself never travels as a
command string. Smaller files stay one plain write. Skills are never skipped or truncated to fit, and
the extract loop still reads exactly `~/.companion/runtime/state/skill-archives/*.tar.gz.b64`, which
no part file matches. A rejected write now names the file it was writing, because the provider's
message carries the limit it enforced but not the path.

The replacement is prepared before the old tree is swapped, and invalid, archived, unpublished,
or inaccessible packages are excluded. The browser chat consumes Pi's normal Skills capability;
Companion does not add Pi tool/skill chrome inside the thread. Native mobile receives no skill
archives or `--skill` source even if a caller supplies stale client state.

## MCP adapter injection

The Box setup installs the pinned `pi-mcp-adapter` package into the isolated
`PI_CODING_AGENT_DIR`. The web and mobile-web Plugins surface stores multiple member-private
accounts per MCP provider, each with a short label such as `work` or `personal` and either an HTTP
or stdio transport. The API also retains THE-325's bounded transient start-request contract.
Companion maps the label plus a stable id digest to a unique adapter server name, so multiple
accounts for one MCP provider cannot collide.

Adapter JSON contains only transport metadata and `${ENV_KEY}` references. Plugin credentials are
write-only and envelope-encrypted per member in `companion_mcp_accounts`; ordinary reads expose only
provider, label, transport, endpoint, and timestamps. After Owner/Editor runtime authorization, the
API decrypts the current member's accounts into THE-325's `mcp_credentials` channel. Values cross
the snapshotted disk only as a staged owner-only file, then live in the Box's user runtime tmpfs for
as long as Pi may auto-restart. The systemd unit rereads that file on every start; stop removes it,
and Box stop/reboot destroys the tmpfs. Every referenced env key must have a matching credential. Model-provider
authentication never uses this channel. Host-config discovery, MCP sampling, and MCP elicitation are
disabled. Native-mobile starts discard both saved and caller-supplied MCP accounts.

## Provider credentials

Provider management is workspace-scoped and Owner/Admin-only. API keys and one-provider Pi OAuth
entries are encrypted with `COMPANION_SECRETS_MASTER_KEY`; responses, logs, audit metadata, and
Companion rows never contain plaintext. Starting a Companion resolves only its selected provider,
decrypts the credential after the owner/editor wake guard, and writes a minimal owner-only
`~/.companion/pi/auth.json` inside Pi's isolated agent directory before restarting Pi. The start
endpoint accepts no model-provider credentials; its only credential input is the MCP-scoped
`mcp_credentials` array.

Companions created before provider support may have no provider id. Their owner can attach one
connected provider once through `PUT /v1/companions/:id/provider`; this does not contact or wake Box.
After a provider is attached it is immutable, matching the creation flow.

The auth file remains on snapshotted Box disk because Pi must update refreshable subscription
tokens. Reconnecting or disconnecting a provider replaces or removes the control-plane copy; the
next start replaces the Box file with only the selected provider. Later starts preserve Pi's
possibly refreshed OAuth entry, and skip the rewrite only for a Box this Companion already
provisioned at the current disk layout whose recorded credential generation still matches. A new
Box, an older layout, or a rotated connection always rewrites the file. The disk is the final
authority: the staging step reports whether `auth.json` exists, and a start rewrites the file
whenever it does not, so a replacement disk provisioned by an earlier start that failed before Pi
was configured cannot inherit a recorded generation it never satisfied. Start fails closed when the
file is absent, and a failed injection or systemd start command best-effort removes both staged and
runtime `mcp_credentials` files. A later active-wait timeout keeps the runtime file because systemd
may still recover Pi through `Restart=on-failure`; explicit stop and Box stop/reboot remain its
cleanup boundary.

Migration `0065` clears `provider_ids` for existing rows. Before it, that column recorded whichever
credential tags a start request carried, including MCP account tags, so no legacy value can name a
workspace connection. Owners attach a real provider afterwards through the one-time route below.

Subscription setup deliberately reuses Pi's authentication implementation. Run `/login` with the
same pinned Pi version on a trusted machine, then submit only that provider's `{ "type": "oauth",
... }` entry from Pi's `auth.json`. Never submit the whole auth file. API keys are stored as
literal Pi `api_key` entries, so shell-command and environment interpolation are not accepted.

Provider failures use stable codes suitable for the chat surface:
`provider_not_configured`, `provider_auth_invalid`, `provider_auth_expired`, and
`provider_unavailable`. Messages name the provider and the corrective action; raw Pi output and
credential material must remain behind the adapter boundary.

## V1 providers

| Picker label | Pi auth key | Authentication |
|---|---|---|
| Claude | `anthropic` | Anthropic API key or Claude Pro/Max Pi OAuth entry |
| Codex | `openai-codex` | ChatGPT Plus/Pro Pi OAuth entry |
| z.ai | `zai` | z.ai API key, including Coding Plan keys |

The web picker intentionally shows only this short list. The API and storage key use Pi provider
ids and accept any valid lowercase Pi provider id, so another built-in provider can be connected
without a schema change. To add one to the picker:

1. verify its auth-file key and supported auth methods against the pinned Pi `providers.md`;
2. add one entry to `COMPANION_PROVIDER_CATALOG` in `packages/contracts/src/companions.ts`;
3. add contract and Box adapter coverage for its auth entry;
4. update this table.

## Configuration

`COMPANION_BOX_API_KEY` is required for live lifecycle calls. Missing credentials produce a
configuration error without fabricating a Box.

Optional settings:

- `COMPANION_BOX_API_BASE` (default `https://ascii.dev/api/box/v1`)
- `COMPANION_BOX_ENVIRONMENT`
- `COMPANION_BOX_TTL_SECONDS` (default `21600`)
- `COMPANION_BOX_POLL_INTERVAL_MS` (default `1000`)
- `COMPANION_BOX_READY_TIMEOUT_MS` (default `120000`)
- `COMPANION_PI_DAEMON_ACTIVE_TIMEOUT_MS` (default `20000`)
- `COMPANION_PI_INSTALL_COMMAND`
- `COMPANION_PI_MCP_ADAPTER_PACKAGE` (default pinned to `npm:pi-mcp-adapter@2.12.1`)

Boxes are always created/resumed with `noEnv: true` and receive only tenant/Companion identifiers.
Preinstall pinned Pi and MCP adapter versions in the Box environment/template when possible.
Otherwise set a pinned, operator-controlled Pi install command; the setup installs the configured
adapter package and fails closed if either dependency is unavailable.

