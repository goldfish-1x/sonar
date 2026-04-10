---
description: Incremental map refresh — re-analyzes only modules affected by recent changes. Detects new modules, handles deletions, skips wasteful re-analysis of unchanged dependents.
allowed-tools: Bash, Read, Write, Glob, Grep, Agent
---

# /sonar update

Incrementally update the Sonar map by re-analyzing only what actually changed. Categorizes modules into new/changed/dependency-only/deleted and handles each appropriately — no wasted LLM calls on unchanged code.

## Protocol

1. **Check map exists.** If no `.sonar/meta.json`, tell the user to run `/sonar crawl` first.

2. **Re-run Phase 1 (skeleton).** Fast (~2-5 seconds):
```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/build-skeleton.sh" . .sonar
```

3. **Detect changes since last crawl:**
```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/detect-changes.sh" .sonar
```
This outputs categorized JSON:
- `code_changed` — modules whose own files were modified
- `new_modules` — modules in skeleton with no existing card
- `deleted_modules` — cards with no skeleton entry
- `dependency_only` — modules whose upstream changed but own code didn't

Then read:
```bash
cat .sonar/state.json 2>/dev/null
```
Use `state.json` as the primary freshness and queue view. Treat `detect-changes.sh` as the structural diff input and `state.json` as the runtime decision surface.

If no changes detected, show a coverage summary and exit:
```bash
TOTAL_SOURCE=$(find . -type f \( -name '*.py' -o -name '*.ts' -o -name '*.tsx' -o -name '*.js' -o -name '*.jsx' \) \
  -not -path '*/node_modules/*' -not -path '*/.venv/*' -not -path '*/dist/*' -not -path '*/.git/*' -not -path '*/.sonar/*' | wc -l)
MAPPED_FILES=$(sqlite3 .sonar/graph.db "SELECT COUNT(*) FROM files" 2>/dev/null || echo 0)
MODULE_COUNT=$(sqlite3 .sonar/graph.db "SELECT COUNT(*) FROM modules" 2>/dev/null || echo 0)
FLOW_COUNT=$(sqlite3 .sonar/graph.db "SELECT COUNT(*) FROM flows" 2>/dev/null || echo 0)
```
Report:
```
Map is up to date. Files: X/Y mapped (Z%). Modules: N. Flows: N.
```

4. **Report what will be updated:**
```
Sonar update: N files changed since last crawl
  New modules: [list]
  Code changed: [list]
  Dependency-only: [list] (edges refresh, no re-analysis)
  Deleted: [list]
Re-analyzing...
```

5. **Categorized Phase 2 re-analysis:**

   **New modules** — full module-analyst agents. These have no existing card. Spawn ALL in parallel with `run_in_background: true`.

   **Code-changed modules** — full module-analyst agents. Their code is different and needs fresh understanding. Spawn ALL in parallel with `run_in_background: true`.

   After all code-changed and new module agents complete:
   - **Submodule invalidation**: for each re-analyzed module, delete its stale submodule cards:
     ```bash
     rm -f .sonar/submodules/{module-key}-*.json
     ```
     The module-analyst will re-generate them via Step 4 if the module still has >150 files.

   **Dependency-only modules** — NO LLM re-analysis. Skip parent cards (`is_parent: true`) entirely. Their own code hasn't changed. Instead, update only the `dependencies` and `dependents` fields in their existing card by reading the new skeleton edges:
   ```bash
   # For each dependency-only module, read its card, update deps from skeleton edges:
   sqlite3 .sonar/graph.db "SELECT target_module FROM edges WHERE source_module = '<module>'"
   sqlite3 .sonar/graph.db "SELECT source_module FROM edges WHERE target_module = '<module>'"
   ```
   Patch the card JSON with the updated lists. This is a file operation, not an LLM call.

   **Deleted modules** — remove the card file:
   ```bash
   rm .sonar/modules/<deleted-key>.json
   ```

6. **Check flow impact.** Query which flows pass through code-changed or new modules:
```bash
sqlite3 .sonar/graph.db "SELECT DISTINCT flow_name FROM flow_steps WHERE module_key IN (<code-changed-and-new-modules>)"
```
If any flows are affected, re-run flow-tracer agents for those flows — ALL in parallel.

6b. **Parent card refresh.** After Phase 2 re-analysis completes:

   a. Re-run parent family detection:
   ```bash
   node -e "
     const fs = require('fs');
     const sk = JSON.parse(fs.readFileSync('.sonar/skeleton.json','utf8'));
     const moduleKeys = Object.keys(sk.modules).filter(k => !k.startsWith('_test_'));
     const prefixChildren = {};
     for (const key of moduleKeys) {
       const parts = key.split('-');
       if (parts.length < 2) continue;
       const prefix = parts.slice(0, -1).join('-');
       if (prefix.length < 2) continue;
       if (!prefixChildren[prefix]) prefixChildren[prefix] = [];
       prefixChildren[prefix].push(key);
     }
     const families = Object.entries(prefixChildren)
       .filter(([prefix, children]) => children.length >= 2 && !moduleKeys.includes(prefix))
       .map(([parent, children]) => ({ parent, children }));
     console.log(JSON.stringify(families));
   "
   ```

   b. For each family, check if any child was in `code_changed` or `new_modules`:
      - Delete `.sonar/modules/{parent-key}.json` if it exists
      - Spawn a `parent-synthesizer` agent for that family

   c. Handle deletion edge cases:
      - If a deleted module was the only sibling in a family (leaving 1 child), delete the parent card and do not recreate it
      - If a deleted module was one of 2+ siblings, run parent synthesis for the remaining children

7. **Smart synthesis trigger.** Read `.sonar/state.json` first:

Use:
- `refresh.semantic.status`
- `system.pending_actions`
- `queue.modules`
- `queue.flows`
- `queue.system`

   **Re-run synthesis if ANY of:**
   - A load-bearing module (from `system.json` `load_bearing` list) had code changes
   - New modules were added (topology changed)
   - Modules were deleted (topology changed)

   **Skip synthesis if** only dependency-only modules were refreshed or only non-load-bearing modules had minor changes.

   When re-running, pass the synthesizer a diff hint: which modules changed and what kind of change (new/modified/deleted), so it can focus its analysis.

8. **Rebuild SQLite index + pre-computed lookups:**
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/build-state.mjs" .sonar
node "${CLAUDE_PLUGIN_ROOT}/scripts/build-db.mjs" .sonar
node "${CLAUDE_PLUGIN_ROOT}/scripts/build-wiki.mjs" .sonar
```

9. **Update meta.json** with new git SHA, timestamp, and updated stats.

10. **Report results:**
```
Sonar update complete.
  New modules analyzed: X
  Modules re-analyzed: Y
  Dependency edges refreshed: Z
  Deleted modules removed: W
  Flows re-traced: F
  Synthesis: [re-run (reason) / skipped]
  Coverage: A / B files mapped (C%)
```
