---
name: sonar-verify
description: Use after code changes when the user wants Sonar to check conventions, dependency expectations, and flow integrity against the current diff.
user-invocable: true
---

# Sonar Verify

Run Sonar's post-change checks against the current branch diff.

## Workflow

1. Check `.sonar/graph.db`.
2. Collect modified files from `git diff --name-only HEAD` and the staged diff.
3. Map changed files to modules using `.sonar/file-modules.json` or the `files` table in `.sonar/graph.db`.
4. For each affected module, read `.sonar/modules/<module>.json`.
5. Run every convention that has a `check` command. Treat non-empty output as a failure and empty output as a pass.
6. Read `.sonar/system.json` and run any global convention checks there too.
7. Inspect affected flows through `flow_steps` and `.sonar/flows/*.json`.
8. Flag unmapped changed files and suggest `@sonar sonar-update` when the map needs refresh.

## Output

Produce a verification report with:

- files changed and their owning modules
- automated convention results
- system-level convention results
- dependency or API warnings
- flow integrity warnings
- business rules at risk
- recommended follow-up actions

## Rules

- Keep passes concise and failures specific.
- When a check cannot be automated, mark it clearly as manual verification.
- Do not claim the map covers new files if they are not mapped yet.
