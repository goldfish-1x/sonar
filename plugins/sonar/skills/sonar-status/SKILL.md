---
name: sonar-status
description: Use when the user wants current Sonar map health, freshness, coverage, and queued refresh work.
user-invocable: true
---

# Sonar Status

Show the health of the current `.sonar/` map.

## Workflow

1. Check for `.sonar/meta.json`. If absent, report that no Sonar map exists yet.
2. Read `.sonar/state.json` first and treat it as the primary freshness source.
3. Read `.sonar/meta.json` for timestamps and git metadata.
4. Count mapped files, modules, flows, and functions from `.sonar/graph.db` when available.
5. Compare current git SHA to the map SHA when possible.

## Output

Report:

- last crawl or update time
- mapped files versus source files
- module, flow, and function counts
- structural freshness
- semantic freshness
- queued modules, flows, or system refresh
- recommended action, usually `@sonar sonar-update` or `@sonar sonar-crawl`

## Rules

- Prefer `state.json` over ad hoc age guesses.
- If `graph.db` is missing but `.sonar/` exists, say the query layer needs rebuilding.
