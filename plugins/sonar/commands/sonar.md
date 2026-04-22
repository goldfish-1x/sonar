---
description: Ask anything about the codebase — get a briefing, trace a path, or answer a question. Works with or without a pre-built map.
argument-hint: <task, question, or "path A to B">
allowed-tools: Read, Bash, Glob, Grep, Agent
---

# /sonar

The single entry point for codebase understanding. Handles tasks, questions, and path tracing. Automatically adapts based on whether a `.sonar/` map exists.

## Step 1: Determine map state

```bash
ls .sonar/meta.json 2>/dev/null && echo "MAP_EXISTS" || echo "NO_MAP"
```

## Step 2: Detect intent from `$ARGUMENTS`

- Contains " to " (e.g., "auth to payments") → **path trace**
- Looks like a task (action verb: "add", "refactor", "implement", "fix", "change", "build") → **task briefing**
- Looks like a question ("how", "what", "where", "why", "who", "which", "does", "is") → **question answer**
- Default → **task briefing**

---

## Path: MAP EXISTS

### Intent: Task Briefing

1. **Search for relevant modules and flows.** Extract key terms from `$ARGUMENTS` and query:
```bash
sqlite3 .sonar/graph.db "SELECT key, purpose FROM modules_fts WHERE modules_fts MATCH '<terms>' ORDER BY rank LIMIT 8"
sqlite3 .sonar/graph.db "SELECT name, title FROM flows_fts WHERE flows_fts MATCH '<terms>' ORDER BY rank LIMIT 5"
```

Also read `.sonar/state.json` when present. Use it to:
- prefer fresh or higher-confidence artifacts
- warn when matched modules or flows are stale or queued
- surface queued semantic refresh when the answer may rely on stale narratives

2. **Read matched module cards.** For each top match, read `.sonar/modules/{key}.json`. Extract:
   - Purpose, business rules, conventions, public API with file:line, side effects

3. **Compute blast radius.** For each matched module:
```bash
sqlite3 .sonar/graph.db "SELECT source_module, weight FROM edges WHERE target_module = '<module>' ORDER BY weight DESC"
```

4. **Read matched flow narratives.** For each matched flow, read `.sonar/flows/{name}.json`.

5. **Read architecture context.** From `.sonar/system.json`, extract relevant patterns, conventions, load-bearing status.

6. **Format the briefing:**
```markdown
## Sonar Briefing: <task>

### Relevant Modules
- **module-key** (`path/`) — purpose
  - Conventions: ...
  - Business rules: ...

### Relevant Flows
- **flow-name** — title
  - Invariants: ...

### Freshness
- module-key: [fresh/stale/queued] — reason
- flow-name: [fresh/stale] — reason

### Blast Radius
- module-key depended on by: [list]

### Architecture Context
- Patterns, load-bearing status, tensions
```

### Intent: Question Answer

1. **Search the graph** with FTS across modules, symbols, and flows.
2. **Read matching cards** — `.sonar/modules/{key}.json` and `.sonar/flows/{name}.json`.
3. **For structural questions** ("depends on", "calls", "imports"), also query edges table.
4. **For architecture questions** ("why", "pattern", "convention"), read `system.json` and check `state.json` freshness first.
5. **Synthesize answer** with file:line references.

### Intent: Path Trace

1. **Parse source and target** — split `$ARGUMENTS` on " to ".
2. **Resolve to module keys:**
```bash
sqlite3 .sonar/graph.db "SELECT key FROM modules WHERE key = '<term>' OR name LIKE '%<term>%'"
```
3. **BFS shortest path:**
```bash
sqlite3 .sonar/graph.db "
WITH RECURSIVE path(module, depth, trail) AS (
  SELECT '<source>', 0, '<source>'
  UNION ALL
  SELECT e.target_module, p.depth + 1, p.trail || ' → ' || e.target_module
  FROM edges e JOIN path p ON e.source_module = p.module
  WHERE p.depth < 10 AND p.trail NOT LIKE '%' || e.target_module || '%'
)
SELECT trail, depth FROM path WHERE module = '<target>' ORDER BY depth LIMIT 1"
```
4. **Annotate each hop** with module card purpose and public API.
5. **Check for existing flow narratives** covering this path.

---

## Path: NO MAP

When `.sonar/` doesn't exist, perform a **targeted on-demand scan** instead of requiring a full crawl.

1. **Run skeleton on the whole codebase** (fast — seconds):
```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/build-skeleton.sh" . .sonar
```

2. **Search the skeleton** for modules matching the task keywords. Read `.sonar/skeleton.json`, find modules whose file names, function names, or import sources match the key terms.

3. **Spawn module-analyst agents for the top 3-5 relevant modules only.** Use `run_in_background: true`, ALL simultaneously. Each agent reads its files and writes a module card.

4. **Wait for agents to complete.** Read the resulting module cards.

5. **Build the SQLite index from whatever exists:**
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/build-db.mjs" .sonar
```

6. **Write meta.json** with current git SHA and timestamp.

7. **Format the briefing** using the same format as the MAP_EXISTS path.

8. **Tell the user:** "Sonar analyzed N modules relevant to your task. Run `/sonar crawl` for a complete map."

This gives the agent useful context in 2-3 minutes without requiring a full crawl. The partial results are cached in `.sonar/` — subsequent `/sonar` calls find them and only fill gaps.
