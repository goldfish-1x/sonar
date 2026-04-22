---
description: Build and serve the Sonar knowledge workspace. Generates the shared snapshot, markdown outputs, typed search, and graph workspace.
argument-hint: [port]
allowed-tools: Bash
---

# /sonar wiki

Build and serve the Sonar knowledge workspace locally.

## Steps

1. **Check that `.sonar/meta.json` exists.** If not, tell the user to run `/sonar crawl` first.

2. **Build the shared snapshot and wiki artifacts from the map:**
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/build-wiki.mjs" .sonar
```

3. **Start the wiki server:**
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/serve-wiki.mjs" .sonar {PORT}
```
Where {PORT} is `$ARGUMENTS` if provided, otherwise `3456`.

Tell the user:
- `Sonar Workspace -> http://localhost:{PORT}`
- `Search -> http://localhost:{PORT}/search`
- `Graph -> http://localhost:{PORT}/graph`
