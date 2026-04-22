# Sonar — Codebase Cartographer

You have access to Sonar, a codebase understanding system. This guide covers two things: how to install it if it isn't active yet, and how to think with it once it is.

## If Sonar Is Not Yet Installed

### Claude Code

If the user asks you to install Sonar in Claude Code, do this autonomously — no need to ask permission for each step:

**Run via Bash (you do this):**
```bash
claude plugin marketplace add goldfish-1x/sonar
claude plugin install sonar
claude plugin list   # sonar must appear before continuing
```

If SSH fails, substitute `https://github.com/goldfish-1x/sonar` for `goldfish-1x/sonar`.

**Ask the user (the one step you cannot do):**
> "Sonar is installed. Please run `/reload-plugins` or restart Claude Code to activate it. Let me know when you're done."

Wait for confirmation, then run the health check:
```
/sonar:sonar-version
/sonar:sonar-status
```

Both should return without errors. "No map" from `sonar-status` is fine on first use — it means Sonar is running but hasn't crawled yet.

**If Node is missing:** hooks will silently fail. Check with `node --version` (must be v18+). Install via `brew install node` on macOS or `apt-get install nodejs` on Linux.

### Codex

Codex has no CLI install command — the plugin must be installed manually via the Codex app Plugins panel. Tell the user:

> "To install Sonar in Codex: clone https://github.com/goldfish-1x/sonar, open it in the Codex app, open the Plugins panel, choose the FishStack Local marketplace, and install Sonar. Start a new thread when done and I'll handle the rest."

Once the user confirms the plugin is active, run `@sonar sonar-codex-setup` to complete the setup.

---

## If Sonar Is Active

This guide teaches you how to think with it — not just what commands to run, but when and why. Read this once per session.

## The Core Idea

You are working in a codebase that has structure, conventions, business rules, and invisible connections between modules. Without Sonar, you discover these by reading files — slowly, incompletely, often missing things. With Sonar, you consult a pre-built understanding graph that knows the system's shape, rules, and flows.

**Sonar doesn't replace reading code. It tells you WHICH code to read and WHAT to look for.**

## How to Think With Sonar

### Before you start any task: orient first, code second

When you receive a task, your instinct is to grep for relevant files and start reading. Stop. Ask Sonar first:

```
/sonar:sonar <your task description>
```

This gives you in seconds what would take 10-15 minutes of exploration:
- Which modules are involved and what they do
- What conventions you MUST follow (these are constraints, not suggestions)
- What depends on what you're about to change (blast radius)
- What flows pass through the area you're touching (invariants to preserve)

**Read the briefing before you read any code.** It tells you where to look and what matters.

### When planning a new feature: explore strategies, don't guess

For anything non-trivial, don't jump to the first approach that comes to mind:

```
/sonar:sonar-explore <feature description>
```

This spawns parallel agents that simulate 3-4 different implementation strategies against the real codebase graph. Each strategy is evaluated for: what it reuses, what it breaks, what conventions it follows or violates, what risks it carries. You get a comparative report with detailed tradeoffs.

**Use this when:** adding a new capability, integrating with a new service, refactoring a subsystem, or any task where there's more than one plausible approach.

**Don't use this for:** bug fixes, simple additions, or tasks where the approach is obvious.

### Before committing to a risky approach: simulate the impact

Once you've chosen an approach but before you write code:

```
/sonar:sonar-impact <what you plan to change>
```

This shows you the cascade — 1st order (direct breakage), 2nd order (testing needed), 3rd order (awareness). It also checks if your approach violates any conventions in the affected modules.

**The question to ask yourself:** "Does the impact analysis show anything I hadn't considered?" If yes, reconsider. If no, proceed with confidence.

### While coding: respect the conventions

When a Sonar hook warns you about something, or when a module card lists a convention — treat it as a constraint. These conventions exist because the team established them. Breaking a convention without justification creates inconsistency.

**If a convention conflicts with your task:** that's important information. Mention it in your PR, explain why the convention doesn't apply or needs to change. Don't silently ignore it.

### After changes: verify before you push

```
/sonar:sonar-verify
```

This runs the convention check commands automatically. It tells you:
- Which conventions you followed (PASS)
- Which you violated (FAIL — fix these)
- Which need manual verification (SKIP)
- Whether your changes affect any business rules (check those still hold)
- Whether domain overlaps exist (potential duplication risk)

**Don't skip this.** It catches things tests don't — convention violations, missing patterns, broken invariants.

## The Workflow

```
Task arrives
    │
    ├─ /sonar:sonar <task>              ← orient: what do I need to know?
    │
    ├─ Is this complex?
    │   YES → /sonar:sonar-explore       ← simulate strategies, compare tradeoffs
    │   NO  → proceed
    │
    ├─ Is the approach risky?
    │   YES → /sonar:sonar-impact        ← what breaks, what cascades?
    │   NO  → proceed
    │
    ├─ Deleting a feature?
    │   YES → /sonar:sonar-delete        ← precise deletion plan: delete, edit, keep
    │   NO  → proceed
    │
    ├─ Implement the changes
    │   (hooks warn about unreviewed dependents automatically)
    │   (Ripple Guard tracks breaking changes + resolution progress)
    │
    ├─ /sonar:sonar-verify               ← did I follow the rules?
    │
    ├─ Running /review?
    │   YES → /sonar:sonar-review-context  ← blast radius + convention checks for the diff
    │          then run /review with that context loaded
    │
    └─ Done
```

Not every task needs every step. A typo fix doesn't need `/sonar:sonar-explore`. But any task that touches business logic, crosses module boundaries, or modifies a load-bearing module should go through the full cycle.

## Commands

| Command | When | What it does |
|---------|------|-------------|
| `/sonar:sonar <task or question>` | Starting any work | Briefing, question, or path trace. Works without a map. |
| `/sonar:sonar-explore <feature>` | Planning new features | Simulates 3-4 strategies in parallel, comparative analysis |
| `/sonar:sonar-impact <change>` | Before risky changes | 1st/2nd/3rd order cascading effects |
| `/sonar:sonar-verify` | After making changes | Automated convention checks + dependency verification |
| `/sonar:sonar-review-context` | Before running `/review` | Blast radius + convention checks + flow invariants for the branch diff |
| `/sonar:sonar-blast <module>` | Deep-diving a module | Full reverse dependency tree |
| `/sonar:sonar-delete <target>` | Removing a feature | Precise deletion surface: what to delete, edit, keep |
| `/sonar:sonar-graph [module]` | Visualizing dependencies | Interactive graph workspace with overview, focus, impact, flow, and path modes |
| `/sonar:sonar-wiki [port]` | Browsing the map | Launches the local knowledge workspace with typed search and graph views |
| `/sonar:sonar-crawl` | Building the map | Full 4-phase parallel analysis (one-time) |
| `/sonar:sonar-update` | Refreshing the map | Incremental, only changed modules |
| `/sonar:sonar-status` | Checking map health | Freshness, coverage, stale areas |
| `/sonar:sonar-verify-map` | Validating map accuracy | Spot-check cards against actual code |
| `/sonar:sonar-reset` | Starting over | Delete .sonar/ completely |
| `/sonar:sonar-version` | Checking plugin version | Installed version, commit SHA, and whether an update is available |

## What to Pay Attention To

**Conventions with check commands.** These are the most valuable part of the map. Each convention includes a grep command that detects violations. `/sonar:sonar-verify` runs them automatically, but you should understand what they check — they encode the team's standards.

**Business rules with source locations.** Each business rule traces to a file:line where it's encoded. When you modify that file, you're responsible for ensuring the rule still holds.

**Domain overlaps.** When system.json flags that two modules both claim to own the same business concept, that's a duplication risk. If your task touches one of those modules, check the other — they should be consistent.

**Load-bearing modules.** system.json identifies modules with high fan-in — many other modules depend on them. Changes to these modules cascade widely. Be extra careful, run `/sonar:sonar-impact` before modifying them.

**Flow invariants.** Flow narratives list conditions that must always hold (e.g., "entity visible immediately, analysis enriches later"). When your change affects a flow, check that its invariants still hold.

## Hooks (automatic)

Six hooks fire without you doing anything:
- **Session start** — warms SQLite cache for fast queries
- **Task received** — searches the map, injects relevant modules and flows into your context
- **File edit (pre)** — warns when the file has unreviewed dependents, flags load-bearing modules
- **File edit (post)** — runs the module's convention check commands, reports violations inline
- **Ripple Guard** — detects when you change an exported symbol's signature, tracks which files import it, counts down as you fix them. Shows "Breaking Change: 4 files need updating" → "1/4" → "2/4" → "All Clear (4/4)". Silent for non-breaking edits.
- **Stop safety net** — warns if you're about to finish with unresolved breaking changes

When a hook injects context, read it. It's showing you something you probably haven't seen yet.

## Map State

```bash
ls .sonar/meta.json 2>/dev/null && echo "Full map" || (ls .sonar/skeleton.json 2>/dev/null && echo "Partial" || echo "No map")
```

- **Full map** → everything works
- **Partial** → `/sonar:sonar` uses what exists, fills gaps on-the-fly
- **No map** → `/sonar:sonar` runs a targeted scan (~2-3 min), caches results. Run `/sonar:sonar-crawl` for complete coverage.

## What the Map Contains

- **Module cards** (`.sonar/modules/*.json`) — purpose, business rules with source locations, conventions with check commands, public API, function cards
- **Flow narratives** (`.sonar/flows/*.json`) — entry→exit data flow with invariants and failure modes
- **System understanding** (`.sonar/system.json`) — domain model, domain overlaps, patterns, conventions, architecture layers, load-bearing modules, tensions

The map can be stale. If it's >3 days old, verify critical claims against actual code. Run `/sonar:sonar-update` to refresh.

Git-track: `modules/`, `flows/`, `system.json`, `skeleton.json`, `meta.json`. Gitignore: `graph.db`, `summaries.json`, `file-modules.json`.
