---
description: Pre-review blast radius and convention check for the current branch diff. Run before /review to understand what the PR could break outside its own files.
argument-hint: [base-branch]
allowed-tools: Read, Bash, Glob, Grep
---

# /sonar review-context

Pull Sonar intelligence for the current branch's diff before reviewing. Answers:
- Which modules outside the PR could break?
- Which conventions are violated in the changed files?
- Which flow invariants must the reviewer verify?
- Which business rules are touched (with source locations)?

## Protocol

1. **Check map exists.** If no `.sonar/graph.db` or `.sonar/file-modules.json`, print:
   > No Sonar map found. Run `/sonar crawl` to build one, or proceed with `/review` without context.
   Then stop.

2. **Detect base branch.**
```bash
BASE="${ARGUMENTS:-}"
if [ -z "$BASE" ]; then
  BASE=$(git remote show origin 2>/dev/null | grep 'HEAD branch' | awk '{print $NF}')
  [ -z "$BASE" ] && BASE=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's|refs/remotes/origin/||')
  [ -z "$BASE" ] && BASE="main"
fi
git fetch origin "$BASE" --quiet 2>/dev/null || true
echo "Base: $BASE"
git diff "origin/$BASE"...HEAD --name-only
```

3. **Map changed files to modules.** For each file in the diff:
```bash
# Via file-modules.json (fastest path)
cat .sonar/file-modules.json | node -e "
const fm = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
const files = process.argv.slice(1);
const seen = new Set();
files.forEach(f => { const m = fm[f]; if (m?.module && !seen.has(m.module)) { seen.add(m.module); console.log(m.module); }});
" <file1> <file2> ...
```
   Or via sqlite3:
```bash
sqlite3 .sonar/graph.db "SELECT DISTINCT module_key FROM files WHERE path IN ('<file1>','<file2>')"
```
   Collect the unique set of **changed modules** — modules that own at least one changed file.

4. **Compute blast radius.** For each changed module, run a 3-hop reverse dependency query:
```bash
# 1st order: direct dependents (highest risk — likely need changes)
sqlite3 .sonar/graph.db "
  SELECT source_module, weight FROM edges
  WHERE target_module = '<module>'
  ORDER BY weight DESC"

# 2nd order
sqlite3 .sonar/graph.db "
  SELECT DISTINCT e2.source_module FROM edges e1
  JOIN edges e2 ON e1.source_module = e2.target_module
  WHERE e1.target_module = '<module>'
  AND e2.source_module != '<module>'"

# 3rd order
sqlite3 .sonar/graph.db "
  SELECT DISTINCT e3.source_module FROM edges e1
  JOIN edges e2 ON e1.source_module = e2.target_module
  JOIN edges e3 ON e2.source_module = e3.target_module
  WHERE e1.target_module = '<module>'
  AND e3.source_module NOT IN ('<module>', '<1st-order-modules>')"
```
   **Exclude modules that are themselves in the PR** — blast radius is only about what's outside the diff.

5. **Run convention checks on changed files.** For each changed module, read `.sonar/modules/{key}.json`. For each convention with a `check` field, run it scoped to the changed files. Same pattern as `/sonar verify`:
   - Non-empty output → FAIL (report lines found)
   - Empty output → PASS
   - No `check` field → SKIP

6. **Extract business rules at risk.** For each changed module, read its business rules. Any rule whose `source` field points to a file that appears in the diff is "at risk" — the code that enforces it was modified.

7. **Check flow integrity.** Find flows passing through changed modules:
```bash
sqlite3 .sonar/graph.db "
  SELECT DISTINCT flow_name FROM flow_steps
  WHERE module_key IN ('<changed-modules>')"
```
   For each flow, read `.sonar/flows/{name}.json` and extract the invariants. These are what the reviewer must verify manually.

8. **Format the review context brief:**

```markdown
## Sonar Review Context

**Branch diff:** N files across M modules
**Changed modules:** module-a, module-b, ...

---

### Blast Radius

**1st order — direct dependents (check these for breakage):**
| Module | Purpose | Risk |
|--------|---------|------|
| dep-module | what it does | HIGH — directly imports changed-module |

**2nd order — transitive (test these):**
- module-x, module-y

**3rd order — awareness only:**
- module-z

---

### Convention Checks
- [PASS] module-a: "rule text"
- [FAIL] module-b: "rule text"
  Found: `path/file.ts:14: violating line`
- [SKIP] module-a: "rule text" — no check command, verify manually

---

### Business Rules Touched
- **"rule text"** — source: `path/file.ts:42` *(this file is in the diff — verify rule still holds)*

---

### Flow Invariants to Verify
- **flow-name**: invariant text
- **flow-name**: invariant text

---

### Unmapped changed files
- `path/new-file.ts` — not in any module card. Run `/sonar update` after merge.
```

9. **If blast radius is empty** (no dependents at any order), print:
   > No dependents found outside the diff. This PR is self-contained from Sonar's perspective.

10. **If no `.sonar/modules/` cards exist for the changed modules** (skeleton-only map), skip convention checks and flow invariants, note: "Module cards not yet generated — run `/sonar update` for full analysis."
