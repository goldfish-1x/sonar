---
name: sonar-impact
description: Use when the user wants first, second, and third-order impact analysis for a proposed change using the Sonar map.
user-invocable: true
---

# Sonar Impact

Simulate the ripple effects of a proposed change before implementation.

## Workflow

1. Check `.sonar/graph.db` and `.sonar/state.json`.
2. Resolve the target module or file from the user request.
3. Use `.sonar/graph.db` to compute:
- first-order dependents
- second-order transitive dependents
- third-order awareness radius

4. Read the direct dependent module cards from `.sonar/modules/*.json`.
5. Read affected flow narratives from `.sonar/flows/*.json`.
6. Read `.sonar/system.json` for convention or architecture conflicts.

## Output

Return:

- the target module or files
- first-order breakage candidates
- second-order testing surface
- third-order awareness surface
- affected flows and invariants
- convention conflicts
- freshness warnings

## Rules

- Be concrete about why a dependent is in the radius.
- Use confidence levels. First-order is usually high confidence; wider rings should degrade.
- If the target area is stale, say that the analysis may lag the current code.
