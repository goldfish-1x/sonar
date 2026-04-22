---
description: Simulate first, second, and third-order effects of a proposed change. Shows what breaks, what shifts, what needs updating.
argument-hint: <proposed change description>
allowed-tools: Read, Bash, Glob, Grep
---

# /sonar impact

Simulate the cascading effects of a proposed change before writing any code. Returns a structured impact analysis with confidence levels.

## Protocol

1. **Check map exists.** If no `.sonar/graph.db`, rebuild or suggest `/sonar crawl`.

2. **Identify target modules.** Extract key terms from `$ARGUMENTS`. Search modules:
```bash
sqlite3 .sonar/graph.db "SELECT key, purpose FROM modules_fts WHERE modules_fts MATCH '<terms>' ORDER BY rank LIMIT 5"
```
Also check if `$ARGUMENTS` mentions specific files — map them to modules:
```bash
sqlite3 .sonar/graph.db "SELECT module_key FROM files WHERE path LIKE '%<filename>%'"
```

3. **Compute impact cascade.** For each target module, run a recursive reverse-dependency traversal (depth 3):
```bash
# 1st order: direct dependents
sqlite3 .sonar/graph.db "SELECT source_module, kind, weight FROM edges WHERE target_module = '<target>'"

# 2nd order: dependents of dependents
sqlite3 .sonar/graph.db "SELECT e2.source_module, e2.kind FROM edges e1 JOIN edges e2 ON e1.source_module = e2.target_module WHERE e1.target_module = '<target>' AND e2.source_module != '<target>'"

# 3rd order: one more hop
sqlite3 .sonar/graph.db "SELECT DISTINCT e3.source_module FROM edges e1 JOIN edges e2 ON e1.source_module = e2.target_module JOIN edges e3 ON e2.source_module = e3.target_module WHERE e1.target_module = '<target>' AND e3.source_module != '<target>'"
```

4. **Read module cards for 1st-order dependents.** For each direct dependent, read `.sonar/modules/{key}.json` to understand:
   - How it uses the target module (check its dependencies and public_api references)
   - Whether the proposed change conflicts with its conventions
   - What side effects might be affected

5. **Check flow integrity.** Query which flows pass through the target module:
```bash
sqlite3 .sonar/graph.db "SELECT flow_name, step_order, function_name FROM flow_steps WHERE module_key = '<target>'"
```
Read those flow narratives to understand if the change breaks invariants.

6. **Check freshness and queue state.** Read `.sonar/state.json` when present:
- if the target module is already stale or queued, say so explicitly
- if affected flows are stale, downgrade confidence
- if system refresh is queued, note that architecture guidance may lag behind the code

7. **Check architecture decisions.** Read `.sonar/system.json` — does the proposed change violate any conventions or tensions?

8. **Format the impact cascade:**

```markdown
## Impact Analysis: <proposed change>

### Target
- **module-key** (`path/`) — purpose

### 1st Order (direct — likely need code changes)
- **dependent-module** (`path/`) — HOW it uses the target, WHAT breaks
  - Files: file:line, file:line
  - Confidence: HIGH

### 2nd Order (transitive — need testing)
- **module** — path through which the effect propagates
  - Confidence: MEDIUM

### 3rd Order (awareness — unlikely to break)
- **module** — why it's in the radius
  - Confidence: LOW

### Affected Flows
- **flow-name**: step N uses target module. Change affects: ...
  - Freshness: [fresh/stale]

### Convention Conflicts
- [list any conflicts with conventions in dependent modules]

### Freshness Warnings
- [queued semantic refresh, stale module cards, stale flows]

### Summary
- X modules need code changes
- Y modules need testing
- Z modules in awareness radius
```
