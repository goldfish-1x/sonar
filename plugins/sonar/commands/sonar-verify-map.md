---
description: Spot-check module cards against actual code to verify the map is accurate.
allowed-tools: Read, Bash, Glob, Grep
---

# /sonar verify-map

Verify the Sonar map's accuracy by spot-checking module card claims against the actual source code.

## Protocol

1. **Check map exists.** If no `.sonar/modules/`, tell the user to run `/sonar crawl` first.

2. **Select modules to verify.** Pick 5-8 module cards. Prefer:
   - Modules with the highest fan-in (most depended on — errors here cascade)
   - A mix of large and small modules
   - At least one module the user has been working on recently

```bash
# Find modules by fan-in
sqlite3 .sonar/graph.db "SELECT target_module, COUNT(*) as fan_in FROM edges GROUP BY target_module ORDER BY fan_in DESC LIMIT 8" 2>/dev/null
# Or just list all modules
ls .sonar/modules/
```

3. **For each selected module, verify these claims:**

   **a. Purpose check** — read the module's main file. Does the purpose statement accurately describe what the code does?

   **b. Public API check** — for each function listed in `public_api`, verify it exists at the stated file:line:
   ```bash
   # Example: check if function exists at claimed location
   grep -n "function_name\|def function_name" <file>
   ```

   **c. Dependency check** — verify dependencies listed in the card match actual imports:
   ```bash
   grep -rn "^import\|^from" <module-files> --include="*.py" --include="*.ts"
   ```
   Compare against the card's `dependencies` list.

   **d. Convention check** — for each convention claimed, grep for counter-examples:
   - If convention says "all handlers use decorator X", grep for handlers WITHOUT it
   - If convention says "errors bubble up, not caught", grep for try/catch in the module

   **e. Cross-consistency** — if module A says `dependents: [B]`, check that module B says `dependencies: [A]`.

4. **Run flow step verification.** For 2-3 flows, check that each step's module key matches a real module card:
```bash
# Check flow step module keys exist as module cards
for flow in .sonar/flows/*.json; do
  node -e "
    const f = JSON.parse(require('fs').readFileSync('$flow','utf8'));
    for (const s of f.steps || []) {
      const card = '.sonar/modules/' + s.module + '.json';
      if (!require('fs').existsSync(card)) console.log('MISSING: ' + s.module + ' in flow ' + f.name);
    }
  "
done
```

5. **Format verification report:**

```markdown
## Sonar Map Verification

### Modules Checked: N/M

| Module | Purpose | API | Deps | Conventions | Cross-ref |
|--------|:-------:|:---:|:----:|:-----------:|:---------:|
| key    | PASS    | PASS| WARN | PASS        | PASS      |

### Issues Found
- [list of specific discrepancies with file:line evidence]

### Flow Step Consistency
- X/Y flows have all steps mapped to real modules
- Missing module keys: [list if any]

### Overall Accuracy
- X/N checks passed (Y%)
- [recommendation: map is reliable / needs re-crawl / specific modules need update]
```
