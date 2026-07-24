# Testing standard

Companion tests protect product promises, not implementation details. A test is valuable when its
failure identifies a user-visible, security, or data-integrity regression that we would refuse to
ship.

## Protection map

Keep this table synchronized with critical suites. Removing or weakening one of these tests requires
updating the corresponding promise and explaining how it remains protected.

| Product promise | Incident prevented | Owning suite | Level | Failure proof |
| --- | --- | --- | --- | --- |
| A personal skill is visible and manageable only by its creator | Private data exposed to an admin, another member, or another tenant | `skillLifecycle.integration.test.ts` | HTTP + Postgres | Removing the creator/scope predicate makes the visibility scenario fail |
| Share is a one-way, atomic move into the organization library | Duplicated skills, leaked personal labels, or a partially shared dependency graph | `skillLifecycle.integration.test.ts` | HTTP + Postgres | Updating only the root or mutating before closure validation fails the positive or blocked dependency scenario |
| A public release is an explicit, authorized pointer to one immutable current version and identity | A non-creator developer exposes a skill, a publish silently moves the release, a rename changes the pinned package's identity, or a version becomes non-current while its promotion is prepared | `publicSkillRelease.test.ts`, `publicSkillRelease.integration.test.ts`, `skillRename.test.ts`, `skillListRoute.test.ts` | Core + HTTP + Postgres | Weakening the creator/Admin/Owner matrix, rename/pinned-identity guard, observed-current/CAS predicate, archive filter, or pointer-preservation assertions fails the lifecycle scenarios |
| Public package bytes require a verified account or approved agent and always match the pinned ZIP snapshot | Anonymous/PAT download, version substitution, a regenerated or overwritten release, stale bytes, or unsafe installation | `storage.test.ts`, `publicSkillTransferTicket.test.ts`, `publicSkillRelease.integration.test.ts`, `skillFileContentRoute.test.ts`, `PublicSkillActions.test.ts`, Companion client tests | Storage + Core + HTTP + browser component + local client | Removing conditional content-addressed persistence, direct snapshot reads, session/ticket-only auth, one-use binding, checksum/size verification, or safe archive/root checks fails download and install scenarios |
| Delegated agents receive only approved closed capabilities with exact workspace constraints | An agent calls an arbitrary route, crosses tenants after a member leaves, replays a JWT, or keeps revoked authority | `agent-auth.test.ts`, `context.test.ts`, Agent Auth SDK/CLI integration | Auth plugin + API middleware + real pinned client | Widening the operation registry, dropping workspace/membership/JTI/audience/revocation validation, or auto-granting a capability fails approval and denial scenarios |
| Binary Agent Auth transfers use short, opaque, single-use tickets with strictly hash-only persistence | A ticket or plaintext-derived prefix is persisted, replayed, used for another action/version, survives revocation, or appears in a URL/log | `publicSkillTransferTicket.test.ts`, `skillTransferTicket.integration.test.ts`, `publicSkillRelease.integration.test.ts` | Core + HTTP + Postgres | Restoring a plaintext-derived column, removing hashed atomic consumption, 60-second expiry, actor/agent/action/version binding, current-state revalidation, or value-free audit assertions fails the ticket matrix |
| Org labels are shared; personal labels are owner-private; empty folders persist | A folder disappears, silently merges, or a rename/delete corrupts another user or tenant | `labelLifecycle.integration.test.ts` | HTTP + Postgres | Removing creation, collision/self-subtree guards, `org_id`, or `owner_id` scoping fails the empty-folder, rename-rejection, or foreign-sentinel assertion |
| Sidebar category order is personal, workspace-scoped, and upgrade-safe | One member's order leaks to another, saved filters are overwritten, or an upgrade loses preference rows | `skillSidebarOrderPreferenceMigration.integration.test.ts`, `filterPreferences.test.ts`, `sidebarTree.test.ts`, `SkillsApp.test.ts` | Migration + core + browser component | Removing the JSONB default, actor/org key, complete snapshot, sibling guard, or persistence call fails the corresponding migration, service, tree, or pointer scenario |
| Secret plaintext is write-only and never persisted or audited | Credential disclosure through an API response, database row, or audit entry | `secretLifecycle.integration.test.ts` | Service + Postgres | Returning or storing the submitted sentinel makes the persistence scenario fail |
| Secret retrieval follows the current ACL, quotas, and single-use grants | Unauthorized, unbounded, or replayed credential retrieval | `secretLifecycle.integration.test.ts` | Service + Postgres | Relaxing UPDATE RLS, quota locking, or the atomic redemption guard fails its concurrent scenario |
| Tenant RLS policies isolate organizations for a non-bypass role | Cross-tenant data disclosure or corruption when RLS is active | `rls.integration.test.ts` | Postgres non-superuser | Removing an `org_id` policy or making tenant GUCs session-scoped fails the behavioral scenario |
| Projects, workspaces, Sessions, Skills, Secrets and Files stay creator-only | A same-org admin reads another member's Project, attaches a capability, or enumerates private Sessions or Files | `projects.test.ts`, project route tests, `rls.integration.test.ts` | Core + HTTP + Postgres | Removing the creator predicate, parent-derived RLS policy, or child ownership foreign key makes the same-org admin and cross-tenant scenarios fail |
| Project conversations remain a stable, recoverable library | Activity reorders rows, an archived conversation leaks into active results, an active turn archives without stopping, pagination skips a same-time row, or another member renames/reads/restores it | `projects.test.ts`, `runRoutes.test.ts`, `ProjectsApp.test.ts`, `projects.test.ts` (web library), `rls.integration.test.ts` | Contracts + Core + HTTP + browser component + Postgres | Dropping the `created_at DESC, id DESC` cursor, archive predicate, `stop_active` guard, creator predicate, or last-view acknowledgement fails ordering, pagination, archive/restore, read-state, or authorization scenarios |
| Background Project work produces useful unread and failure states without unsafe replay | A result finishes unnoticed, idle state creates noise, a turn error masquerades as a workspace outage, the composer is disabled after a recoverable failure, or a possibly-effectful prompt is retried automatically | `projectSupervisor.test.ts`, `ProjectsApp.test.ts`, `ProjectSessionView.test.ts` | Worker + browser component | Removing terminal unread derivation, useful-status filtering, the turn/workspace error split, explicit continue action, or no-replay confirmation window fails the background-result and recovery scenarios |
| Project attachments, direct uploads, and generated Files remain durable and correctly attributed | An attachment is detached from its message, a file marker points at the latest mutable path instead of the produced version, a direct upload creates a synthetic prompt or reaches a warm runtime mid-turn, a same-org admin downloads it, or desktop preview hides the composer | `projects.test.ts`, project route tests, `projectSupervisor.test.ts`, `ProjectFileCard.test.ts`, `ProjectSessionView.test.ts`, `ProjectsApp.test.ts`, `rls.integration.test.ts` | Core + HTTP + worker + browser component + Postgres | Removing prompt foreign keys, `modified_by_prompt_id`, immutable version lookup, the desired/applied file-revision fence, creator checks, or the non-modal desktop panel fails attribution, atomic projection, reload, privacy, or continuity scenarios |
| Project context reveals capability metadata without exposing credential material | Friendly model labels disappear, Access truncates silently, a Secret value/ciphertext reaches the API or UI, or an Owner/Admin reads another creator's Access list | `projects.test.ts`, project route tests, `ProjectsApp.test.ts`, `rls.integration.test.ts` | Core + HTTP + browser component + Postgres | Returning more than Secret names/sources and provider/source metadata, dropping the creator gate, or rendering raw routes as primary labels fails safe-access and presentation assertions |
| One Project resumes one persistent sandbox and safely multiplexes independent OpenCode Sessions | A worker creates one sandbox per Session, duplicates a prompt after a crash, strands a `running` workspace after its lease expires without a pending prompt, mixes event streams, attributes a pending VM to the prior billing revision, or loses Files after idle suspension | Project supervisor/runtime tests, `rls.integration.test.ts`, plus the credential-gated Vercel smoke | Core + worker + provider contract + Postgres | Changing the deterministic name, expired-running claim predicate, pending-admission token, ambiguous-activation observation, message reconciliation, single subscription, or checkpoint restore fails identity, billing, concurrency, and resume assertions |
| Project environment synchronization is exact, atomic, and plaintext-free | A partial Skill closure runs, a revoked Secret remains admitted, duplicate keys receive silent precedence, or plaintext reaches persistence | Project materialization, supervisor, and Postgres integration tests | Core + worker + Postgres | Breaking the staging swap, ACL revalidation, collision gate, redactor, or revocation fence exposes the sentinel or an incomplete generation and fails the scenario |
| Project prompts never cross a disconnected model-provider boundary | A queued/pre-send prompt wakes a stopped VM or reaches OpenCode after its only compatible effective credential is removed | `projects.test.ts`, `projectSupervisor.test.ts`, `rls.integration.test.ts` | Core + worker + Postgres | Removing the immutable provider/env-key snapshot, pre-send revalidation, blocked claim gate, or reconnect signal either sends without credentials or creates repeat VM/billing work |
| Project commands and runtime accounting survive retries without duplicate work, identity loss, or unadmitted provider time | A lost create response provisions two Projects, an explicit workspace retry clears its checkpoint/admission identity, a prompt is charged twice, an expired reservation silently revives, or Vercel outlives the admitted 10-minute activation plus 7-minute prompt slices | Project route/Core tests, `billing.test.ts`, `projectSupervisor.test.ts`, and Postgres integration | HTTP + Core + worker + Postgres | Removing creator-scoped payload hashing, terminal-only retry state, quota locking, full revival admission, durable activation revision, or provider timeout clamping fails the retry and budget assertions |
| API credentials cannot claim or mutate worker-only Project leases | A compromised API process claims a Project workspace or spoofs worker liveness before a tenant request | `runtimeRoleGrants.integration.test.ts`, `migrate.test.ts` | Migration + Postgres non-bypass roles | Granting Project claim/lease-entry/heartbeat/removal to the API role fails the privilege matrix while creator CRUD and the read-only readiness probe remain covered |
| Skill runs, saved configurations, inputs, prompts, events, and prompt-linked attachments stay creator-only | An admin or another member reads or mutates a private run, or a file is detached from the message that introduced it | `runsDb.integration.test.ts` | Postgres non-superuser | Relaxing a creator-through-parent policy, deferred legacy link, or prompt attachment foreign key makes the same-tenant admin, rolling-write, or attachment-association assertions fail |
| The durable run queue has one lease owner, mounts follow-up files before dispatch, and resumes without duplicating commands | Two workers start the same sandbox, a protocol-1 lease dispatches during rollout, or OpenCode sees a prompt before its files or durable send marker | `runsDb.integration.test.ts`, `runJobs.test.ts`, `runSupervisor.test.ts` | Core + Postgres + worker | Weakening v2 claim/transition fencing, making `send_attempted_at` mutable or post-send, or moving dispatch ahead of mounting makes the lease, rolling-deploy, ambiguity, or ordering assertions fail |
| Follow-ups remain FIFO across reloads and stopping one turn cannot stop its successor or destroy the retained session | A queued message disappears, an ambiguous retry is discarded as unsent, a late stop aborts the next prompt, or partial output is lost with the sandbox | `runsDb.integration.test.ts`, `runJobs.test.ts`, `runSupervisor.test.ts`, `runRoutes.test.ts`, `RunChatView.test.ts` | HTTP + Postgres + worker + browser component | Removing the queue bound/exact prompt identity, explicit attachment disposition, ambiguous-stop recovery, cancellation CAS, or durable idle/transcript barrier makes the concurrency and reload scenarios fail |
| Ambiguous run uploads remain retryable without leaking storage forever | A request race deletes committed bytes, or rejected uploads remain permanently unbounded | `runAttachmentCleanup.test.ts`, `runRoutes.test.ts`, `runsDb.integration.test.ts` | API + worker + Postgres | Moving deletion into the request path, removing the 24-hour age gate/reservation lock, dropping upload-reservation RLS, or uploading a follow-up before its preflight fails these assertions |
| Rich run media previews never trust a client MIME and videos remain seekable without buffering whole objects | A disguised active file executes inline, a cross-tenant object leaks, a stale range splices object generations, or a video request exhausts API memory | `runArtifacts.test.ts`, `storage.test.ts`, `runRoutes.test.ts`, `RunChatView.test.ts` | Core + storage + HTTP + browser component | Trusting an extension, removing signature checks/private headers, accepting multiple ranges, honoring weak/stale `If-Range`, omitting S3 `If-Match`, or buffering the full object makes the spoofing, 200/206/416, generation-fence, or rendering scenario fail |
| Generated run files remain private, bounded, downloadable after freeze, and expire after 24 hours | An admin reads output, an unsafe file executes inline, a whole workspace is exfiltrated, or cleanup races a replacement | `outputFiles.test.ts`, `runArtifacts.test.ts`, `runSupervisor.test.ts`, `runArtifactCleanup.test.ts`, `runRoutes.test.ts`, `RunChatView.test.ts`, `runsDb.integration.test.ts` | Sandbox + worker + API + browser component + Postgres | Relaxing path/signature limits, creator/exact-lease RLS, reservation-ready ordering, expiry checks, or attachment disposition fails the corresponding collection, publication, route, or visibility assertion |
| Frozen, canceled, and interrupted runs resume only from a new explicit prompt without racing cleanup | A resumed chat loses context, replays an interrupted prompt, duplicates a follow-up, or has its sandbox destroyed underneath it | `runsDb.integration.test.ts`, `runSupervisor.test.ts`, `RunChatView.test.ts` | Core + Postgres + worker + browser component | Removing the activation revision, retention predicate, creator gate, no-replay transition, or retained-session assertion fails the reactivation scenarios |
| Run Skill warm-ups stay secretless, invisible, creator-private, and adopt at most once | An abandoned launcher leaks a credential, appears in Sessions, or races a second sandbox into one run | `runsDb.integration.test.ts` + `prewarmSupervisor.test.ts` | Core + Postgres + worker | Removing prewarm RLS/adoption locks or calling `startServer` during warm-up makes the privacy/adoption or secretless-runtime assertions fail |
| Every sandbox activation has an absolute provider deadline and exact-lease recovery | Observe mode leaves a five-minute prewarm unextended, retries forever, concurrent reconcilers terminalize live work, a provider outlives admitted minutes, or cleanup leaves a phantom charge | `billing.test.ts`, `runsDb.integration.test.ts`, `runSupervisor.test.ts`, `runRuntimeReconciler.test.ts`, `vercel.test.ts`, `runCleanup.test.ts`, `prewarmSupervisor.test.ts` | Core + Postgres + worker + provider adapter | Removing the safety cap, provider observation, activation fence, org-period lock, ambiguous-extension re-observation, or bounded settlement fails the corresponding deadline and recovery scenarios |
| Managed billing reconciliation recovers without a redeploy | A transient Stripe or database failure at worker boot permanently disables seat synchronization, a raw JavaScript `Date` fails before PostgreSQL candidate discovery, or a scheduled rejection becomes unhandled | `billingSupervisor.test.ts`, `preTenantBilling.test.ts` | Core + worker unit | Removing ISO `timestamptz` encoding, startup rescheduling, periodic error isolation, or stop-time timer cleanup fails the recovery scenarios |
| Runtime credentials cannot bypass RLS before a tenant is selected | Login, PAT, invite, share, avatar, or billing discovery requires an all-powerful application role | `preTenantRls.integration.test.ts` | Postgres non-bypass role | Removing a narrow RPC grant or exposing tenant tables directly makes the no-GUC boundary assertions fail |
| Active browser sessions survive rolling deploys and extend for 30 days without false login redirects | A transient API replacement strands a signed-in user on Google SSO, or the database expiry advances while the browser cookie silently expires | `context.test.ts`, `whoamiRoute.test.ts`, `apiServer.test.ts`, `serverAuth.test.ts`, `authRouteStates.test.ts`, `SessionKeepAlive.test.ts`, `WorkspaceLoadError.test.ts`, `middleware.test.ts` | API middleware + HTTP route + server loader + route matrix + browser component | Dropping Better Auth response headers, refreshing during server rendering, returning `401` for a dependency failure, classifying `5xx` as anonymous, redirecting an unavailable route, removing Retry/visible-tab refresh, or accepting both canonical host aliases makes the corresponding regression test fail |
| Any active rolling browser session can approve an Agent Auth device request | A five-minute recent-login gate repeatedly forces a signed-in user through authentication | `agentAuthRoutes.test.ts`, `agent-auth.test.ts`, `DeviceCapabilitiesApproval.test.ts` | HTTP wrapper + configured auth-plugin behavior + browser component | Restoring either created-at freshness gate rejects the 30-day session fixture or makes the configured approval return `fresh_session_required`; restoring stale-session copy fails the component assertion |
| GitHub mirrors and skill-centric selections remain admin-only, tenant-isolated, one-way, repository-ID-bound, and safe across OAuth lifecycle races | A PAT/developer controls a repo, a stale full-array edit loses another admin's selection, the last selected root is removed, two tenants claim one repository, a replacement repo at the same name is overwritten, or an in-flight refresh resurrects credentials after disconnect | `githubRoutes.test.ts`, `githubSync.test.ts`, `GitHubPane.test.ts`, `index.test.ts` (`@companion/github`), `rls.integration.test.ts` | HTTP + core + browser component + GitHub client + Postgres non-superuser | Enabling PAT auth, dropping `canManageOrg`/tenant predicates/repository uniqueness or repository-id validation, replacing atomic join mutations with stale arrays, allowing an empty selected mirror, or weakening the credential generation/version CAS and revoke-on-loss path makes the relevant suite fail |
| GitHub publication is deterministic, exact-claim fenced, bounded, heals ambiguous ref outcomes, and preserves repository content outside Companion-owned paths | A stale/reclaimed worker publishes, slow preparation pins a database transaction, a timeout leaves an accepted commit permanently failed, a dependency/S3 failure publishes a partial tree, a rejected pool continues side effects, README customization is erased, an unrelated file/manual skill folder is deleted, or an unowned slug collision is overwritten | `githubSupervisor.test.ts`, `githubSync.test.ts`, `index.test.ts` (`@companion/github`), `rls.integration.test.ts` | Core + worker + GitHub client/renderer + Postgres non-superuser | Weakening the owner/generation/revision/connection fence, moving preparation into the final transaction, completing outside the non-force ref fence, removing tree-SHA recovery or signed pending-ownership verification, removing stop-on-error pool settlement, resolving dependencies by stale slug only, omitting the observed `base_tree`, widening deletes beyond slugs from the trusted applied manifest, accepting malformed README markers, or decoding binary files makes the relevant suite fail |
| The official installer resolves skill metadata with workspace-scoped Agent Auth, while explicit legacy PAT remains compatible | Agent bootstrap cannot inspect dependencies, or silently falls back to a preserved PAT | `agent-auth.test.ts`, `agentOperations.test.ts`, `operations.test.ts`, `skillListRoute.test.ts` | SDK/CLI compatibility + closed registry + HTTP route | Removing `skills:read`, widening the registry, or selecting a PAT without `COMPANION_AUTH_MODE=legacy-pat` fails the installer scenarios |
| Secret redemption never crosses argv, stdout, regular files, logs, or Agent Auth events | A delegated agent leaks a plaintext secret while retrieving an approved projection | `test_secrets_runtime.py`, `agent-auth.test.ts`, `operations.test.ts` | Private-pipe transport + explicit event allowlist | Sending the sentinel through the generic JSON action or a non-pipe descriptor fails, while the inherited pipe returns it only in memory |
| An expired Companion PAT refreshes once without widening authority | Parallel bootstraps mint multiple successors, revive stale credentials, or leak a replacement token | `tokenRefresh.integration.test.ts`, `preTenantRls.integration.test.ts`, `test_bootstrap.py` | Core + Postgres non-bypass role + local script | Removing the pre-tenant lock, 30-day/member/revocation predicates, same-scope replacement, atomic file swap, or output redaction fails the concurrency, boundary, or bootstrap scenarios |
| Browser flows preserve the same privacy guarantees as the API | A working backend hidden behind a broken or misleading UI | `e2e/critical-flows.spec.ts` | Playwright | Dropping the selected folder, breaking Share, or rendering a saved secret value fails the relevant journey |

Future providers, Hermès, and reconcile implementations must add their conformance promises here
when their production code lands. Do not add placeholder tests for code that does not exist.

## Critical-suite header

Every critical suite starts with a docblock that records why it exists:

```ts
/**
 * Product promise:
 * A personal skill is visible and manageable only by its creator.
 *
 * Regression caught:
 * Missing creator_id or scope filters could expose it to an admin or another member.
 *
 * Why this test is integrated:
 * A mocked database cannot prove that the Drizzle query and Postgres RLS enforce the rule.
 *
 * Failure proof:
 * Removing the creator filter must make this suite fail.
 */
```

Comments explain risk, test level, and non-obvious traps. They must not narrate assertions line by
line. Reference the issue or pull request when a test protects a known regression.

## Choosing the test level

- **Unit:** pure authorization matrices, encryption primitives, parsing, validation, dependency
  graph algorithms, and contract schemas.
- **Integration:** SQL predicates, transactions, migrations, RLS, ownership, tenant isolation, and
  secret lifecycle. Use a real disposable Postgres database.
- **HTTP integration:** request validation plus a critical domain workflow. Keep the real service and
  database layers; replace only authentication identity and external providers.
- **Browser:** a small number of journeys where rendering, browser state, or user interaction is the
  risk. Do not duplicate every API case in Playwright.

Mock Stripe, S3, Resend, and other external systems. Do not mock the service-to-database boundary when
the promise depends on tenant, scope, transaction, or RLS behavior.

RLS tests prove policy semantics only when they execute as a non-owner role with neither `SUPERUSER`
nor `BYPASSRLS`. They do not certify a deployment that connects its application as a table owner or
superuser; runtime credentials must independently satisfy that operational requirement.

## Test quality rules

- Name a test after the business rule and observable outcome.
- Assert public results and durable state, not internal call counts or Drizzle builder shapes.
- A bug fix includes a test that fails on the previous implementation.
- Unit tests perform no undeclared network or database I/O.
- Tests restore globals, timers, DOM roots, and mocks that they change.
- Do not commit `.only`, conditional skips, or ignored console/browser errors.
- Integration tests require an explicit disposable `DATABASE_URL`; they never silently fall back to a
  developer or production database.
- Coverage is diagnostic. A percentage is not a substitute for demonstrating that a critical test
  fails when its protected invariant is broken.

## Verified failure sensitivity

The following temporary mutations were applied locally on 2026-07-13 and reverted immediately.
They check the tests themselves; none of these faults belongs in the repository.

| Injected fault | Scenario that failed |
| --- | --- |
| Removed the `skills.org_id` predicate from shared skill reads | `hides a personal skill from same-org admins and cross-tenant actors until its owner shares it` returned a foreign-tenant row |
| Allowed every member through the personal-skill detail predicate | The same visibility scenario returned the owner's private skill to the admin instead of the indistinguishable 404 |
| Added the submitted secret value to the create response | `never returns or persists plaintext and gives an admin no implicit access` found its sentinel in the HTTP body |
| Removed the atomic `redeemed_at is null` grant claim | `allows an authorized read token to redeem once and rejects replay or changed access` observed two 200 responses instead of 200 + 409 |
| Made `withTenantContext` settings session-scoped | `uses transaction-local tenant identifiers that are cleared after withTenantContext returns` observed the leaked Org/User values on the same application connection |

## Commands

```bash
pnpm test

# Requires an explicit disposable Postgres DATABASE_URL. Migrations must already be applied.
DATABASE_URL=postgres://... pnpm test:integration

# Requires a built/seeded local stack; see playwright.config.ts for ports and credentials.
pnpm test:e2e
```
