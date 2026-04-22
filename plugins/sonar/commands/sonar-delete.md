---
description: Compute the precise deletion surface for removing a module or feature — what to delete, what to edit, what to keep. Use when removing, cleaning up, or ripping out code. Eliminates agent hesitation around code removal.
argument-hint: <module name, file path, or feature description>
allowed-tools: Read, Bash, Glob, Grep
---

# /sonar delete

Compute the complete deletion surface for a feature, module, or file. Produces an executable deletion manifest: which files to remove, which files to edit (remove imports), which shared dependencies to keep, and grep commands to verify clean removal.

**Your job is to give the agent a precise, assertive plan. Use DELETE language, not "consider removing."**

## Protocol

1. **Check map exists.** If no `.sonar/graph.db`, suggest `/sonar crawl` first — deletion analysis requires the full dependency graph.

2. **Resolve target.** Find the module(s) to delete from `$ARGUMENTS`:

   If it looks like a module key:
   ```bash
   sqlite3 .sonar/graph.db "SELECT key, purpose FROM modules WHERE key = '<term>'"
   ```

   If it looks like a file path:
   ```bash
   sqlite3 .sonar/graph.db "SELECT module_key FROM files WHERE path LIKE '%<term>%'"
   ```

   If it's a feature description, use FTS:
   ```bash
   sqlite3 .sonar/graph.db "SELECT key, purpose FROM modules_fts WHERE modules_fts MATCH '<terms>' ORDER BY rank LIMIT 5"
   ```

   If more than 3 modules match, show them with their purpose and ask the user to confirm which to delete. Do not proceed until the target set is clear.

   If no modules match, tell the user: "No module found matching '<term>'. Check the module key or run `/sonar crawl` to build the map." Stop here.

3. **Read target module card.** For each target module, read `.sonar/modules/{key}.json`. Extract:
   - `purpose` (for the output header)
   - `public_api` (for precise VERIFY grep patterns)
   - `conventions` (to note in the output if consumers relied on them)
   - `files` (cross-check against the files table)

4. **Load-bearing early warning.** Check fan-in and load-bearing status:
   ```bash
   sqlite3 .sonar/graph.db "SELECT COUNT(*) FROM edges WHERE target_module = '<target>'"
   ```
   Read `.sonar/system.json` — check the `load_bearing` list.

   If fan-in >= 5, emit a bold warning at the top of the output:
   > **WARNING: `<target>` is a load-bearing module.** N modules depend on it. The EDIT section will be large. Deletion is a major operation — confirm this is intentional before proceeding.

   **Proceed with the analysis regardless.** The warning is informational.

5. **Compute DELETE set** — target + exclusive dependencies.

   First, get the target's own files:
   ```bash
   sqlite3 .sonar/graph.db "SELECT path, lines FROM files WHERE module_key = '<target>'"
   ```

   Then find exclusive dependencies using an iterative approach. **Track a visited set to prevent infinite loops from circular dependencies.**

   ```bash
   # Step 1: What does the target depend on?
   sqlite3 .sonar/graph.db "SELECT target_module FROM edges WHERE source_module = '<target>'"

   # Step 2: For each dependency, check consumers OUTSIDE the delete set
   sqlite3 .sonar/graph.db "
     SELECT e.target_module,
            COUNT(DISTINCT CASE WHEN e.source_module NOT IN (<delete-set-keys>) THEN e.source_module END) as external_consumers,
            GROUP_CONCAT(DISTINCT e.source_module) as all_consumers
     FROM edges e
     WHERE e.target_module IN (
       SELECT target_module FROM edges WHERE source_module IN (<delete-set-keys>)
     )
     AND e.target_module NOT IN (<delete-set-keys>)
     GROUP BY e.target_module
   "
   ```

   Dependencies where `external_consumers = 0` → add to DELETE set. Then repeat: check if the newly added modules have their own exclusive dependencies. Continue until no new modules are added. Skip any module already visited to avoid circular dependency loops.

   For each module in the DELETE set, collect its files:
   ```bash
   sqlite3 .sonar/graph.db "SELECT path, lines FROM files WHERE module_key IN (<delete-set-keys>)"
   ```

   Also find test files by path pattern — for each deleted file, look for corresponding test files:
   ```bash
   # For each deleted file like src/auth/middleware.ts, search for:
   #   tests/auth/middleware.test.ts, src/auth/middleware.test.ts,
   #   src/auth/__tests__/middleware.ts, etc.
   ```

   If the delete set is empty (no files found), tell the user the module has no mapped files and suggest running `/sonar update`.

6. **Compute EDIT set** — files that import from the DELETE set.

   Read `.sonar/symbol-imports.json`. For each file in the DELETE set, collect all importers:
   - The file path of the importer
   - The symbol name being imported
   - The import line number

   Group by importer file. For each importer, also read the actual file to find:
   - The exact import statement (for the deletion instruction)
   - Any other references to the imported symbols beyond the import line (usage sites)

   Use Grep to find usage lines:
   ```bash
   grep -n '<symbol-name>' <importer-file>
   ```

   Format each entry as a specific instruction: "line N: `<code>` — DELETE this line"

7. **Compute KEEP set** — shared dependencies NOT in the DELETE set.

   These are modules the target depends on that have consumers OUTSIDE the delete set:
   ```bash
   sqlite3 .sonar/graph.db "
     SELECT e.target_module,
            GROUP_CONCAT(DISTINCT CASE WHEN e.source_module NOT IN (<delete-set-keys>) THEN e.source_module END) as external_consumers
     FROM edges e
     WHERE e.target_module IN (
       SELECT target_module FROM edges WHERE source_module IN (<delete-set-keys>)
     )
     AND e.target_module NOT IN (<delete-set-keys>)
     GROUP BY e.target_module
     HAVING COUNT(DISTINCT CASE WHEN e.source_module NOT IN (<delete-set-keys>) THEN e.source_module END) > 0
   "
   ```

   For each kept module, list who else uses it (excluding the delete set). Read its module card for the purpose.

   Format: `module-key (path/) — also used by: X, Y, Z`

8. **Check flow integrity.** Find flows passing through the DELETE set:
   ```bash
   sqlite3 .sonar/graph.db "
     SELECT DISTINCT flow_name, step_order, function_name, module_key
     FROM flow_steps
     WHERE module_key IN (<delete-set-keys>)
     ORDER BY flow_name, step_order
   "
   ```

   For each affected flow, read `.sonar/flows/{name}.json`:
   - Count how many of the flow's total steps are in the DELETE set
   - If ALL steps are deleted → flow is REMOVED entirely
   - If SOME steps are deleted → flow is BROKEN, needs redesign
   - List which specific steps are removed

9. **Edge cases.** Check for:

   **Re-exports:** If any file in the EDIT set re-exports symbols from the DELETE set (barrel files, index.ts), those re-export lines need removal AND downstream consumers of the barrel may need import path changes. Check:
   ```bash
   grep -rn "export.*from.*<deleted-module-path>" <edit-set-files>
   ```

   **Config/registration files:** Search for references in non-code files:
   ```bash
   grep -rn '<target-module-key>\|<target-file-names>' .env* tsconfig.json package.json *.config.* 2>/dev/null
   ```

   **Route registrations / plugin registrations:** If the deleted module is registered somewhere (app.use, router.register, plugin list), those registrations need removal too. Search broadly:
   ```bash
   grep -rn '<primary-export-names>' src/ --include='*.ts' --include='*.py' | grep -v '<delete-set-files>'
   ```

10. **Build VERIFY commands.** Collect all exported symbol names from the DELETE set:
   ```bash
   sqlite3 .sonar/graph.db "SELECT DISTINCT name FROM symbols WHERE module_key IN (<delete-set-keys>) AND is_exported = 1"
   ```

   Also collect module paths and file names. Build grep patterns:
   - Symbol names: `grep -r 'Symbol1\|Symbol2\|Symbol3' src/ --include='*.ts'`
   - Import paths: `grep -r 'from.*<deleted-path>' src/ --include='*.ts'`
   - Expected result: empty (no remaining references)

11. **Format the deletion manifest.** Use the output format below. Be assertive. Use "DELETE" and "REMOVE", not "consider" or "might want to."

## Output Format

```markdown
## Deletion Plan: <target>

**<target>** (`path/`) — purpose
Fan-in: N | Fan-out: M

> WARNING (only if load-bearing): ...

### DELETE (N files, ~X lines)

Remove these files. They exist only to serve `<target>`.

**<module-key>** (target):
  `path/file1.ts` (N lines)
  `path/file2.ts` (N lines)

**<exclusive-dep>** (exclusive dependency — only used by <target>):
  `path/file3.ts` (N lines)

**Tests:**
  `tests/path/file1.test.ts`

### EDIT (N files)

Remove imports and references to deleted code.

**`path/consumer.ts`**:
  line 3: `import { X, Y } from '../deleted/module'` — DELETE this import
  line 15: `X.doSomething()` — DELETE this line
  line 42: `const result = Y()` — DELETE this line (or replace with alternative)

### KEEP (N modules)

Do NOT delete. These are shared dependencies still used by other code.

  `path/shared.ts` (**shared-module**) — also used by: billing, webhooks
  `path/types.ts` (**types**) — also used by: profile, settings

### FLOWS AFFECTED

  **flow-name**: step N (`functionName`) is REMOVED. Remaining steps still work.
  **flow-name**: BROKEN — N of M steps are in the DELETE set. Needs redesign.

### VERIFY

Run after deletion to confirm clean removal:

```bash
grep -r 'Symbol1\|Symbol2\|Symbol3' src/ --include='*.ts' --include='*.tsx'
# Expected: empty (no remaining references)

grep -r 'from.*deleted/path' src/ --include='*.ts'
# Expected: empty (no remaining imports)
```

### Summary

  DELETE: N files (X lines)
  EDIT: M files (Y lines to remove)
  KEEP: K shared dependencies
  FLOWS: F affected
```

## Tone

This command exists because agents hesitate to delete. Counter that:
- "Remove these files" not "these files may be candidates for removal"
- "DELETE this import" not "consider removing this import"
- "They exist only to serve X" — this gives permission
- "Do NOT delete" in the KEEP section — equally assertive about what to preserve
- "Nothing else references X after these changes" — this is the confidence the agent needs
