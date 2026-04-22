---
description: Launch the interactive Sonar graph workspace. Optionally focus on a module immediately.
argument-hint: [module-key]
allowed-tools: Bash
---

# /sonar graph

Open the interactive Sonar graph workspace. This is the primary graph experience now: overview, module graph, neighborhood focus, impact view, flow overlays, and path tracing.

## Protocol

1. **Check map exists.** If no `.sonar/graph.db`, suggest `/sonar crawl`.

2. **Build the shared knowledge snapshot and wiki artifacts:**
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/build-wiki.mjs" .sonar
```

3. **Start the local Sonar workspace server** on port `3456` unless the user asked for a different port:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/serve-wiki.mjs" .sonar 3456
```

4. **Choose the initial graph route:**
- If `$ARGUMENTS` contains a module key, use:
  `http://localhost:3456/graph?mode=focus&module=<module-key>`
- Otherwise use:
  `http://localhost:3456/graph?mode=overview`

5. **Tell the user what they can do there:**
- switch between overview, module, focus, impact, flow, and path modes
- click nodes to open module pages
- use the search bar and typed search to jump between graph and wiki surfaces

6. **Report:** `Sonar Graph Workspace -> http://localhost:3456/graph[...]`
