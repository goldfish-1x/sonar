---
description: Build a complete understanding map of the codebase. Spawns parallel agents to analyze all modules and flows simultaneously.
argument-hint: [--full]
allowed-tools: Bash, Read, Write, Glob, Grep, Agent
---

# /sonar crawl

Build a multi-layered understanding graph of the current codebase. Produces a `.sonar/` directory with module cards, flow narratives, system-level understanding, and a queryable SQLite index.

**Default: maximum parallelism.** Every phase spawns as many agents simultaneously as possible.

## Pre-flight

1. Check if `.sonar/` exists. If it does and `$ARGUMENTS` does not contain `--full`, suggest `/sonar update` instead for incremental refresh. If the user confirms full crawl, proceed.
2. Create `.sonar/` directory structure:
```bash
mkdir -p .sonar/{modules,flows,submodules,partials}
```
3. Install Sonar dependencies (if not already):
```bash
cd "${CLAUDE_PLUGIN_ROOT}" && npm install --ignore-scripts 2>/dev/null || true
```

## Phase 1 — Skeleton (script, no LLM — runs in seconds)

Extract structural information from all source files using grep. This is a deterministic script, not an agent.

```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/build-skeleton.sh" . .sonar
```

This produces `.sonar/skeleton.json` with:
- File entries (path, language, line count, imports, exports, functions, classes)
- Module groupings (files grouped by package/directory with tiny modules merged)
- Cross-module edges (import relationships)
- Test files excluded from standalone modules

Read the skeleton output to get the module list:
```bash
node -e "const s = JSON.parse(require('fs').readFileSync('.sonar/skeleton.json','utf8')); console.log(Object.keys(s.modules).join('\n')); console.log('---'); console.log(JSON.stringify(s.stats))"
```

## Phase 2 — Module Understanding (all modules in parallel)

1. **Enumerate modules** from `skeleton.json`. List all module keys and their file lists. Skip any keys starting with `_test_`.

2. **Build per-module skeleton data.** For each module, extract its file-level metadata from `skeleton.json`:
```bash
node -e "
  const s = JSON.parse(require('fs').readFileSync('.sonar/skeleton.json','utf8'));
  const key = process.argv[1];
  const files = Object.fromEntries(
    Object.entries(s.files).filter(([,f]) => f.module_key === key)
      .map(([p,f]) => [p, {
        lines: f.lines,
        exports: (f.exports||[]).map(e=>e.name),
        functions: (f.functions||[]).map(fn=>fn.name),
        imports: (f.imports||[]).filter(i=>i.kind==='internal').map(i=>i.source),
        importance_score: f.importance_score || 0,
        score_breakdown: f.score_breakdown || null
      }])
  );
  console.log(JSON.stringify(files));
" -- <module-key>
```

3. **Spawn module-analyst agents — ALL modules simultaneously.** For each module, spawn one `module-analyst` agent with:
   - Module name, key, and file list
   - Skeleton context: what this module imports from and is imported by (from the edges data)
   - `skeleton_files`: the per-file metadata object from step 2 (exports, functions, imports, lines per file) — the agent uses this to rank files before reading
   - Instructions to write output to `.sonar/modules/{module-key}.json`

   Use `run_in_background: true`. Send ALL spawn calls in a single message. Each agent is independent and writes to its own file.

4. **Wait for all module-analyst agents to complete.**

## Phase 2.5 — Parent Synthesis

Detect module families (groups of split modules sharing a common prefix) and synthesize parent cards.

1. **Detect families:**
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
    .filter(([prefix, children]) => {
      if (children.length < 2) return false;
      if (moduleKeys.includes(prefix)) return false; // prefix is itself a real module
      try {
        if (fs.existsSync('.sonar/modules/' + prefix + '.json')) {
          const card = JSON.parse(fs.readFileSync('.sonar/modules/' + prefix + '.json','utf8'));
          if (card.is_parent) return false; // already synthesized
        }
      } catch { return false; } // malformed card — skip to avoid clobbering
      return true;
    })
    .map(([parent, children]) => ({ parent, children }));
  console.log(JSON.stringify(families));
"
```

2. **Spawn parent-synthesizer agents — ALL families simultaneously.** For each family, spawn one `parent-synthesizer` agent with the `parent_key` and `child_module_keys`. Use `run_in_background: true`. Send ALL spawn calls in a single message.

3. **Wait for all parent-synthesizer agents to complete.**

## Phase 3 — Flow Tracing (all flows in parallel)

1. **Identify entry points** from the skeleton:
   - HTTP route handlers (FastAPI `@app.get/post`, Express `router.get/post`, Convex `httpAction`)
   - Event handlers (Convex mutations/actions that trigger other actions)
   - CLI entry points (`if __name__ == "__main__"`, bin entries)
   - Exported `run()` or `main()` functions
   - Signal/webhook handlers

2. **Trace candidate paths.** For each entry point, follow the call graph through the skeleton's import and call data. Build a candidate path: list of `{module, function, file, line}` objects from entry to exit (exit = side effect like DB write, API response, or event emit). Stop at depth 15 or when no more internal calls are found.

3. **Group related entry points** into named flows. Similar paths (same modules, similar purpose) should be one flow. Aim for 10-25 flows for a medium codebase.

4. **Build the canonical module key list.** Extract all module keys from `.sonar/skeleton.json`:
```bash
node -e "const s = JSON.parse(require('fs').readFileSync('.sonar/skeleton.json','utf8')); console.log(Object.keys(s.modules).filter(k => !k.startsWith('_test_')).join(', '))"
```

5. **Spawn flow-tracer agents — ALL flows simultaneously.** For each flow, include in the prompt:
   - The entry point and candidate path
   - **The canonical module key list** — tell the agent: "You MUST use ONLY these module keys in your output: [list]. Do NOT invent new module names."
   - Instructions to read module cards from `.sonar/modules/` for context
   - Instructions to write output to `.sonar/flows/{flow-name}.json`

   Use `run_in_background: true`. Send ALL spawn calls in a single message.

6. **Wait for all flow-tracer agents to complete.**

## Phase 4 — System Synthesis

1. **Spawn one synthesizer agent.** Give it:
   - Instructions to read all `.sonar/modules/*.json` and `.sonar/flows/*.json`
   - Instructions to spawn 3 internal subagents in parallel (domain modeler, pattern scanner, architecture analyst)
   - Instructions to merge subagent outputs into `.sonar/system.json`

2. **Wait for the synthesizer to complete.**

## Finalize

1. **Rebuild SQLite index + pre-computed lookups:**
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/build-db.mjs" .sonar
```
This creates `graph.db`, `summaries.json`, and `file-modules.json`.

2b. **Build wiki pages:**
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/build-wiki.mjs" .sonar
```

2. **Write meta.json:**
```json
{
  "version": 2,
  "created_at": "<ISO timestamp>",
  "updated_at": "<ISO timestamp>",
  "git_sha": "<current HEAD SHA>",
  "git_branch": "<current branch>",
  "stats": {
    "files_analyzed": <count from skeleton>,
    "modules": <count of .sonar/modules/*.json>,
    "flows": <count of .sonar/flows/*.json>,
    "total_lines": <count from skeleton>
  }
}
```

3. **Create .sonar/.gitignore** (if not exists):
```
graph.db
summaries.json
file-modules.json
partials/
```

4. **Report results** to user:
```
Sonar crawl complete.
  Files analyzed: X
  Modules mapped: Y
  Flows traced: Z
  System patterns: N

Map written to .sonar/ — commit to share with your team.
Run /sonar <task> for a pre-task briefing.
```
