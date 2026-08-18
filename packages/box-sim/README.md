# Deterministic Box/Pi simulator

`@companion/box-sim` is the CI provider for Companion runtime tests. It exposes the Box v1 routes
used by Companion and connects their command endpoint to a real child process speaking strict-LF Pi
RPC JSONL. Lifecycle commands are interpreted by in-memory shims; the package never executes
`systemctl`, `loginctl`, `journalctl`, or an arbitrary command on its host.

Run it with `pnpm --filter @companion/box-sim dev`. The default provider URL is
`http://127.0.0.1:13400`, the bearer key is `box-sim-api-key`, and the simulator-only control plane is
under `/_box-sim` with `X-Box-Sim-Token: box-sim-control-token`. All values can be overridden with
the corresponding `BOX_SIM_*` environment variables.

The control plane resets state, selects Pi scenarios, advances deterministic Box transitions,
injects before/after faults, crashes Pi, and pins deletion operations in `blocked`. Its state view
stores hashes and property names instead of setup scripts, credentials, signed URLs, or raw secret
values. See `fixtures/` for the provenance of captured and official-document-derived contracts.
