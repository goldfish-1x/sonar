---
name: sonar-review-context
description: "Use before review when the user wants Sonar context for the current branch diff: blast radius, conventions, business rules, and flow invariants."
user-invocable: true
---

# Sonar Review Context

Pull Sonar intelligence for the current branch diff before review.

## Workflow

1. Check `.sonar/graph.db` and `.sonar/file-modules.json`.
2. Detect the base branch. Default to the remote HEAD branch, then `main` if needed.
3. Diff `origin/<base>...HEAD` and collect changed files.
4. Map those files to modules.
5. Compute blast radius outside the diff from `.sonar/graph.db`.
6. Run module convention checks against the changed files.
7. Extract business rules whose source files appear in the diff.
8. Read affected flow invariants from `.sonar/flows/*.json`.

## Output

Return:

- changed files and changed modules
- first, second, and third-order blast radius outside the PR
- convention pass/fail/skip status
- business rules touched by the diff
- flow invariants the reviewer should verify
- unmapped changed files

## Rules

- Exclude modules already in the diff from blast radius reporting.
- If no dependents exist outside the diff, say the PR appears self-contained from Sonar's perspective.
- If the repo only has a skeleton map, say that convention and flow analysis are partial.
