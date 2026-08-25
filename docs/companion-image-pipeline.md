# Companion image pipeline (design)

Status: phase 1 implemented; phases 2 and 3 remain follow-up work.

## Problem

Companion creation is slow and fragile, and every modification to the provisioning path
regresses something. The root cause is architectural: the runtime Box image is not an
entity. Its state lives only in an ascii.dev snapshot name (a content hash) plus
in-memory baker state plus shell markers inside a Box. Nobody can answer "what is the
state of image X?" by reading PostgreSQL.

Consequences observed over ~28 fix/perf commits:

- The baker retries failures on a fixed 30 s loop forever, silently (`companionRuntimeBaker.ts`).
- A Companion create that does not see a ready image within 10 s falls back to a full
  cold install (~300 s). The first Companion after any pin bump always pays this.
- Races between the baker and concurrent Box creates required a chain of patches
  ("tolerate image warmup races", "attest image-owned autoresearch Pi", "repair
  autoresearch snapshot attestation") plus a 5k-line diagnostic subsystem.
- Shell-label contracts are fail-open: an unlabeled `ensure-pi-layout.sh` success parses
  as `"base"` (full reinstall), so truncated output causes repeated expensive relayouts.

## Industry convergence

Every comparable system converged on the same model; we are on the abandoned one:

| Pattern | E2B | Morph | OpenHands | HCP Packer | Us today |
| --- | --- | --- | --- | --- | --- |
| Image = declarative, versioned registry entity with published status | templates | templates | image tags | registry | hash in a name |
| Create references an explicit image id | yes | `snapshot_id` | tag | channel | heuristic fallback after 10 s |
| Async build with published progress/events | build events | build events | — | webhook | silent retry loop |
| Setup cached per step | template build | step cache | layer cache | builder | full reinstall on ambiguity |

E2B documents explicitly that declarative template builds beat captured live snapshots
for cold start; snapshots should be reserved for checkpointing a running Box, not for
distributing the base environment.

## Design principles

1. Everything that exists is a durable row whose desired state and observed state are
   separated; everything touching Box/Pi is an idempotent reconciler between the two.
2. Fail closed: unreadable output or ambiguous provider responses become explicit,
   persisted errors — never silent fallbacks.
3. One typed contract module per cross-layer concept; no duplicated strings, names, or
   SQL bodies across api/runtime/worker/migrations.
4. Every entry point carries a client idempotency key.

## Phase 1 — the image registry

New table `companion_images` (infrastructure-level, not tenant-scoped: digests are
content-derived and shared across organizations):

```
digest            text PK      -- full layout identity marker hash
image_name        text UNIQUE  -- ascii.dev snapshot name
status            requested | building | ready | failed
parent_image_name text         -- clone parent used by the bake
build_box_id      text
build_delete_intent_at timestamptz -- durable write intent before irreversible DELETE
build_delete_operation_id text -- accepted provider DELETE, resumed without replay
attempt_count     int
last_error_code / last_error_message
claimed_at / claim_epoch / claim_actor_id   -- monotonic fenced single-builder lease
requested_at / building_at / ready_at
created_at / updated_at
```

Semantics:

- Any actor needing an image upserts `(digest → requested)` if no ready row exists.
  This is idempotent and race-free (upsert).
- A builder loop in `apps/runtime` claims only its exact configured `(digest, image_name)`
  via compare-and-set lease (epoch), drives the existing bake steps, and persists
  every transition: `building`, per-attempt errors with capped exponential backoff,
  terminal `ready` or `failed`.
- Backoff: `[30s, 60s, 120s, 300s]`, max 4 attempts, then `failed`. A request after a
  ten-minute terminal cooldown starts a fresh four-attempt cycle. Failure is visible:
  it surfaces as a stable error code on the blocked operation instead of a silent loop.
- Phase 1 does not prune provider snapshots. Deleting a snapshot while its registry row remains
  `ready` would publish a false clone source. Registry-aware retention/garbage collection belongs
  to phase 3; until then, a provider snapshot-limit error fails visibly and creation takes the
  explicit cold-install path.
- `build_box_id` is cleared only after provider deletion succeeds behind the active epoch fence.
  Runtime stores `build_delete_intent_at` before issuing the irreversible call, then stores an
  accepted operation in `build_delete_operation_id` before polling. Takeover resumes a known
  operation. If the accepted response or its checkpoint is lost, takeover performs only read-only
  absence reconciliation and never replays `DELETE`; the baker Box's bounded TTL supplies eventual
  cleanup. A failed or blocked cleanup leaves the intent and both pointers durable. An expired
  fourth attempt is reclaimable for cleanup and terminal settlement, but can never start a fifth
  bake.
- `claim_epoch` is monotonic for the lifetime of a digest row and is never reset on settlement;
  otherwise a stale writer from attempt 1 could become valid again when a later claim reused 1.

### Builder contract

`packages/companion-runtime/src/imageRegistry.ts` exposes a store-agnostic service:

- `requestImage({ digest, imageName })` — idempotent upsert to `requested`.
- `claimImageBuild({ executorId, digest, imageName })` — leases only that exact claimable row
  (`requested`, or `building` past its lease, or `failed`-retryable past its backoff)
  using `FOR UPDATE SKIP LOCKED` + epoch CAS, returning any durable baker Box pointer and a
  cleanup-only recovery flag.
- `recordBuildOutcome(...)` — persists transition with epoch fence; stale epochs are
  no-ops (same fencing as operations).

Consistent with every other Runtime v2 surface, no process role holds table privileges
on `companion_images`. All access crosses narrow SECURITY DEFINER functions installed by
migration 0123 and granted to the dedicated runtime role only; the role verifier's
"no public relation privileges" invariant stays intact.

### What changes for creation

- `createGenerationBox` waits on the registry row's published status with progression
  (`requested → building → ready`). The snapshot clone is the nominal launch path, so the
  wait is bounded by the room the operation's own cold-start deadline leaves after a reserve
  for the create POST (`imageWaitBoundMs`, capped at `RUNTIME_IMAGE_WAIT_MS`), not by a hidden
  3-second clamp. A ready image resolves on the first read and clones immediately; a `building`
  or `requested` image is waited for up to that bound (cloning a pre-baked snapshot then skips
  the 300s install, so the wait beats cold-installing, which blows the deadline regardless); a
  `failed` build falls back immediately; and a wait that exhausts its bound cold-installs.
- Cold install remains the last-resort fallback, but it is now loud, never silent: every create
  that cold-installs despite a snapshot source is logged with a `fallbackReason`
  (`image_build_failed`, `image_wait_exhausted`, `unknown_snapshot_fallback`, or `no_snapshot`)
  and counted so `/healthz` (`image.cold_fallback_count`) surfaces a degraded launch path. The
  registry-driven builder is supervised: a dead builder loop fails `/healthz` (`checks.image_builder`),
  and a `failed` digest is reported (`image.status`) without flipping health, since creates still
  succeed via the fallback. `COMPANION_RUNTIME_REQUIRE_IMAGE=true` makes creation strict — it
  refuses the fallback and fails the start with the stable code `runtime_image_unavailable`
  (action `retry`) so the ordered queue retries once a snapshot is ready.
- The in-process baker class is retired: its infinite retry loop and sticky-resolution
  heuristics are deleted; only the single-attempt `bakeCompanionRuntimeImageOnce` unit
  remains, executed by the registry-driven builder under its lease. The diagnostic
  startup-autoresearch harness (`scripts/box-startup-research`) was removed with it.

## Self-hosted Pi bundle (Phase 1-B)

The cold-install path — `npm i -g @earendil-works/pi-coding-agent`, four `pi install`
runs, and a qmd install — is the dominant contributor to the ~300 s install, and its
duration and success depend on whatever a public npm registry serves at boot. Phase 1-B
replaces it with a self-hosted, content-addressed artifact.

- `packages/box-runtime/src/piBundle.ts` holds the single-source pins (`COMPANION_PI_BUNDLE`:
  `piVersion`, the four extension `packages`, `qmdPackage`, `nodeMajor`, `sha256`, `bundleFormat`).
  The artifact is `companion-pi-bundle-<sha12>.tar.gz`, a tarball carrying `pi/` (the Pi prefix
  tree), `pi-agent-dir/` (the four installed extensions), and `tools/` (the qmd prefix tree).
- Bundle mode turns on when `COMPANION_PI_BUNDLE_BASE_URL` is set (the public bucket base URL, for
  example the `companion-pi-bundles` bucket on Tigris; never hardcoded). The layout script then
  `curl`s the object (retrying, with a `node` fetch fallback), verifies it with `sha256sum -c`
  against the pin, `tar`-extracts it into `~/.companion/dist/<sha12>/`, checks the Box's Node major
  against `nodeMajor`, and wires PATH (`dist/<sha12>/pi/bin` first, `pi-agent-dir` → `~/.companion/pi`,
  `tools` → `~/.companion/tools`). Nothing is fetched from npm.
- The three failure points print a fixed marker as their last stderr line —
  `companion-bundle-download-failed`, `companion-bundle-checksum-mismatch`,
  `companion-bundle-node-mismatch` — which `#applyPiLayout` maps to the stable codes
  `pi_bundle_download_failed`, `pi_bundle_checksum_mismatch`, `pi_bundle_node_mismatch`. The layout
  marker is never written on failure, so the Box relayouts cleanly on its next wake.
- `COMPANION_PI_INSTALL_COMMAND` stays the dev/emergency escape hatch and behaves exactly as before
  when no bundle is configured. When both are set, the bundle wins. Bundle identity is folded into
  the base layout marker as `:bundle=<sha12>`; the escape-hatch marker omits it, so identities never
  collide. A new bundle sha is a new base marker: warm Boxes relayout once at their next health tick
  and the registry re-bakes. `disk_layout_version` stays 14 — no migration.
- Build and publish: `scripts/build-pi-bundle.sh` (reads the pins from `piBundle.ts`, builds the
  three trees, smoke-tests, tars, prints the sha256) and `.github/workflows/pi-bundle.yml` (builds on
  the pinned Node major, uploads to S3 at the content-addressed key with `scripts/upload-pi-bundle.mjs`).
  A CI guard (`pnpm pi-bundle:check`) HEADs the object derived from the pin so a pin cannot merge
  before its artifact exists; it skips gracefully while the sha is still the placeholder or no base
  URL is configured.

## Phase 2 — staged, proven checkpoints

Generalize the `companion_operations.checkpoint` mechanism to staging itself: each
staging step is `(name, guard, idempotent action, persisted proof)`. Crash recovery =
read proofs, execute first unproven step. Shell markers remain only as caches; proofs
live in PostgreSQL.

## Phase 3 — shared contracts

- Single module for generation names, provider event schemas, and all timing constants
  with documented interactions.
- SQL functions migrated by diff (`CREATE OR REPLACE`), never re-declared wholesale.
- Registry-aware provider snapshot retention and garbage collection: mark old rows unavailable
  before deletion, fence against current creation reads, and reconcile provider inventory.

## Migration plan

Phase 1 ships additively: new table, new registry service, builder switched to it,
baker heuristics retired. No legacy data migration is needed — images rebuild from
content identity on demand. Phases 2–3 follow incrementally; each phase must keep
`pnpm verify:change` green including the deterministic Box/Pi E2E matrix covering:
image ready / building / failed / concurrent create / crash at each checkpoint.
