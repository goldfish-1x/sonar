---
name: sonar-reset
description: Use when the user explicitly wants to delete the `.sonar/` map and rebuild from scratch.
user-invocable: true
---

# Sonar Reset

Delete the `.sonar/` directory and start over.

## Workflow

1. Check whether `.sonar/` exists.
2. Before deleting it, report how many files and how much disk space will be removed.
3. Confirm the destructive action with the user before running `rm -rf .sonar`.
4. After deletion, tell the user to run `@sonar sonar-crawl` when they want a fresh map.

## Rules

- Never delete `.sonar/` without an explicit user instruction in the current thread.
- If no map exists, say so and stop.
