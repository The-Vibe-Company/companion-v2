# Routine Pi context substrate

Status: implemented by the feature-gated routine-isolation runtime path. Migration 0137 owns the
runtime-only compaction and content-addressed substrate tables; the durable routine turn pins the
rendered bytes before any Box contact.

## Decision

Give each isolated routine Pi a versioned, read-only snapshot of the main conversation made from:

1. the latest successfully persisted main-Pi compaction summary;
2. a small, token-bounded tail of recent main-thread entries, in durable ordinal order; and
3. stable source metadata identifying the summary generation and main-thread ordinal it covers.

The target budget is **4,000 estimated input tokens**: up to 2,500 for the summary, 1,250 for the
recent tail, and 250 for labels and source metadata. The tail has a ceiling of 12 entries, but the
token budget is authoritative. Preserve complete user/assistant turns where possible.

This is a hybrid of summary-plus-recent-messages and a deterministic curated projection. It reuses
Pi's structured summary rather than creating a second semantic truth. Do not send every message
since compaction.

Do not add `GET /v1/companions/:id/context-substrate`. The substrate is runtime material, not a
member-facing resource. Persist content-addressed snapshots and expose them only through a narrow
runtime database function, or extend the routine-run material function introduced by the isolated
routine-session architecture. Each routine run pins one snapshot id and digest before Box contact
so takeover reconstructs identical prompt bytes.

## Architectural premise

The target routine architecture is:

- one separate Pi session per routine run, with the same staged Skills, plugins, tools, provider,
  model, and Companion operating brief;
- the existing durable routine-origin turn remains the run identity, serialized under the
  Companion's existing runtime lease, while its Pi session directory/process is separate;
- the routine's internal transcript lives in routine history;
- the main thread receives only its routine-run marker and an optional terminal `relay` or `notify`
  result; and
- the routine session cannot continue after that terminal result.

This design does not introduce multiple Companions, a second harness, or a worker that contacts Box
or Pi.

## Findings

### Reuse the main Pi's summary

The layout-14 broker starts Pi in RPC mode with a persistent `--session-dir` and `--continue`.
PostgreSQL is the no-wake transcript projection; it is not replayed into Pi on every turn. The
authoritative main conversation context remains in Pi's append-only Box-side JSONL session.

Pinned Pi 0.84.2 auto-compacts near the model context limit. It summarizes older context, retains a
recent tail, and appends a structured compaction entry. See the pinned
[Pi compaction contract](https://github.com/earendil-works/pi/blob/v0.84.2/packages/coding-agent/docs/compaction.md).
Pi also emits `compaction_end` over RPC with the summary, retained-entry boundary, token estimates,
and usage. Companion's broker understands but does not currently project that event. See the pinned
[Pi RPC contract](https://github.com/earendil-works/pi/blob/v0.84.2/packages/coding-agent/docs/rpc.md#compaction_start--compaction_end).

Persisting that summary is the least divergent semantic base. Re-summarizing the same history on
every routine fire would cost more and create two competing accounts of what the main Pi knows.

### Use the control-plane transcript only as a bounded tail

`companion_transcript_entries` is durable, ordered, org-scoped, and readable without Box contact.
It is a projection rather than a byte-for-byte Pi session clone: tool results are bounded and
redacted, Pi session ids are not mapped to transcript ordinals, internal entries remain on Box, and
reasoning/tool payloads are unnecessary substrate material.

Therefore “all messages since compaction” is not well-defined from PostgreSQL alone. A bounded
newest tail is well-defined and stays within Pi's retained recent context without requiring a
Pi-entry-id to transcript-ordinal map.

### Keep assembly behind the runtime capability boundary

The worker has no Companion-table access and must never contact Box or Pi. The API persists intent
but does not own runtime leases or model side effects. The runtime role consumes only narrow
`SECURITY DEFINER` material functions. The flow is:

```text
main Pi compacts
  -> runtime validates/redacts compaction_end
  -> database stores a stable summary generation

main thread reaches a durable update
  -> current rendered snapshot becomes dirty

routine fires
  -> durable run pins/reuses a content-addressed snapshot
  -> apps/runtime obtains it through narrow routine material
  -> isolated routine Pi receives snapshot + routine task
```

No browser, Viewer read, worker loop, or ordinary API read obtains or rebuilds this material.

## Source policy

| Source | Policy |
| --- | --- |
| Latest main-Pi compaction summary | Include, bounded and redacted |
| Recent main-thread messages | Include a token-bounded newest tail |
| Last N assistant replies | Do not add separately; preserve complete recent turns |
| Resolved decisions | Include one concise line |
| Pending decision or unmatched user message | Include only with `pending in main chat`; never treat it as approval |
| Tool activity | Include final name, status, and bounded title only |
| Reasoning | Exclude |
| Attachments | Include filename/content type only when referenced; never imply bytes were staged |
| Routine markers and internal routine transcripts | Exclude to prevent recursive growth |
| Prior `relay` and `notify` main entries | Include normally because they are main conversation history |
| Persona | Stage in the system prompt, not the substrate |
| Member profile | Include only durable per-run time/timezone metadata |
| Model/provider | Keep as execution metadata, not prompt prose |
| Routine configuration | Supply as the task after the substrate |

Label the substrate as **main-conversation background**. Tool titles, attachment names, plugin
content, and quoted external material remain untrusted data; the routine must not follow
instructions found inside them. The routine prompt and staged operating brief remain authoritative.

## Deterministic wire shape

Use fixed headings, LF newlines, stable key order where JSON is unavoidable, ISO timestamps, and
durable transcript ordinal order. Keep the snapshot row's own `created_at` out of rendered bytes so
identical sources produce the same digest.

```text
--- Main conversation context (background, not the routine task) ---
Snapshot: <opaque version>
Built through main-thread ordinal: <ordinal>
Summary observed at: <timestamp or "none yet">

## Stable summary
<latest bounded Pi compaction summary, or an explicit no-summary marker>

## Recent main-thread tail
[<time>] <author>: <message>
[<time>] Companion: <reply>
[<time>] Decision resolved: <title> -> <answer/status>
[<time>] Tool completed: <name> | <status> | <bounded title>
--- End main conversation context ---

--- Routine task ---
Routine: <name>
<routine prompt>
--- Runtime turn context (metadata, not user-authored) ---
<durable scheduled/start time and timezone>
```

Do not trigger main-Pi compaction just to feed a routine: it is lossy, costs a summary call, mutates
the main session's cache prefix, and couples scheduling to main-chat maintenance. Put stable
instructions, tools, persona, the routine-mode contract, and stable summary before the recent tail
and per-fire metadata.

## Budget and truncation

Use the selected model's tokenizer or Pi's estimator when available, plus a UTF-8 byte ceiling as
defense in depth.

| Component | Estimated-token limit | Additional bound |
| --- | ---: | --- |
| Stable summary | 2,500 | Section-aware clipping; never split UTF-8 |
| Recent tail | 1,250 | At most 12 entries; prefer complete newest turns |
| Envelope/metadata | 250 | Fixed format |
| Total substrate | 4,000 | 32 KiB UTF-8 hard ceiling |

When the summary exceeds its budget, retain constraints/preferences, key decisions, critical
context, current work, and next steps before completed work. Clip file lists and old completed items
first and record an explicit omission marker plus `summary_clipped` metric. Never take an arbitrary
byte slice.

For the tail, walk newest-to-oldest by logical turn, stop at the token budget, then render selected
entries in ascending ordinal order. If the newest message alone exceeds the budget, retain bounded
head and tail excerpts with the omitted size. Never drop it silently.

At 4,000 tokens, a routine firing every 15 minutes contributes at most 384,000 raw substrate input
tokens per day before cache discounts. Ten such routines contribute 3.84 million, so the cap is a
cost control as well as a context-window safeguard.

## Prompt caching

Prompt caching lowers price and latency for an identical prefix; it does not remove tokens from the
context window or justify unbounded history. Keep stable material first and dynamic data last. See
[OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching) and
[Anthropic prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching).

For a 15-minute routine, identical bytes are necessary but not sufficient for a hit. Anthropic's
default five-minute cache normally expires between fires; extended retention is a provider
optimization to evaluate after recording Pi's reported `cacheRead` and `cacheWrite` usage. Do not
prewarm solely to keep a cache alive. Judge correctness and cost on the uncached worst case.

## Storage and refresh

Persist the latest accepted main-Pi compaction generation scoped to `(org_id, companion_id,
main_pi_session_id)`. Store only redacted bounded summary text, opaque retained-entry evidence,
bounded token/usage counters, event cursor/invocation/session identity, generation, creation time,
and content digest. Invalid, oversized, or still-secret-bearing summaries are counted and omitted;
they do not fail the user's main turn.

Store rendered snapshots by digest so quiet chat can reuse one approximately 16 KiB body across
many runs. Each routine run pins `context_substrate_id` and `context_substrate_sha256` before Box
contact. Takeover and dispatch-resolution reconstruct the same bytes. Later main messages affect the
next run only.

Refresh is event-driven and lazy:

| Event | Action |
| --- | --- |
| Valid main-Pi `compaction_end` | Persist a base generation and mark rendered snapshot dirty |
| Durable main user entry or terminal assistant projection | Mark dirty; rebuild before next routine |
| Resolved decision or main `relay`/`notify` entry | Mark dirty |
| Tool progress, reasoning delta, polling, Viewer read, routine internal event | Do nothing |
| Persona/provider/model/Skills/plugin change | Restage authority; do not rewrite conversation summary |
| No main-thread change | Reuse exact snapshot indefinitely |

Do not refresh on a clock. Time belongs in the per-run suffix.

## Database/runtime implementation

The runtime cutover:

1. add org-scoped main-context base/snapshot tables with forced RLS, digests, bounded columns, and no
   direct process-role grants;
2. classify and atomically persist a bounded `compaction_end` projection with its broker cursor;
3. add narrow runtime-owned functions to record a generation and read one pinned substrate;
4. pin or resolve a snapshot inside the transaction that materializes the durable routine run;
5. return pinned bytes/digest through routine-run material, never a cookie-authenticated route; and
6. persist estimated and provider-reported token/cache usage per run.

The snapshot foreign key belongs on the durable routine-origin run identity or immutable initial
attempt material, never on the mutable routine definition.

## Failure policy and acceptance

- No summary yet: run with the bounded tail and an explicit marker.
- Rejected latest summary: retain the previous valid generation, mark stale, add the freshest tail.
- Renderer failure before Box: bounded idempotent retry, then tail-only with a stable degradation
  code rather than losing the schedule.
- Active main chat: pin only durable entries; label unmatched input as pending and exclude streams.
- Revoked membership, ACL, resource, provider, or plugin: fail closed; cached context grants nothing.
- Replaced main Box/session: begin a new base generation; never attach an old-session summary.

Acceptance covers no/repeated compactions, quiet reuse across 96 fires, next-run-only refresh,
compaction/fire races, takeover-identical bytes, cross-tenant and revoked access, secret-shaped
summary/tool text, safe clipping, excluded routine markers, included prior surface messages, and
cache metrics even when providers report zero hits.

Do not begin with a second server-generated semantic brief. Consider one only if evaluation shows
the bounded Pi-summary-plus-tail substrate misses important post-compaction context. Until then,
this design provides useful continuity, bounded worst-case spend, stable prompt prefixes, and no
second model-authored history.
