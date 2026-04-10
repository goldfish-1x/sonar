# Sonar — Codebase Cartographer

Sonar is a Claude Code plugin that builds a persistent understanding graph of any codebase. It gives coding agents **situational awareness** — injecting the right module context, conventions, and dependency warnings automatically so agents write code that fits the architecture instead of fighting it.

Without Sonar, agents discover your codebase by reading files one at a time. With Sonar, they start with a briefing: which modules matter, what rules apply, what depends on what, and where they're likely to make mistakes.

---

## Install

```bash
claude plugin marketplace add goldfish-1x/sonar
claude plugin install sonar
```

Adding the marketplace first enables auto-updates — Claude Code will notify you when a new version is available. That's it. Sonar activates in every Claude Code session in any project directory.

---

## First Use

**You don't need to run `/sonar crawl` first.** Drop into any project and ask:

```bash
/sonar "add rate limiting to the API"
```

Sonar auto-detects that no map exists, runs a fast targeted scan (~5 seconds), then analyzes only the modules relevant to your task (~2-3 min). Results are cached — future queries reuse what's already been analyzed.

When you want **full coverage** of the entire codebase (one-time, ~10-30 min):

```bash
/sonar crawl
```

Commit the output to git so your whole team shares the same map — then nobody has to crawl again.

---

## How It Works

Sonar builds understanding in four phases:

1. **Skeleton** — static analysis: file graph, imports/exports, module boundaries (~5 sec)
2. **Module cards** — parallel LLM analysis of every module: purpose, business rules, conventions, public API, side effects
3. **Flow narratives** — traces entry-to-exit data paths with invariants and failure modes
4. **System synthesis** — domain model, architecture patterns, load-bearing modules, domain overlaps, tensions

Everything is stored in `.sonar/` — JSON cards designed to be **committed to git** so the whole team shares the same map.

---

## How to Use It Effectively

### 1. Orient before you code

When you receive a task, your instinct is to start reading files. Stop — ask Sonar first:

```
/sonar "add webhook support to the notification system"
```

You get in seconds what would take 10-15 minutes of exploration:
- Which modules are involved and what they do
- What conventions you must follow
- What depends on what you're about to change
- What flows pass through the area you're touching

**Read the briefing before you read any code.** It tells you where to look and what matters.

### 2. Explore strategies before committing to one

For any non-trivial feature, don't jump to the first approach that comes to mind:

```
/sonar explore "webhook support for the notification system"
```

This spawns parallel agents that simulate 3-4 different implementation strategies against the real codebase graph. Each is evaluated for what it reuses, what it breaks, what conventions it follows or violates, and what risks it carries. You get a comparative report.

**Skip this for:** bug fixes, simple additions, or tasks where the approach is obvious.

### 3. Check impact before risky changes

Once you've chosen an approach, before you write code:

```
/sonar impact "replace synchronous auth checks with middleware"
```

Shows 1st order (direct breakage), 2nd order (testing needed), 3rd order (awareness). Also checks if your approach violates conventions in the affected modules.

### 4. Let hooks do the rest automatically

Six hooks fire without you doing anything:

- **Session start** — auto-refreshes the skeleton when git HEAD has moved since the last session
- **On every prompt** — searches the map and injects relevant module context, conventions with check commands, business rules with source locations, and flow invariants
- **On every file edit** — warns when the file you're editing has dependents you haven't been briefed on; flags load-bearing modules and domain overlaps
- **Post-edit convention check** — runs the module's check commands after each edit and reports violations inline
- **Ripple Guard** — when you change an exported symbol's signature, tracks which importers need updating and counts down: "Breaking change: 4 files need updating" → "1/4" → "All Clear (4/4)"
- **Session end safety net** — warns if you're about to finish with unresolved breaking changes

### 5. Verify before you push

```
/sonar verify
```

Runs the convention check commands automatically. Tells you what passed, what failed, and what needs manual review. Catches convention violations that tests don't.

### 6. Pre-review blast radius

Before running a code review:

```
/sonar review-context
```

Maps every changed file to its module, runs a 3-hop blast radius query, checks conventions on changed files, and surfaces business rules and flow invariants at risk. Loads this context before the reviewer sees the diff.

---

## Configuration

Create a `sonar.config.json` in your project root to override defaults. All fields are optional — Sonar works without one.

```json
{
  "sources": {
    "include": ["src/**", "packages/**", "apps/**", "scripts/**"],
    "exclude": ["**/node_modules/**", "**/dist/**", "**/generated/**"],
    "extensions": [".ts", ".tsx", ".js", ".jsx", ".mjs", ".py"]
  },
  "modules": {
    "aliases": {
      "@app": "src/app",
      "@shared": "src/shared"
    },
    "roots": ["packages/*", "apps/*"],
    "manual_boundaries": ["src/core"],
    "grouping": {
      "prefer_package_boundaries": true,
      "prefer_src_feature_roots": true
    }
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

### Most useful options

**`sources.include` / `sources.exclude`** — control what Sonar scans. Add `"**/generated/**"` or `"**/vendor/**"` to exclude directories that inflate the module count without adding signal.

**`sources.extensions`** — add `.go`, `.rb`, `.java` etc. for non-JS codebases (skeleton analysis is language-agnostic; LLM analysis works on any language).

**`modules.aliases`** — map TypeScript/webpack path aliases to real directories so Sonar resolves imports correctly. Without this, aliased imports show as unresolved edges in the dependency graph.

**`modules.roots`** — tells Sonar where top-level module boundaries are. For a monorepo: `["packages/*", "apps/*"]`. For a flat repo: `["src/features/*"]`.

**`modules.manual_boundaries`** — force a directory to be its own module regardless of auto-detection. Useful for shared libraries or core infrastructure that gets split incorrectly.

**`retrieval.max_modules`** — how many modules get injected per prompt (default: 3). Increase to 5 for larger, more interconnected codebases; decrease for smaller repos where noise is a problem.

**`critical.modules`** — modules always treated as load-bearing. Edit warnings and impact analysis will flag these regardless of computed fan-in.

---

## Commands

| Command | When | What it does |
|---------|------|-------------|
| `/sonar <task or question>` | Starting any work | Briefing, Q&A, or path trace. Works without a map. |
| `/sonar explore <feature>` | Planning new features | Parallel strategy simulation — 3-4 approaches, comparative tradeoffs |
| `/sonar impact <change>` | Before risky changes | 1st/2nd/3rd order cascading effects |
| `/sonar verify` | After making changes | Runs convention check commands + dependency verification |
| `/sonar review-context [base]` | Before code review | Blast radius + convention checks for the current branch diff. `base` is the branch to diff against (default: `main`) |
| `/sonar blast <module>` | Deep-diving a module | Full reverse dependency tree |
| `/sonar delete <target>` | Removing a feature | Precise deletion surface: what to delete, edit, keep |
| `/sonar graph [module]` | Visualizing dependencies | Interactive graph workspace (overview, focus, impact, flow, path modes) |
| `/sonar wiki [port]` | Browsing the map | Local knowledge workspace with typed search and graph views |
| `/sonar crawl` | Building the map | Full 4-phase parallel analysis (one-time) |
| `/sonar update` | Refreshing the map | Incremental — only changed modules |
| `/sonar status` | Checking map health | Freshness, coverage, stale areas |
| `/sonar verify-map` | Validating map accuracy | Spot-checks cards against actual code |
| `/sonar version` | Checking plugin version | Installed version, commit SHA, update availability |
| `/sonar reset` | Starting over | Deletes `.sonar/` completely |

---

## What the Map Contains

**Module cards** (`.sonar/modules/*.json`)
- Purpose and responsibility
- Business rules with source file:line locations
- Conventions with executable check commands
- Public API surface
- Side effects (I/O, network, DB)
- Function cards: purpose, callers, callees, error behavior

**Flow narratives** (`.sonar/flows/*.json`)
- Entry-to-exit data paths with business context
- Invariants that must always hold
- Failure modes and recovery paths

**System understanding** (`.sonar/system.json`)
- Domain model and concepts
- Architecture patterns and layers
- Load-bearing modules (high fan-in — change carefully)
- Domain overlaps (two modules claiming the same concept)
- Architectural tensions (competing constraints)

**Dependency graph** (`.sonar/graph.db`)
- SQLite — queryable for blast radius, path traversal, fan-in/fan-out
- Rebuilt from JSON cards, not committed to git

---

## Sharing with Your Team

Commit the map to git:

```
.sonar/modules/
.sonar/flows/
.sonar/system.json
.sonar/skeleton.json
.sonar/meta.json
```

Add to `.gitignore`:

```
.sonar/graph.db
.sonar/summaries.json
.sonar/file-modules.json
.sonar/symbol-imports.json
.sonar/state.json
.sonar/partials/
.sonar/hook-errors.log
.sonar/usage.jsonl
```

Sonar writes this `.gitignore` automatically on first use — you don't need to add it manually.

Every developer gets the map on `git pull`. Run `/sonar update` after pulling — it re-analyzes only changed modules, takes 2-3 min, and keeps the map accurate. Derived files (graph.db, partials) rebuild automatically on first use.

---

## Map Freshness

Sonar tracks which modules have changed since the last crawl. `/sonar update` re-analyzes only changed modules — not the whole codebase. Run it after pulling or after a large refactor.

```bash
/sonar status   # see what's stale
/sonar update   # refresh changed modules (2-3 min)
/sonar crawl    # full rebuild if many modules changed
```

---

## Requirements

All scripts are plain Node.js — no Bun, no Python, no special build tools. If you have Node and Git, Sonar runs.

### Required

| Tool | Why |
|------|-----|
| **Claude Code** | Plugin host — hooks, commands, agent spawning |
| **Node.js 18+** | All hooks and build scripts run as `node` |
| **Git** | Change detection, staleness tracking, SHA comparison |
| **SQLite3 CLI** | Session-start cache warmup — pre-installed on macOS and most Linux distros |

### Included (no install needed)

| Package | How it's used |
|---------|--------------|
| **better-sqlite3** | Bundled in `node_modules/` — builds the queryable dependency graph. Ships prebuilt binaries for macOS, Linux, and Windows. |

### Optional

| Tool | Why |
|------|-----|
| **`gh` CLI** | `/sonar version` — checks for updates against the remote repo |

### Verify your setup

```bash
node --version      # needs 18+
git --version
sqlite3 --version   # pre-installed on macOS/Linux
```

### Platform support

Sonar has been tested on **macOS with the Claude Code CLI**. Other platforms are expected to work based on how the code is written, but haven't been validated:

| Platform | Status | Notes |
|---|---|---|
| macOS + Claude Code CLI | ✅ Tested | All features verified |
| Linux | 🔲 Untested | Should work — same Node + bash stack |
| Windows (WSL) | 🔲 Untested | Expected to work via WSL |
| Windows native | ❌ Known gaps | Bash scripts won't run; sqlite3 CLI may be missing |
| VS Code / Cursor / JetBrains | 🔲 Untested | Claude Code plugins are IDE-agnostic in principle; PATH issues likely |

If you run into issues on other platforms or setups, please open an issue.

**Known risk with IDE extensions: PATH.** When Claude Code runs as an IDE extension, it may inherit a stripped-down PATH that doesn't include Node.js if installed via a version manager (nvm, fnm, volta). Hooks will fail silently. The safest fix is a system-wide Node install:

```bash
brew install node   # macOS
```

---

## Architecture Overview

```
/sonar crawl
    │
    ├─ Phase 1: Skeleton (static analysis)
    │   skeleton.json — file graph, imports/exports, module boundaries
    │
    ├─ Phase 2: Module cards (parallel agents)
    │   module-analyst × N → .sonar/modules/{key}.json
    │   submodule-analyst for large modules (>150 files)
    │   parent-synthesizer for split module families
    │
    ├─ Phase 3: Flow narratives (parallel agents)
    │   flow-tracer × M → .sonar/flows/{key}.json
    │
    └─ Phase 4: System synthesis
        synthesizer → .sonar/system.json

Post-crawl:
    agent-briefs build → .sonar/partials/agent-briefs/{key}.json
    graph.db built from skeleton.json + module cards

Runtime hooks:
    on-session-start → warm SQLite cache
    on-prompt → inject relevant context per task
    on-edit → warn about dependents, load-bearing modules
    on-convention-check → run check commands post-edit
    on-ripple → track breaking signature changes
    on-ripple-stop → safety net at session end
```
