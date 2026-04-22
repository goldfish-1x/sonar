---
name: sonar-graph
description: This skill should be used when interpreting .sonar/ map data, querying graph.db, or working with Sonar module cards, flow narratives, and system understanding. Provides JSON schemas and SQLite query patterns.
user-invocable: false
---

# Sonar Graph — Data Model Reference

## .sonar/ Directory Layout

```
.sonar/
├── meta.json          — Crawl metadata (git SHA, timestamps, stats)
├── skeleton.json      — Structural graph (imports, exports, functions, calls)
├── modules/*.json     — Module cards (one per logical module)
├── flows/*.json       — Flow narratives (entry→exit paths)
├── system.json        — System understanding (domain model, patterns, architecture)
└── graph.db           — SQLite query index (gitignored, rebuilt from JSON)
```

## Module Card Schema

Each `.sonar/modules/{key}.json`:

| Field | Type | Description |
|-------|------|-------------|
| key | string | Kebab-case module identifier |
| name | string | Human-readable module name |
| path | string | Directory path |
| files | string[] | Source files in this module |
| purpose | string | ONE sentence — why this module exists |
| business_rules | object[] | Domain rules with source location: `{rule, source}` |
| conventions | object[] | Actionable patterns with check commands: `{rule, check, scope}` |
| public_api | object[] | Exported functions with file + line |
| dependencies | string[] | Module keys this depends on |
| dependents | string[] | Module keys that depend on this |
| side_effects | string[] | External interactions (DB, API, file I/O) |
| function_cards | object[] | Significant function documentation |

## Function Card Schema (nested in module card)

| Field | Type | Description |
|-------|------|-------------|
| name | string | Function name |
| file | string | File path |
| line | integer | Line number |
| purpose | string | What this function accomplishes and WHY |
| side_effects | string[] | External effects |
| called_by | string[] | Callers |
| calls | string[] | Callees |
| error_behavior | string | How errors are handled |

## Business Rule Schema (nested in module card)

```json
{"rule": "Analysis failure does NOT block entity creation", "source": "convex/analysis.ts:145"}
```

- `rule`: human-readable domain rule (not infrastructure)
- `source`: file:line where this rule is encoded — allows direct verification

## Convention Schema (nested in module card and system.json)

```json
{
  "rule": "All exported functions have JSDoc",
  "check": "grep -B1 '^export function' {files} | grep -v '@' | grep 'export function'",
  "scope": "this module"
}
```

- `rule`: human-readable convention
- `check`: bash/grep command that DETECTS VIOLATIONS. Returns empty if followed, returns lines if violated. Use `{files}` as placeholder for module file paths.
- `scope`: "this module", "callers", or "global"

`/sonar verify` runs these check commands automatically against modified files.

## Flow Narrative Schema

Each `.sonar/flows/{name}.json`:

| Field | Type | Description |
|-------|------|-------------|
| name | string | Kebab-case flow identifier |
| title | string | Human-readable flow description |
| entry | object | Entry point {file, function, line} |
| exit | object | Exit point {file, function, line} |
| steps | object[] | Ordered list of {order, module, function, file, line, what, data} |
| invariants | string[] | Conditions that must always hold |
| failure_modes | string[] | What happens when steps fail |

## SQLite Query Patterns

**Search modules by keyword:**
```sql
SELECT key, name, purpose FROM modules_fts WHERE modules_fts MATCH '"keyword1" OR "keyword2"' ORDER BY rank LIMIT 5
```

**Find dependents (who depends on X):**
```sql
SELECT source_module, kind, weight FROM edges WHERE target_module = 'module-key' ORDER BY weight DESC
```

**Find dependencies (what X depends on):**
```sql
SELECT target_module, kind, weight FROM edges WHERE source_module = 'module-key' ORDER BY weight DESC
```

**Trace path between modules (BFS):**
```sql
WITH RECURSIVE path(module, depth, trail) AS (
  SELECT 'source-key', 0, 'source-key'
  UNION ALL
  SELECT e.target_module, p.depth + 1, p.trail || ' → ' || e.target_module
  FROM edges e JOIN path p ON e.source_module = p.module
  WHERE p.depth < 10 AND p.trail NOT LIKE '%' || e.target_module || '%'
)
SELECT trail, depth FROM path WHERE module = 'target-key' ORDER BY depth LIMIT 1
```

**Find flows through a module:**
```sql
SELECT DISTINCT flow_name FROM flow_steps WHERE module_key = 'module-key'
```

**Map file to module:**
```sql
SELECT module_key FROM files WHERE path = 'relative/path/to/file.ts'
```

## Edge Types

| Kind | Meaning |
|------|---------|
| imports | Source module imports from target module |
| calls | Source module calls functions in target module |
| extends | Source module extends/implements types from target |

## system.json Structure

- `domain_model[]` — Business concepts with definitions and owning modules
- `domain_overlaps[]` — Concepts owned by multiple modules (potential duplication risk): `{concept, modules, concern}`
- `patterns[]` — Recurring code patterns with descriptions and locations
- `conventions[]` — Rules with scope and actionable check commands: `{rule, check, scope}`
- `architecture.layers[]` — Architectural layers with modules and roles
- `load_bearing[]` — Module keys with highest fan-in
- `tensions[]` — Architectural conflicts and their resolutions
