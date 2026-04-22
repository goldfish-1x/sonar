---
name: sonar-workspace
description: Use when the user wants to build or open Sonar's local workspace UI for wiki, search, or graph exploration.
user-invocable: true
---

# Sonar Workspace

Build and serve Sonar's local knowledge workspace.

## Workflow

1. Check `.sonar/meta.json`. If missing, say a Sonar map must exist first.
2. Resolve `SONAR_PLUGIN_ROOT` from this skill path.
3. Build the workspace artifacts:

```bash
node "$SONAR_PLUGIN_ROOT/scripts/build-wiki.mjs" .sonar
```

4. Start the local server:

```bash
node "$SONAR_PLUGIN_ROOT/scripts/serve-wiki.mjs" .sonar <port>
```

Use the user-provided port or default to `3456`.

## Output

Provide the local URLs:

- workspace home
- search view
- graph view

If the user asked for a specific module, point them directly at the focus graph route.
