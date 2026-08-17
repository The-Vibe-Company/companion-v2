# Pi RPC contract fixtures

These fixtures contain public protocol shapes only. They contain no captured production traffic,
credentials, provider tokens, customer prompts, host paths, or real session identifiers.

- `official-*.jsonl` is **official-doc-derived**: records are compact, deterministic adaptations of
  examples and field contracts in Pi's public RPC documentation. Identifiers, paths, model/provider
  names, timestamps, messages, and usage values are anonymized or synthetic.
- `captured-*.jsonl` is an **anonymized runtime capture** from the pinned Pi package and command
  recorded in `provenance.json`. Session paths and identifiers are replaced before commit.
- `synthetic-faults.json` is **synthetic**: it describes deliberate transport/protocol faults. Those
  recipes are simulator behavior and must not be interpreted as healthy Pi output.
- `provenance.json` records the source, classification, and transformations for every fixture.

Every JSONL fixture uses a literal LF as its sole record delimiter and ends in LF.
