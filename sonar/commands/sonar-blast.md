---
description: Full dependency and impact analysis for a module or function — who depends on it, what breaks if it changes.
argument-hint: <module name or function name>
allowed-tools: Read, Bash, Grep
---

# /sonar blast

Show the complete blast radius of a module — everything that depends on it, directly and transitively.

## Protocol

1. **Check map exists.** If no `.sonar/graph.db`, rebuild or suggest `/sonar crawl`.

2. **Resolve target.** Find the module from `$ARGUMENTS`:
```bash
sqlite3 .sonar/graph.db "SELECT key, purpose FROM modules WHERE key = '<term>' OR name LIKE '%<term>%'"
# Fallback to FTS
sqlite3 .sonar/graph.db "SELECT key, purpose FROM modules_fts WHERE modules_fts MATCH '<term>' LIMIT 3"
```

3. **Compute full blast radius** (depth 3):
```bash
# Direct dependents (depth 1)
sqlite3 .sonar/graph.db "SELECT source_module, kind, weight FROM edges WHERE target_module = '<target>' ORDER BY weight DESC"

# Transitive (depth 2)
sqlite3 .sonar/graph.db "SELECT DISTINCT e2.source_module FROM edges e1 JOIN edges e2 ON e1.source_module = e2.target_module WHERE e1.target_module = '<target>'"

# Transitive (depth 3)
sqlite3 .sonar/graph.db "SELECT DISTINCT e3.source_module FROM edges e1 JOIN edges e2 ON e1.source_module = e2.target_module JOIN edges e3 ON e2.source_module = e3.target_module WHERE e1.target_module = '<target>'"
```

4. **Read target module card.** From `.sonar/modules/{key}.json`, extract purpose, public API, conventions.

5. **Read 1st-order dependent cards.** For each direct dependent, read its module card.

6. **Count fan metrics:**
```bash
# Fan-out: what target depends on
sqlite3 .sonar/graph.db "SELECT COUNT(*) FROM edges WHERE source_module = '<target>'"
# Fan-in: what depends on target
sqlite3 .sonar/graph.db "SELECT COUNT(*) FROM edges WHERE target_module = '<target>'"
```

7. **Check load-bearing status.** Read `.sonar/system.json` — is the target in the `load_bearing` list?

8. **Format blast radius report:**

```markdown
## Blast Radius: <target>

**<target>** (`path/`) — purpose
Fan-in: N modules depend on this | Fan-out: depends on M modules
Load-bearing: YES/NO

### Direct Dependents (1st order)
| Module | How it uses <target> | Edge type | Weight |
|--------|---------------------|-----------|--------|
| module | via public_api.X | imports | N |

### Transitive Dependents (2nd order)
- module1, module2, module3 (N total)

### Deep Dependents (3rd order)
- module4, module5 (N total)

### What This Module Exports
- `funcName` (file:line) — purpose
- `funcName2` (file:line) — purpose

### Conventions to Preserve
- convention 1
- convention 2
```
