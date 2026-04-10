---
description: Post-change consistency check — runs convention checks, dependency verification, and flow integrity against the map.
allowed-tools: Read, Bash, Glob, Grep
---

# /sonar verify

Run after making changes to verify consistency with the codebase's conventions, dependencies, and flows. Uses the actionable `check` commands from module cards and system.json to detect violations automatically.

## Protocol

1. **Check map exists.** If no `.sonar/graph.db`, rebuild or suggest `/sonar crawl`.

2. **Detect modified files:**
```bash
git diff --name-only HEAD 2>/dev/null || git diff --name-only
git diff --name-only --cached 2>/dev/null
```

3. **Map files to modules.** For each modified file:
```bash
sqlite3 .sonar/graph.db "SELECT module_key FROM files WHERE path = '<relative-path>'"
```

4. **Run convention checks.** For each affected module, read `.sonar/modules/{key}.json`. For each convention that has a `check` field:

   a. Substitute `{files}` in the check command with the module's actual file paths.
   b. Run the check command via Bash.
   c. If the command returns output (non-empty), the convention is VIOLATED — report it.
   d. If the command returns empty, the convention is FOLLOWED — report PASS.

   Example: convention `{"rule": "All handlers use @with_rate_limit", "check": "grep -rn 'def.*handler' {files} | grep -v '@with_rate_limit'"}` → run the grep, if any lines match, the convention is broken.

   For conventions without a `check` field, report them as SKIP (manual verification needed).

5. **Run system-level convention checks.** Read `.sonar/system.json`. For each convention with a `check` field, run the check command (these are global checks, not scoped to one module).

6. **Dependency check.** For each affected module, query its dependents:
```bash
sqlite3 .sonar/graph.db "SELECT source_module FROM edges WHERE target_module = '<module>'"
```
For each dependent, verify the modified code still exports what dependents expect. Grep for the module's `public_api` function names in the modified files — are they still present?

7. **Flow integrity check.** Find flows passing through affected modules:
```bash
sqlite3 .sonar/graph.db "SELECT flow_name, step_order, function_name FROM flow_steps WHERE module_key IN (<affected-modules>)"
```
Read those flow narratives. Check if entry/exit function signatures changed.

8. **Check domain overlaps.** Read `.sonar/system.json` `domain_overlaps`. If the modified modules appear in any overlap, flag it:
```
⚠ Module "checkout" shares domain concept "pricing" with "billing" —
  verify your change doesn't diverge from the pricing logic in billing.
```

9. **Detect unmapped files:**
```bash
git diff --name-only --diff-filter=A HEAD
```

10. **Format verification report:**

```markdown
## Sonar Verification Report

### Files Modified
- `file` (module: **key**)

### Convention Checks (automated)
- [PASS] module: "All handlers use @with_rate_limit" — 0 violations
- [FAIL] module: "All exported functions have JSDoc" — 2 violations:
  - `src/api/routes.ts:45: export function createOrder`
  - `src/api/routes.ts:89: export function cancelOrder`
- [SKIP] module: "Error messages must be user-friendly" — no check command, verify manually

### System Convention Checks
- [PASS] "All Python execution uses uv run" — 0 violations
- [FAIL] "MCP servers must call load_dotenv()" — 1 violation:
  - `src/goldfish/mcp/new_server.py` missing load_dotenv

### Domain Overlap Warnings
- ⚠ "checkout" shares "pricing" with "billing" — verify consistency

### Dependency Checks
- [PASS] dependent-module: exports still present
- [WARN] dependent-module: function signature changed — manual check needed

### Flow Integrity
- [PASS] flow-name: entry/exit unchanged
- [WARN] flow-name: step N function signature changed

### Business Rules at Risk
- Rule: "Analysis failure does NOT block entity creation" (source: convex/analysis.ts:145)
  — you modified this file. Verify this rule still holds.

### Unmapped Files
- `new-file.ts` — not in any module card. Run `/sonar update` to map.

### Recommended Actions
1. [numbered list of things to fix or verify]
```
