# Sonar — Codebase Cartographer

Sonar is a codebase cartographer plugin for Claude Code and Codex. It builds a persistent understanding graph of any codebase and uses that map to surface relevant modules, conventions, flows, blast radius, and verification steps before agents make changes.

---

## Installing Sonar

**If you are a coding agent** (Claude or similar) and the user has asked you to install Sonar: run Steps 1–3 autonomously using your Bash tool. The only step that requires the user is Step 4 (plugin reload — the shell cannot trigger a UI event).

### Step 0 — Check Node is available

Sonar will fail silently if Node is missing. Run:

```bash
node --version
```

Must be v18 or higher. If missing:

macOS: `brew install node`

Linux:
```bash
curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash - && sudo apt-get install -y nodejs
```

> **Node on PATH:** Sonar hooks run in a non-interactive shell. If Node was installed via nvm, fnm, volta, or asdf it may not be visible to hooks. Sonar auto-detects common install locations, but if hooks fail use a system-wide Node install (Homebrew, apt).

### Step 1 — Add the marketplace and install

Run via Bash:

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

Run via Bash:

```bash
claude plugin list
```

`sonar` must appear in the output. If it doesn't, re-run Step 1.

### Step 3 — Ask the user to reload (the one manual step)

Tell the user:

> Sonar is installed. Please run `/reload-plugins` or restart Claude Code to activate it. Let me know when you're done and I'll run a health check.

Wait for confirmation before continuing.

### Step 4 — Health check (after reload)

Run these slash commands:

```
/sonar:sonar-version
```

Expected: version number, install path, and update status. Any error here means the plugin didn't load — check that Node is on PATH.

```
/sonar:sonar-status
```

Expected: map state for the current project. "No map" is fine on first use. Hook errors or "node not found" mean the PATH issue from Step 0 wasn't resolved.

If both return without errors, Sonar is installed and healthy.

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

---

## Install via Codex CLI or Codex App

Sonar ships a Codex plugin manifest, a `plugins/sonar` Codex bundle, and a repo-local marketplace entry.

Today the two agent surfaces differ:

- Claude Code: slash commands plus automatic hooks
- Codex CLI/App: plugin bundle plus bundled skills; custom-agent templates are installable into `.codex/agents/`; hooks are manual and only partially portable today

Hook portability details live in [CODEX_PORTABILITY.md](./CODEX_PORTABILITY.md).

### Installing the plugin (human step — no CLI equivalent)

Unlike Claude Code, Codex has no `codex plugin install` CLI command. Plugin installation requires the Codex app UI and must be done by the user, not an agent. If you are a coding agent, skip to [Recommended Codex setup](#recommended-codex-setup) — that is your entry point once the user confirms the plugin is installed.

**User steps:**

1. Clone this repo: `git clone https://github.com/goldfish-1x/sonar`
2. Open the cloned repo in the Codex app.
3. Restart Codex so it picks up the repo marketplace at `.agents/plugins/marketplace.json`.
4. Open the Plugins panel, choose the `FishStack Local` marketplace, and install `Sonar`.
5. Start a new thread — the plugin skills will now be available as `@sonar`.

Codex CLI plugin installation is still build-dependent. In `codex-cli 0.114.0`, `codex --enable plugins` enables the feature flag but `/plugins` is still not a recognized slash command, so use the Codex app plugin panel or a newer CLI build that exposes plugin installation.

### Recommended Codex setup

Once the plugin is installed, a coding agent can handle the rest. After the user confirms the plugin is active in a new thread:

1. Run `@sonar sonar-codex-setup` for a guided setup pass.
3. If `.sonar/` does not exist yet, run `@sonar sonar-crawl` to build the initial map.
4. If `.sonar/` exists but is stale, run `@sonar sonar-update`.
5. Run `@sonar sonar-upgrade` when you want to check whether the installed plugin is current.
6. Optionally run `@sonar sonar-install-agents` to install Sonar custom-agent templates into `.codex/agents/`.
7. Add the AGENTS.md snippet below so future Codex sessions know when to use Sonar.

### How Sonar maps to Codex

Codex plugins do not currently ship custom slash commands, so Sonar's Claude commands become Codex skills:

| Claude Code | Codex |
|-------------|-------|
| `/sonar` | `@sonar` or `@sonar sonar` |
| `/sonar explore` | `@sonar sonar-explore` |
| `/sonar impact` | `@sonar sonar-impact` |
| `/sonar verify` | `@sonar sonar-verify` |
| `/sonar review-context` | `@sonar sonar-review-context` |
| `/sonar status` | `@sonar sonar-status` |
| `/sonar update` | `@sonar sonar-update` |
| `/sonar crawl` | `@sonar sonar-crawl` |
| `/sonar wiki` or `/sonar graph` | `@sonar sonar-workspace` |
| Codex setup guidance | `@sonar sonar-codex-setup` |
| Plugin update check | `@sonar sonar-upgrade` |
| Sonar agent templates | `@sonar sonar-install-agents` |

### Recommended AGENTS.md section

Add this to the repository root `AGENTS.md`, or to a nested `AGENTS.md` if Sonar should apply only to part of a repo:

```markdown
## Sonar Usage

- If `.sonar/meta.json` exists, use Sonar before substantial code changes, architectural decisions, or broad reviews.
- For feature work or risky refactors, start with `@sonar sonar-impact "<task>"` to identify affected modules, flows, conventions, blast radius, and verification commands.
- For general orientation, use `@sonar` or `@sonar sonar` before manually reading large parts of the codebase.
- If `.sonar/` is missing, ask before running `@sonar sonar-crawl`; if the map is stale, use `@sonar sonar-update`.
- Before finalizing a change, use `@sonar sonar-verify` to compare the implementation against mapped conventions and recommended checks.
- For review prep, use `@sonar sonar-review-context` to gather relevant modules, flows, and invariants.
- Use `@sonar sonar-upgrade` to check whether the installed Sonar Codex plugin is behind the public GitHub version.
- If Sonar Codex custom agents are installed, use `sonar_mapper` for read-only mapping, `sonar_reviewer` for review, and `sonar_worker` for scoped implementation when explicit delegation is useful.
- Treat Sonar output as guidance, not ground truth. If map freshness is questionable, verify claims against source files.
```

### Check for Sonar updates

Use:

```text
@sonar sonar-upgrade
```

This compares the installed Codex plugin manifest with the public GitHub manifest at `goldfish-1x/sonar`.

If an update is available and Sonar is installed from a git checkout:

```bash
git pull --ff-only
```

Then restart Codex, open a new thread, and verify:

```text
@sonar sonar-version
```

If Sonar is not installed from a git checkout, fetch the latest `https://github.com/goldfish-1x/sonar` repo, reopen it in Codex, and reinstall `Sonar` from the `FishStack Local` marketplace.

### Install Sonar Codex custom agents

Codex plugins can carry agent templates, but Codex only loads custom agents from `.codex/agents/` or `~/.codex/agents/`. To install Sonar's project-scoped Codex agents, invoke:

```text
@sonar sonar-install-agents
```

The installer copies these templates into `.codex/agents/`:

- `sonar_mapper` on `gpt-5.4-mini` for read-only mapping
- `sonar_reviewer` on `gpt-5.4` with high reasoning for reviews
- `sonar_worker` on `gpt-5.4` for implementation work

Existing project agent files are not overwritten unless the user explicitly asks for `--force`. Restart Codex after installing agents so the new custom agents are loaded.

### Codex hook status

Codex hook support is not equivalent to Claude's:

- `SessionStart` and `UserPromptSubmit` are manually configurable in Codex
- `Stop` is possible, but Sonar needs a Codex-specific wrapper
- `PreToolUse` and `PostToolUse` currently only intercept `Bash`, so Sonar's edit-aware warnings and post-edit checks do not port directly

For the current status and recommended rollout shape, see [CODEX_PORTABILITY.md](./CODEX_PORTABILITY.md).
