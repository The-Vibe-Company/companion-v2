---
name: incident-summary
description: Summarize an incident timeline from logs into a concise postmortem draft.
metadata: {}
license: MIT
allowed-tools: read_file run_python
---

# incident-summary

Reads a directory of log excerpts and produces a terse incident summary: timeline,
impact, suspected cause, and follow-ups. No network access; operates on local files only.

## Usage

Point it at a folder of `*.log` excerpts and a short prompt describing the incident window.
