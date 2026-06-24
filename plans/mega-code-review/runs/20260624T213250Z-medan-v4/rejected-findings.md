# Rejected Findings

## Empty report sections in `check_updates.py`
`print_rows` is always called with a header row, so sections can display only headers. This is a minor output polish issue without a concrete functional failure.

## Missing direct HTTP test for token route wrapper
The API test coverage exercises token-readable skills listing through the app request path. Adding another direct route wrapper assertion would be redundant for this diff.

## Duplicate `status: "fail"` key in manifest validation metadata
This appears pre-existing in adjacent code and is not made worse by the current change.
