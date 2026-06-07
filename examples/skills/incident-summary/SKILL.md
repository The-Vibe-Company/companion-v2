---
name: incident-summary
version: 0.1.0
description: Summarize an incident timeline from logs into a concise postmortem draft.
license: MIT
tools:
  - read_file
  - run_python
scope: team
---

# incident-summary

Reads a directory of log excerpts and produces a terse incident summary: timeline,
impact, suspected cause, and follow-ups. No network access; operates on local files only.

## Usage

Point it at a folder of `*.log` excerpts and a short prompt describing the incident window.
