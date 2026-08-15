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

One wake is bounded. The claim is written before any Box work, so every step after it runs under one
three-minute start budget: object storage reads, Box calls, the waits for a ready Box and an active
Pi, and the final lifecycle write. At the deadline the wake stops working — the same signal cancels
whatever call is in flight and the adapter's poll intervals — and records why, so the Companion leaves
`provisioning` for a retryable `error` carrying that reason. Per-step timeouts alone did not bound a
wake: each call answered inside its own limit while their sum ran for minutes, which is how a send
could leave a Companion reporting Starting against a Box that was doing nothing. Nor was every step
timed at all — a Box whose own record is untouched during the stall places the wake before the first
Box call, where the reads of the skill archives are, and the storage client carries no request
timeout, so a bucket that accepted the connection and then said nothing waited without end. A start that returns
without a running Box and a running Pi is a failure with an observation attached, not a wake still in
flight, so that observation is never written back as `provisioning`.

That recorded failure is the last state the wake writes. Cancellation does not wait for the call it
interrupts, so an abandoned start can still be inside a Box-assignment write, and what that callback
writes is `provisioning`: the failure therefore waits for an assignment already in flight, and refuses
one offered after the deadline. Refusing it is also how the adapter learns no row points at that Box,
which is what puts a Box the wake had just woken back to sleep.

Lifecycle claims are conditional updates. A claim abandoned by a crashed API process becomes
retryable half a minute past that budget — long enough for a live wake to record its own failure
first, and short enough that a process that died writing nothing does not hold the Companion.
Starts recover a Box by its deterministic `Companion <uuid>` name
before creating another one, following every Box-list page. A new Box initially gets a maximum
five-minute TTL; only after its id is durable does the adapter apply the configured TTL and name.
If the id cannot be persisted, the adapter best-effort archives the Box immediately, on a request that
carries no start budget of its own: a spent deadline is the common reason the id was refused, and a
stop that inherited it would put nothing to sleep.

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
| `PATCH` | `/v1/companions/:id` | Recycles Pi for an online provider or model change; never wakes Box |
| `PUT` | `/v1/companions/:id/provider` | Never; owner-only, unconfigured Companions only |
| `GET/PUT/PATCH/DELETE` | `/v1/companions/:id/shares/...` | Never; owner-only |
| `GET` | `/v1/companions/:id/thread` | Never; authorized read-only control-plane projection |
| `POST` | `/v1/companions/:id/messages` | Owner/editor only; persists first, starts when not already running, then delivers |
| `POST` | `/v1/companions/:id/thread/sync` | Owner/editor only; delivers and projects without resuming Box |
| `POST` | `/v1/companions/:id/decisions/:requestId` | Owner/editor only; answer a pending `ask_user` question or settle a legacy approval card |
| `GET` | `/v1/companions/:id/runtime` | Never |
| `GET` | `/v1/companions/:id/runtime?live=true` | Owner/editor only; observes without resuming |
| `POST` | `/v1/companions/:id/runtime/start` | Creates or resumes Box, then starts Pi |
| `POST` | `/v1/companions/:id/runtime/restart` | Owner/editor only; while fully online, recycles Pi or archives and resumes the same Box; never wakes an offline Companion |
| `POST` | `/v1/companions/:id/runtime/stop` | Stops Pi, then snapshots/archives Box |
| `POST` | `/v1/companions/:id/runtime/desktop` | Owner/editor only; never resumes Box |
| `GET` | `/v1/companion-providers` | Never |
| `PUT` | `/v1/companion-providers/:provider` | Never; Owner/Admin only |
| `DELETE` | `/v1/companion-providers/:provider` | Never; Owner/Admin only |
| `PUT` | `/v1/companion-providers/default` | Never; Owner/Admin only |
| `POST` | `/v1/companion-providers/oauth/start` | Never; Owner/Admin only |
| `POST` | `/v1/companion-providers/oauth/complete` | Never; Owner/Admin only |
| `POST` | `/v1/companion-providers/oauth/poll` | Never; Owner/Admin only |
| `GET/POST/DELETE` | `/v1/companion-plugins` | Never; current member's private MCP accounts only |
| `POST/GET` | `/v1/companion-plugins/oauth/start`, `/oauth/callback` | Never; curated MCP pins only, signed PKCE callback |

Desktop responses are secret-bearing and are returned only to the authorized caller. They are never
stored. The response advertises `automation: "lux"`, so computer use is the Box desktop Lux drives
and nothing else; no automation other than Lux may be introduced through it.

Every request mints a fresh URL, because Box rotates the stream token on every Box state change and a
kept URL is one that has already stopped working. The mint asks `POST /boxes/{id}/desktop?vnc=1`
first and prefers that answer for the whole budget: the VNC stream is a plain WebSocket that still
reaches a Box from a network blocking peer-to-peer traffic, and it is the stream a panel can show. A
VNC read with no URL in it is a stream Box has not finished bringing up, whether or not the read also
says `provisioning`, so the mint keeps polling it, and so is a poll that failed on a moment the next
one can find resolved — a busy, timed-out, rate-limited, or server-side answer. `POST
/boxes/{id}/desktop` is the WebRTC fallback and is reached only two ways: the provider refuses
`?vnc=1` outright, so a build that does not know the flag cannot take computer use down with it, or
the budget runs out with no VNC URL to show for it. A WebRTC URL is never taken because it arrived
sooner; the two streams are never raced. The response names which stream a join got in `transport`.
The mint never creates or resumes a Box: a Box outside `ready`, `idle`, or `running` is refused
before any stream is minted for it, which is what keeps opening a desktop surface from being a wake.

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
Companion that is asleep tells its runner to send a message to start it, because a desktop request
cannot resume a Box, and a Viewer reads the chip as text. Opening a thread and beginning a send both
trigger an immediate status read. While a send is open or the projection is transitioning, the web
polls every three seconds; once settled it returns to the slower cadence. An Owner or Editor may use
`GET /v1/companions/:id/runtime?live=true` to observe a Box already projected online, while a Viewer
uses only the control-plane projection. Neither path wakes a Box.

Beside the conversation, the same runner can open a Computer panel that frames that desktop in the
thread, so watching Pi work costs no context switch. The panel is a second pane rather than a change
to the transcript: the assistant-ui primitives, the composer, and the chip all behave exactly as they
do with the panel closed, and below the two-pane breakpoint the panel takes the stage while the header
toggle moves back to the conversation. It joins by the same `POST /v1/companions/:id/runtime/desktop`
route, so opening the panel, reconnecting it, and using `Open desktop` are three joins and three
freshly minted URLs; none is held beyond the join that minted it, and closing the panel, moving to
another Companion, or a Box that stops under the stream each drop it. The desktop is another origin's
document, so it is framed with no top-level navigation and no popups, and the panel prints no part of
the URL. A sleeping Box shows as asleep with guidance to send a message, because a desktop request
cannot resume one. A Viewer is offered neither the panel nor its toggle, and the route refuses
them before a Box client exists, so the panel is not a wake path for anybody.

A Companion the control plane is still resolving is watched more closely on the plain projection
read: every three seconds while its state is `provisioning` or `stopping`, and for the full duration
of an open send that may be starting it. The status chip and composer footer derive from that row, so
they leave Starting together without waiting for the send request to finish or the page to reload.
Watching closely stops as soon as the send and state transition have both settled, `error` included:
that is where a failed lifecycle finishes, and its reason is already on screen. Because these reads
can overlap, each response is kept only while it is the newest for that Companion; an older read that
answers late cannot put a state the Companion has already left back on a chip that reached Online.

## Lifecycle failure reporting

A failure is diagnosable without server logs. A failed start or stop records `runtime_state: error`
together with one sanitized line in `companions.last_error`, and the failing start, stop, and sync
responses carry that same line as `error`, so the operator who initiated the lifecycle and the operator who
reloads later read the same reason.

Only recognized failures explain themselves: Box configuration (`COMPANION_BOX_API_KEY` unset), Box
and Pi provider failures, provider resolution, an exhausted start budget, and lifecycle conflicts. Every other failure — object
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

`POST /v1/companions/:id/messages` is Owner/Editor only and persists first. When a lightweight
runtime observation confirms both Box and Pi are running, it delivers directly without claiming a
lifecycle transition or resolving injection resources. Otherwise it claims the
same lifecycle start as `/runtime/start`: an archived Box resumes and a stopped Pi starts. Delivery then hands
Pi every still-pending message oldest first, not just the new one, so a backlog a sleeping Box missed
keeps its order and never skips the watermark. An undelivered message stays pending under its
idempotency key; if automatic wake fails, the lifecycle records `last_error` and the response keeps
the already-durable turn pending instead of turning the accepted composer action into a second
message. Viewers fail authorization before persistence or Box construction.

Because persistence comes first and the wake it then waits on runs under the three-minute start
budget, this request can legitimately stay open for tens of seconds — ~45–65s for a cold wake, and up
to that budget. Next defaults a rewrite's proxy timeout to 30s in both dev and production, so the
send from the browser was aborted mid-wake and surfaced as a `500` over a turn that was already
durable, and the composer neither cleared nor stopped offering to resend it. `experimental.proxyTimeout`
is raised to sit just past the start budget (three minutes plus the half-minute the failure path
spends recording its reason) so the send outlives a normal wake and returns the API's own answer —
`delivered`, or the durable-but-pending turn — rather than a proxy timeout. It is a bounded ceiling,
not an unbounded wait: every step of a wake already bounds itself against the budget, so a stalled
upstream still returns well inside it. The send route itself never answers a wake with `500`/`504`
within budget — it swallows a failed automatic start and returns the pending turn — so the proxy was
the only 30s cliff on this path; an explicit `/runtime/start` still returns `504` on an exhausted
budget, comfortably inside the raised proxy window.

`POST /v1/companions/:id/runtime/restart` is an operator control, not a wake path. It authorizes an
Owner or Editor before constructing a Box client, then observes Box and Pi without resuming either.
It accepts only a fully online, settled Companion. The default `pi` target reinjects persisted
configuration and recycles only Pi with Box wake disabled. The `box` target stops Pi, archives the
Box, and resumes that same Box through the normal full start path; Settings requires an explicit
confirmation because this interrupts all work on the Box. An asleep, errored, provisioning, or
stopping Companion is refused without contact that could wake it, and lifecycle failures keep using
the existing projected error state and sanitized reason.

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

The composer holds that id beside the draft until the send confirms. A request that never confirmed —
one a proxy gave up on mid-wake, say — left its turn durable under that id, so restoring the draft and
minting a fresh id on the retry would ask the control plane to store the same message under a second
name. Reusing the id keeps the retry idempotent: it resolves to the entry already stored rather than a
second turn. The id is cleared the moment a send confirms and reused only for the identical draft, so
two different messages are still two turns.

`POST /v1/companions/:id/thread/sync` is the single Owner/Editor step that reconciles a live thread.
It hands pending messages to the running Pi daemon in ordinal order through the owner-only
`pi.rpc.in` FIFO, reads `pi.rpc.ndjson` from the recorded byte offset, and appends the projected
entries. `delivered_ordinal` is claimed as soon as Pi accepts a prompt and before the log is read, so
a failed read or projection cannot normally make a retry hand Pi the same message again.
`pi_log_offset` then advances with the projection, and event ids derive from log byte offsets, so a
retried sync appends nothing new. Timeout settlement is the delivery-watermark exception: if a tool
times out with already-watermarked user messages after it and no assistant reply after the tool, the
watermark moves behind that user tail. The next live sync or send prompts those stranded messages in
order, including after Pi has been recycled. A per-thread timeout-recovery ordinal makes that rewind
one-shot and also backfills timeout rows already settled by an older control plane. `pi_log_offset`
only moves backward when Pi's log
shrinks: that read starts at the log's beginning and owns the offset outright. When the Box is
asleep, sync degrades to the same read-model response as the thread read and reports
`source: "control_plane"`.

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

The projection keeps conversation plus the work behind it: Pi assistant text, a system note when a
turn errors or is aborted, and one entry per tool call. Thinking is dropped whenever the turn produced
text; a turn that ended with thinking and no text part at all shows that reasoning as the reply,
because some models answer a short question inside the thinking block. A turn that ends with nothing
visible records a system note instead, so a settled turn is never silence the reader has to interpret
as a hang.

A tool call becomes its own transcript entry rather than being folded into the assistant turn that
made it, so the chip keeps an ordinal and sits between the turns in the order Pi worked. The entry
carries the run in `companion_transcript_entries.tool`, and the `tool` role and that column are
coupled by a check constraint, so no other role can carry a run and a run cannot exist without one.
The run names the call, a kind read from the tool's name (`shell`, `file`, `browse`, `computer`, or a
plain `tool`), a short title, the arguments as truncated detail, and a status that starts `running`.
Pi's tool result then settles it: a result naming its call closes exactly that chip, a harness that
reports no call id closes the oldest chip still running, and a result matching nothing is dropped
rather than guessed at, so a chunk read twice cannot close a run some later call started. A run whose
result never arrives is failed closed after 90 seconds. The staged Pi extension owns the active-turn
deadline for every accepted execution tool and clears all sibling timers before its scoped
`ctx.abort()`, so a later queued follow-up cannot be cancelled by a retry. The control plane never
sends an unscoped
abort into Pi's FIFO: both live sync and the read-only thread fallback settle overdue rows directly,
and a late result and the timeout update compare-and-set only a still-running chip, so whichever
settles it first wins. This closes the chip and the browser's in-flight state without changing Box or
daemon lifecycle, so a stalled tool never turns an Online Companion into Starting or exposes Wake.
If user messages were watermarked after the tool call without a later assistant reply, the same
settlement re-queues that tail in PostgreSQL. Re-queueing neither contacts nor wakes Box, and the
normal live sync or next send delivers the messages before reply state resumes. A narrowly scoped
database definer performs only this deadline CAS and one-shot watermark recovery, allowing a Viewer
read to trigger safe housekeeping under forced RLS without granting Viewers transcript writes.
The extension also refuses image paths before Pi's built-in `read` can enter its vision path;
`ask_user` retains its separate five-minute interactive decision deadline.

A visual run — `browse` or `computer` — is worth a picture, so when one settles (including by the
fail-closed deadline) the sync captures from the Box desktop and stores exactly one frame on that run
as a `data:` URL, bounded to the same size limit the contract enforces. Frame attribution comes only
from the exact run ids whose database settlement won in that sync; replayed or late results cannot
photograph a historical chip. One desktop capture can satisfy several visual runs settled in the
same Pi log chunk, but each run receives at most one stored frame. Capture comes directly from the
Box desktop rather than through Pi `read`; a Box with no desktop, no capture tool, or a capture that
fails simply leaves the chip without a picture rather than failing the sync.
Frames are never uploaded to object storage and never minted as a desktop URL, so a screenshot in the
thread is not a second way to reach a live stream. Because capture happens on the Owner/Editor sync
path, a Viewer reads chips and whatever frames were already stored without any of it touching a Box.

Pi runs its built-in `bash`, `write`, and `edit` tools directly without asking for approval. The
Companion interaction extension only adds `ask_user`: that tool emits an `extension_ui_request` and
blocks until the control plane receives an answer. Sync projects the request as a `decision`
transcript entry carrying the question in `companion_transcript_entries.decision`, coupled to the
`decision` role by a check constraint. Owner and Editor answer or deny through
`POST /v1/companions/:id/decisions/:requestId`, which persists who answered and writes an
`extension_ui_response` to the same FIFO Pi reads for prompts. Timeout is fail-closed at five minutes
on both sides: the extension passes that window to Pi's dialog, and sync expires any question still
pending past `expires_at`. Viewers read resolved questions on the control-plane thread and cannot
act. The contract continues to render and settle shell/file approval cards already stored by an
older runtime, but the current extension never creates new ones. Fire-and-forget extension UI and
prompts minted outside the Companion title grammar (`companion:<kind>:<name>`) are ignored so
third-party extension chrome does not become interactive cards.

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
│   ├── mcp.json           # pi-mcp-adapter config; environment references only
│   └── extensions/        # Companion interaction extension (ask_user)
└── runtime/
    ├── skills/            # exact current packages exposed through Pi native Skills
    ├── sessions/          # Pi session tree files (`pi --session-dir`)
    ├── state/
    │   ├── instructions.txt # optional appended Pi system prompt
    │   ├── mcp-accounts.json # account ids, labels, adapter names, and transports
    │   ├── model.txt       # selected model id passed through `pi --model`
    │   ├── skills.json    # injected surface/version/checksum projection
    │   └── pi.rpc.in      # owner-only FIFO for the Pi JSON RPC stream
    └── logs/
        ├── pi.rpc.ndjson  # Pi JSON RPC output
        └── pi.stderr.log  # Pi's stderr and the daemon wrapper's own account of a failed start
```

Layout version `11` is written to the control-plane row after a successful Skills/MCP-aware start and
to an on-disk marker keyed by the adapter package. Starts repair older Box snapshots before resource
injection. Runtime transcripts and files do not enter PostgreSQL. A systemd user unit supervises Pi
while Box is active; the lifecycle API starts it after a Box resume. Each start also stages the
interaction extension under the legacy `~/.companion/pi/extensions/companion-permission-broker.ts`
path. Reusing that path overwrites older shell/file approval logic; the current extension leaves Pi's
tools unrestricted, refuses image reads, bounds execution tools, and pauses only explicit `ask_user`
questions for a control-plane answer. Layout 11 restarts a warm legacy Pi once after staging because
extensions load at daemon start; that ensures every already-running Box gains the fail-closed guard
instead of retaining layout 10 until an unrelated restart.

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

A ready state is not a machine that answers. `idle` is a resting state the provider's own idle
handling can leave a Box in, and such a Box normally still runs commands, so a start treats it as
ready — but production found Boxes at `idle` that ran nothing while the wake against them reported
`provisioning`. Every step of a start after the Box is ready is a command, so the first of those
commands is also the proof that the machine is listening. A Box that refuses it, by envelope or by
refusing the command endpoint at all, is resumed and asked once more; one that still says nothing
fails the wake with what it said. A Box in a state no resume applies to fails immediately.

A start first checks the warm path when the control-plane row already records the current layout and
provider generation. If the unit is `active` and its tmpfs MCP credential file is present, start
returns that observation without repairing layout, injecting resources, or calling systemd start at
all. This keeps an in-flight turn alive. That warm probe is the start's first command whenever the
start is warm-eligible, so its answer carries the reachability proof too and a warm Box is still
touched exactly once. A layout-only refresh keeps idempotent `systemctl start`, but replacing
`auth.json` uses `systemctl restart` so Pi loads the new provider while the Box stays running.

After Pi accepts at least one durable message through send or sync, the API best-effort PATCHes that
Box with the configured TTL. The default is six hours (`21600` seconds), so every successful message
acceptance resets the provider idle clock. A refused prompt does not move the idle clock, and a TTL
PATCH failure does not turn a durably delivered message into a failed send.

## Pi Skills injection

Pi starts with `--no-skills` so ambient Box or package skills cannot leak into a Companion. For a
web or mobile-web start, the API:

1. resolves the Companion's `selected_skill_ids` allow-list (empty means no library skills);
2. reads each exact current archive from object storage;
3. always stages the bundled Companion agent skill (`companion`) so Pi can talk to the Skills Hub;
4. stages the selected library archives through the Box file API and extracts them into a replacement
   `~/.companion/runtime/skills` tree;
5. starts Pi with that tree as an explicit repeatable native `--skill` source.

Write-on-behalf is a separate Companion setting (`can_write_skills`, default off). When enabled, the
wake mints a short-lived Companion-sourced PAT for the Companion owner with `skills:write` and injects
it as `COMPANION_DELEGATION_TOKEN` (plus `COMPANION_API_URL` / `COMPANION_WORKSPACE_ID`) into the
volatile providers env. When disabled, the PAT carries only `skills:read`; every `skills:write` use
re-checks `can_write_skills` and fails closed if the toggle was turned off. Skills published through
that path are owned by the Companion owner and appear in their Skills Hub library.

When a selected skill is published or updated in Companion, Online Boxes that have it selected are
re-injected and Pi is recycled without recreating the Box. Asleep Boxes apply the new package on the
next wake.

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

Staging and extraction each name what went wrong. Both steps used to record only which step it was,
so one stored `Pi resources failed to prepare` covered a corrupt archive, a disk with no room, and a
tree that would not swap, and the wake that hit it could not be told from a wake that hit any other.
They now carry the exit code and the shell's last word, and because `tar` reports a bad member over
three lines and ends on the one that says nothing, the extract loop appends the slug it was working on
after `tar` has finished complaining — that slug is the line a stored reason has room for.

A write the file API accepted is also checked against what the Box kept. Once the archives are staged,
one command reports the byte count of each, and any that is short of what was sent is written again.
This is why: the wake reported in production died extracting a package on a Box the provider had just
brought back from `idle`, and the identical payload extracted on the very next attempt against that
same Box — a transfer that had not landed rather than a package that could not be read, and repeating
the write is what that second attempt was doing by hand. The measurement is only ever used to repair,
never to refuse. A Box that will not report sizes, or does not report one for some archive, is left to
the extract step exactly as it was before, because a probe added to save a wake must not be able to
cost one that would have worked. A rewrite that will not land is swallowed for the same reason: the
extract is the better judge of whether the tree can be built than a repair that was only an attempt,
and an archive still wrong after being sent again fails extraction, naming itself. Counting bytes
already on the disk is also the cheapest thing a start asks for, so it is asked on a ten-second window
rather than the default minute — a Box too slow to answer it would otherwise spend a large part of the
wake's whole budget on a step whose answer was optional.

The replacement is prepared before the old tree is swapped, and invalid, archived, unpublished,
or inaccessible packages are excluded. The browser chat consumes Pi's normal Skills capability;
Companion does not add Pi tool/skill chrome inside the thread. Native mobile receives no skill
archives or `--skill` source even if a caller supplies stale client state.

## MCP adapter injection

The Box setup installs the pinned `pi-mcp-adapter` package into the isolated
`PI_CODING_AGENT_DIR`. The web and mobile-web Plugins surface stores multiple member-private
accounts per MCP provider, each with a short label such as `work` or `personal` and either an HTTP
or stdio transport. Each Companion then stores an exact `selected_mcp_account_ids` allow-list of
those already-connected accounts. Create and settings multi-select only connected Plugins; empty
means no member MCP pins are staged (the adapter binary remains installed, but `mcp.json` gets no
extra servers). Detach removes an account from that Companion only and never disconnects or revokes
the member's workspace Plugins connection or OAuth grant. The API also retains THE-325's bounded
transient start-request contract. Companion maps the label plus a stable id digest to a unique
adapter server name, so multiple accounts for one MCP provider cannot collide.

Adapter JSON contains only transport metadata and `${ENV_KEY}` references. Plugin credentials are
write-only and envelope-encrypted per member in `companion_mcp_accounts`; ordinary reads expose only
provider, label, transport, endpoint, and timestamps. After Owner/Editor runtime authorization, the
API decrypts only the Companion's attached accounts (owned by the waking member or the Companion
owner) into THE-325's `mcp_credentials` channel. Values cross
the snapshotted disk only as a staged owner-only file, then live in the Box's user runtime tmpfs for
as long as Pi may auto-restart. The systemd unit rereads that file on every start; stop removes it,
and Box stop/reboot destroys the tmpfs. Every referenced env key must have a matching credential. Model-provider
authentication never uses this channel. Host-config discovery, MCP sampling, and MCP elicitation are
disabled. Native-mobile starts discard both saved and caller-supplied MCP accounts.

When an Online Companion's attached plugin list changes in settings, the control plane re-injects MCP
pins and recycles Pi without recreating the Box. Asleep Companions apply the new set on the next wake.

## Provider credentials

Provider management is workspace-scoped and Owner/Admin-only. API keys and one-provider Pi OAuth
entries are encrypted with `COMPANION_SECRETS_MASTER_KEY`; responses, logs, audit metadata, and
Companion rows never contain plaintext. Create and settings validate `model_id` against the selected
provider's live, last-known, or bundled fallback catalog before persisting it. Starting a Companion
resolves only that selected provider and persisted model, decrypts the credential after the
owner/editor wake guard, and writes a minimal owner-only `~/.companion/pi/auth.json` plus
`.companion/runtime/state/model.txt` inside Pi's isolated runtime. The daemon wrapper passes the
selected id through `pi --model`. The start endpoint accepts no model-provider credentials; its only
credential input is the MCP-scoped `mcp_credentials` array.

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

Changing a Companion's provider in settings keeps its bundled default model when pi.dev still lists
it, otherwise selects the first live model, rewrites
`auth.json`, and recycles Pi, not the Box. Changing only the model rewrites `model.txt` and recycles
Pi without replacing provider auth. Both apply immediately when Box and Pi are online, or on the
next start/send when the Box is asleep; PATCH never wakes Box.

Migration `0065` clears `provider_ids` for existing rows. Before it, that column recorded whichever
credential tags a start request carried, including MCP account tags, so no legacy value can name a
workspace connection. Owners attach a real provider afterwards through the one-time route below.

Subscription setup uses Pi's native public-client OAuth protocols without asking an administrator
to copy `auth.json`. Claude uses Anthropic's hosted code callback, not the CLI loopback, and accepts
the one-time PKCE authorization code;
Codex opens ChatGPT's device page and polls the device grant. The API exchanges those short-lived
values and writes the resulting Pi `{ "type": "oauth", ... }` entry directly through the same
envelope-encrypted provider store. Access and refresh tokens are never returned to the browser.
API keys are stored as literal Pi `api_key` entries, so shell-command and environment interpolation
are not accepted.

Provider failures use stable codes suitable for the chat surface:
`provider_not_configured`, `provider_model_invalid`, `provider_auth_invalid`, `provider_auth_expired`, and
`provider_unavailable`. Messages name the provider and the corrective action; raw Pi output and
credential material must remain behind the adapter boundary.

## V1 providers

| Picker label | Pi auth key | Default model | Authentication |
|---|---|---|---|
| Claude | `anthropic` | `claude-opus-4-8` | Anthropic API key or Claude Pro/Max browser OAuth |
| Codex | `openai-codex` | `gpt-5.5` | ChatGPT Plus/Pro device OAuth |
| Kimi | `kimi-coding` | `kimi-for-coding` | Kimi For Coding API key |
| Moonshot | `moonshotai` | `kimi-k2.6` | Moonshot AI API key |
| z.ai | `zai` | `glm-4.7` | z.ai API key, including Coding Plan keys |
| OpenAI API | `openai` | `gpt-5.5` | OpenAI API key |
| Google Gemini | `google` | `gemini-3.1-pro-preview` | Google Gemini API key |

The web picker intentionally shows only this short list. The API and storage key use Pi provider
ids. The provider catalog endpoint fetches `https://pi.dev/api/models/providers/{id}` for these
seven mapped ids concurrently with a 15-second bound, keeps a five-minute process-local last-known
cache, and falls back to the bundled model rows below on a cold failure. The bundled default remains
the default while Pi still lists it; otherwise Pi's first returned model becomes the default. Create
and settings validate the submitted model against that same resolved catalog. To add a provider:

1. verify its auth-file key and supported auth methods against Pi;
2. add one entry with a non-empty fallback model list to `COMPANION_PROVIDER_CATALOG` in
   `packages/contracts/src/companions.ts` and map its pi.dev id in
   `packages/core/src/companionProviderCatalog.ts`;
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
- `COMPANION_BOX_DESKTOP_MINT_BUDGET_MS` (default `15000`) — how long one desktop mint keeps asking
  for a VNC stream Box has not produced yet before it settles for the WebRTC fallback
- `COMPANION_PI_DAEMON_ACTIVE_TIMEOUT_MS` (default `20000`)
- `COMPANION_PI_INSTALL_COMMAND`
- `COMPANION_PI_MCP_ADAPTER_PACKAGE` (default pinned to `npm:pi-mcp-adapter@2.12.1`)

Boxes are always created/resumed with `noEnv: true` and receive only tenant/Companion identifiers.
Preinstall pinned Pi and MCP adapter versions in the Box environment/template when possible.
Otherwise set a pinned, operator-controlled Pi install command; the setup installs the configured
adapter package and fails closed if either dependency is unavailable.
