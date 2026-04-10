# Sonar — Codebase Cartographer

Sonar is a Claude Code plugin that gives coding agents codebase situational awareness. It builds a persistent understanding graph of any codebase and injects relevant context automatically — which modules matter, what conventions apply, what depends on what, and what tests to run — so agents write code that fits the architecture instead of fighting it.

---

## Install via Claude Code

Copy and paste this into Claude Code:

```
Please install this Claude Code plugin: https://github.com/goldfish-1x/sonar
```

Claude Code will handle the rest. After it confirms installation, run `/reload-plugins` or restart Claude Code to activate.

---

## Requirements

Check these before installing. Sonar will fail silently if Node is missing.

```bash
node --version    # must be 18 or higher
git --version     # any recent version
```

**If Node is missing or below v18:**

macOS:
```bash
brew install node
```

Linux (no sudo):
```bash
curl -fsSL https://nodejs.org/dist/v20.18.0/node-v20.18.0-linux-x64.tar.xz \
  | tar -xJ -C ~/.local --strip-components=1
export PATH="$HOME/.local/bin:$PATH"
node --version   # verify before continuing
```

Linux (with sudo):
```bash
curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
sudo apt-get install -y nodejs
```

> **Node on PATH:** Sonar hooks run in a non-interactive shell that does not source `.bashrc` or `.profile`. If Node was installed via a version manager (nvm, fnm, volta, asdf), it may not be on the PATH the hook sees. Sonar's hook runner auto-detects common install locations for nvm, fnm, volta, asdf, and `~/.local/bin`. If hooks still fail, use a system-wide Node install (Homebrew, apt) which puts Node on a PATH visible to all processes.

---

## Installing Sonar

### Step 1 — Add the marketplace and install

```bash
claude plugin marketplace add goldfish-1x/sonar
claude plugin install sonar
```

If SSH to GitHub fails, use HTTPS:
```bash
claude plugin marketplace add https://github.com/goldfish-1x/sonar
claude plugin install sonar
```

### Step 2 — Verify the install succeeded

```bash
claude plugin list
```

`sonar` must appear in the output. If it doesn't, re-run Step 1.

### Step 3 — Reload plugins

Tell the user:

> Sonar is installed. Please run `/reload-plugins` or restart Claude Code to activate it. Tell me when you're done and I'll run a health check.

Wait for confirmation before continuing.

### Step 4 — Health check (after reload)

```
/sonar:sonar-version
```

Expected: version number, install path, and update status. Any error here means the plugin didn't load — check that Node is on PATH.

```
/sonar:sonar-status
```

Expected: map state for the current project. "No map" is fine on first use — it means Sonar is running but hasn't crawled yet. Hook errors or "node not found" mean the PATH issue from Step 1 wasn't resolved.

If both commands return output without errors, Sonar is healthy and ready.

---

## Using Sonar

### The core workflow

**Always orient before you code.** When you receive a task, run this first:

```
/sonar:sonar <task description>
```

This gives you in seconds what would take 10-15 minutes of file exploration: which modules are involved, what conventions you must follow, what depends on what you're changing, and what tests to run. Read the briefing before reading any code.

**No map yet?** That's fine. Run the same command — Sonar will auto-scan the relevant modules on demand (~2-3 min) and cache the results.

**Want full coverage?** Run a one-time crawl:

```
/sonar:sonar-crawl
```

This takes 10-30 min depending on codebase size and builds a complete map. Commit the output to git (`.sonar/modules/`, `.sonar/flows/`, `.sonar/system.json`, `.sonar/skeleton.json`, `.sonar/meta.json`) so the whole team shares it.

### What happens automatically

Six hooks fire without you doing anything:

- **Session start** — refreshes the skeleton if git HEAD moved since last session
- **Every prompt** — injects relevant module context, conventions with check commands, business rules with source locations, test files, and flow invariants
- **Every file edit** — warns when the file has unreviewed dependents, flags load-bearing modules and domain overlaps
- **Post-edit** — runs the module's convention check commands and reports violations inline
- **Ripple Guard** — detects changed export signatures, tracks which importers need updating, counts down to "All Clear"
- **Session end** — warns if you're finishing with unresolved breaking changes

When the prompt hook injects context, read it. It's showing you something you probably haven't seen.

### Decision tree

```
Task arrives
  │
  ├─ /sonar:sonar <task>              ← always start here
  │
  ├─ Non-trivial feature?
  │   YES → /sonar:sonar-explore      ← 3-4 parallel strategy simulations
  │
  ├─ Risky change?
  │   YES → /sonar:sonar-impact       ← 1st/2nd/3rd order cascade
  │
  ├─ Implement
  │   (hooks warn automatically)
  │
  ├─ /sonar:sonar-verify              ← convention check before pushing
  │
  └─ Before review?
      YES → /sonar:sonar-review-context
```

### Commands

| Command | When to use | What it does |
|---------|-------------|-------------|
| `/sonar:sonar <task or question>` | Start of every task | Briefing, Q&A, or path trace. Works without a map. |
| `/sonar:sonar-explore <feature>` | Planning non-trivial features | Parallel strategy simulation — 3-4 approaches with tradeoffs |
| `/sonar:sonar-impact <change>` | Before risky changes | 1st/2nd/3rd order cascading effects |
| `/sonar:sonar-verify` | After changes, before push | Runs convention check commands + dependency verification |
| `/sonar:sonar-review-context [base]` | Before code review | Blast radius + convention checks for the branch diff. `base` defaults to `main` |
| `/sonar:sonar-blast <module>` | Investigating dependencies | Full reverse dependency tree |
| `/sonar:sonar-delete <target>` | Removing a feature | Precise deletion surface: what to delete, edit, keep |
| `/sonar:sonar-graph [module]` | Visualizing structure | Interactive dependency graph |
| `/sonar:sonar-wiki [port]` | Browsing the map | Local knowledge workspace with search |
| `/sonar:sonar-crawl` | First-time setup | Full 4-phase parallel analysis |
| `/sonar:sonar-update` | After pulling / after refactor | Incremental refresh — only changed modules (2-3 min) |
| `/sonar:sonar-status` | Checking health | Map freshness, coverage, stale modules |
| `/sonar:sonar-verify-map` | Auditing accuracy | Spot-checks cards against actual code |
| `/sonar:sonar-version` | Checking for updates | Installed version, commit SHA, update status |
| `/sonar:sonar-reset` | Starting over | Deletes `.sonar/` completely |

---

## Configuration

Create `sonar.config.json` in the project root to override defaults. All fields are optional.

```json
{
  "sources": {
    "include": ["src/**", "packages/**", "apps/**", "scripts/**"],
    "exclude": ["**/node_modules/**", "**/dist/**", "**/generated/**"],
    "extensions": [".ts", ".tsx", ".js", ".jsx", ".mjs", ".py"]
  },
  "modules": {
    "aliases": { "@app": "src/app", "@shared": "src/shared" },
    "roots": ["packages/*", "apps/*"],
    "manual_boundaries": ["src/core"]
  },
  "retrieval": {
    "max_modules": 3,
    "max_flows": 2,
    "max_facts": 3
  },
  "critical": {
    "modules": ["auth", "billing"],
    "flows": ["checkout"]
  }
}
```

**Key options:**

- `sources.include/exclude` — what gets scanned. Exclude `generated/`, `vendor/` directories that inflate module count without signal.
- `sources.extensions` — add `.go`, `.rb`, `.java` for non-JS codebases.
- `modules.aliases` — TypeScript/webpack path aliases. Without this, aliased imports show as unresolved in the dependency graph.
- `modules.roots` — top-level module boundaries. Monorepo: `["packages/*", "apps/*"]`. Flat repo: `["src/features/*"]`.
- `retrieval.max_modules` — modules injected per prompt (default: 3). Raise to 5 for large interconnected codebases.
- `critical.modules` — always treated as load-bearing regardless of computed fan-in.

---

## What the Map Stores

**Module cards** (`.sonar/modules/*.json`) — purpose, business rules with source file:line, conventions with executable check commands, public API, side effects, test files, key invariants, verification commands.

**Flow narratives** (`.sonar/flows/*.json`) — entry-to-exit data paths, invariants that must hold, failure modes.

**System understanding** (`.sonar/system.json`) — domain model, architecture patterns, load-bearing modules, domain overlaps, tensions.

**Dependency graph** (`.sonar/graph.db`) — SQLite, rebuilt from cards, not committed to git.

---

## Sharing with Your Team

Commit to git:
```
.sonar/modules/
.sonar/flows/
.sonar/system.json
.sonar/skeleton.json
.sonar/meta.json
```

Sonar writes `.sonar/.gitignore` automatically to exclude derived files. Run `/sonar:sonar-update` after pulling to refresh stale cards (2-3 min, only changed modules).

---

## Platform Support

Tested on **macOS with Claude Code CLI**. Other platforms are expected to work but untested:

| Platform | Status | Notes |
|---|---|---|
| macOS + Claude Code CLI | ✅ Tested | All features verified |
| Linux | 🔲 Untested | Same Node + bash stack, should work |
| Windows (WSL) | 🔲 Untested | Expected to work |
| Windows native | ❌ Known gaps | Bash scripts won't run |
| VS Code / Cursor / JetBrains | 🔲 Untested | PATH issues likely — use system-wide Node |
