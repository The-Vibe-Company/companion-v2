# Box API contract fixtures

These fixtures contain no API key, desktop URL, customer data, or live Box identifier.

- `captured-unauthorized.json` is a real unauthenticated response from the public Box v1 API. Its
  request id is anonymized.
- `official-*.json` adapts the public permanent-deletion examples with deterministic identifiers and
  timestamps so the simulator can assert the success contracts without owning a live Box.
- `provenance.json` records the exact source and transformations for each fixture.
