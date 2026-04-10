---
description: Show map health — freshness, coverage stats, and stale areas.
allowed-tools: Read, Bash
---

# /sonar status

Show the current state of the Sonar map.

## Protocol

1. **Check map exists.** If no `.sonar/` directory, report "No Sonar map found. Run `/sonar crawl` to build one."

2. **Read meta.json:**
```bash
cat .sonar/meta.json 2>/dev/null
```

3. **Read state.json first.**
```bash
cat .sonar/state.json 2>/dev/null
```
Use this as the primary source for:
- structural freshness
- semantic freshness
- queued modules / flows / system refresh
- per-module stale reasons

4. **Count coverage:**
```bash
# Total source files in repo
find . -type f \( -name '*.py' -o -name '*.ts' -o -name '*.tsx' -o -name '*.js' -o -name '*.jsx' \) \
  -not -path '*/node_modules/*' -not -path '*/.venv/*' -not -path '*/dist/*' -not -path '*/.git/*' -not -path '*/.sonar/*' | wc -l

# Mapped files
sqlite3 .sonar/graph.db "SELECT COUNT(*) FROM files" 2>/dev/null

# Modules, flows, functions
sqlite3 .sonar/graph.db "SELECT COUNT(*) FROM modules" 2>/dev/null
sqlite3 .sonar/graph.db "SELECT COUNT(*) FROM flows" 2>/dev/null
sqlite3 .sonar/graph.db "SELECT COUNT(*) FROM symbols WHERE kind = 'function'" 2>/dev/null
```

5. **Format status report from `state.json`.**

```markdown
## Sonar Map Status

| Metric | Value |
|--------|-------|
| Last crawl | <date> (<age>) |
| Git SHA | <sha> (current: <current>) |
| Files mapped | X / Y (Z% coverage) |
| Modules | N |
| Flows | N |
| Functions | N |

### Freshness
- Structural: [fresh/stale/unknown] — reason
- Semantic: [fresh/stale/queued/unknown] — reason

### Queued Refresh
- Modules: [list]
- Flows: [list]
- System: [queued/not queued]

### Affected Areas
- Stale modules with reasons: [list]
- Stale flows with reasons: [list]

### Recommended Action
- ["/sonar update" if few changes, "/sonar crawl --full" if many]
```
