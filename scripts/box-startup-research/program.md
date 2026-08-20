# Box startup autoresearch program

You are optimizing Companion's real box.ascii.dev + Pi startup path. The product contract is fixed;
the implementation order is not.

## Objective

Minimize the worse of creation and resume `Box ready -> Pi prompt ACK` latency. Preserve every
feature and security invariant. Provider start, total latency, stop/archive latency, provider calls,
Skill bytes, image bake duration, snapshot size, and disk activity are diagnostics rather than the
primary score.

Do not assume current work belongs on the critical path. Challenge the ordering. Safe examples to
investigate include preparing immutable Skills before archive, persisting verified digests, avoiding
metadata writes on restore, moving regenerable work to Stop, or proving a cache once and reusing it.
An expensive Stop is acceptable when it materially improves the next wake, provided Stop remains
bounded and secrets are absent before snapshot publication.

## Immutable product constraints

- One Companion remains one persistent Box, one Pi daemon, and one durable thread.
- Pi is the only harness and box.ascii.dev the only runtime provider.
- Sending remains the only normal wake action. No pool, keystroke prewarm, Wake button, or new flag.
- Runtime re-evaluates ACL, selected resources, settings, and credentials immediately before Box
  contact. A stopped Box cannot make a stale authorization snapshot authoritative.
- Provider and MCP credentials remain transient/write-only. Never bake, log, print, or commit them.
- The Companion Hub token is renewed on Start and erased on Stop.
- Ambiguous dispatch is never replayed automatically.
- Automatic recovery may recycle Pi only; it never replaces, archives, or deletes a healthy tenant
  Box.
- If Skills or settings change while the Box sleeps, resume must invalidate any prepared stale tree
  and apply the current authorized revision before Pi starts.
- Creation must still work without a preceding Stop.
- Stop/archive and cleanup must terminate within the existing lifecycle bounds.

## Candidate boundaries

During exploration, change production code only under:

- `packages/box-runtime/src/`
- `packages/companion-runtime/src/`
- `apps/runtime/src/`

Do not edit tests, manifests, workflows, schemas, public contracts, API/UI/authz, documentation, or
anything under `scripts/box-startup-research/`. Do not add dependencies. The Sol integration phase
will add the required tests and documentation after the measured design is selected.

## Experiment loop

1. Read the current incumbent and the supplied previous results.
2. State one falsifiable hypothesis, including which work leaves or enters the critical path.
3. Make the smallest coherent production change that tests it.
4. Run deterministic affected-package tests. Never run the real provider benchmark until a
   `BENCHMARK_GRANT` message arrives.
5. Commit exactly once and push the workspace branch.
6. End the exploration response with exactly one machine line:

```text
BOX_STARTUP_RESEARCH_SUBMISSION {"schemaVersion":1,"runId":"...","candidateId":"...","baseSha":"<40 hex>","commitSha":"<40 hex>","hypothesis":"...","summary":"...","checks":["..."]}
```

After a grant, run only the exact benchmark command in that message. Do not edit or commit anything
else. End with the unchanged `BOX_STARTUP_RESEARCH_RESULT {...}` line printed by the command.

If an experiment fails, report it honestly. Never alter the evaluator, fabricate a result, relax a
test, reuse another candidate's snapshot, or leave a Box/snapshot behind to improve the score.
