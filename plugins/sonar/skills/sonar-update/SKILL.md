---
name: sonar-update
description: Use when the user wants an incremental Sonar refresh after code changes, a pull, or a refactor.
user-invocable: true
---

# Sonar Update

Refresh only the parts of the map that changed.

## Workflow

1. Check `.sonar/meta.json`. If there is no map yet, send the user to `@sonar sonar-crawl`.
2. Resolve `SONAR_PLUGIN_ROOT` from this skill path.
3. Install Sonar dependencies if they are not already present:

```bash
(cd "$SONAR_PLUGIN_ROOT" && npm install --ignore-scripts)
```

4. Rebuild the skeleton:

```bash
bash "$SONAR_PLUGIN_ROOT/scripts/build-skeleton.sh" . .sonar
```

5. Detect change categories:

```bash
bash "$SONAR_PLUGIN_ROOT/scripts/detect-changes.sh" .sonar
```

6. Read `.sonar/state.json` and use it as the freshness and queue surface.
7. Re-analyze new or code-changed modules, refresh dependency-only modules without wasting semantic analysis, and remove deleted module cards.
8. Rebuild derived artifacts:

```bash
node "$SONAR_PLUGIN_ROOT/scripts/build-state.mjs" .sonar
node "$SONAR_PLUGIN_ROOT/scripts/build-db.mjs" .sonar
node "$SONAR_PLUGIN_ROOT/scripts/build-wiki.mjs" .sonar
```

## Output

Summarize:

- new modules analyzed
- changed modules re-analyzed
- dependency-only modules refreshed
- deleted modules removed
- flows or system synthesis rerun
- resulting coverage and freshness state

## Rules

- If there are no changes, say so and still report current coverage.
- Avoid expensive full recrawls when an incremental refresh is enough.
