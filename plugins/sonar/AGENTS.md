# Sonar — Codebase Cartographer

You have access to Sonar, a codebase understanding system. This guide covers how to install it if it isn't active yet, and how to think with it once it is.

## If Sonar Is Not Yet Installed

Codex has no CLI install command — the plugin must be installed via the Codex app UI. Tell the user:

> "To install Sonar: clone https://github.com/goldfish-1x/sonar, open it in the Codex app, open the Plugins panel, choose the FishStack Local marketplace, and install Sonar. Start a new thread when done and I'll handle the rest."

Once the user confirms the plugin is active in a new thread, run the guided setup:

```
@sonar sonar-codex-setup
```

This walks through first-time configuration. After that:

- If `.sonar/` does not exist: run `@sonar sonar-crawl` to build the map (10–30 min)
- If `.sonar/` exists but is stale: run `@sonar sonar-update` (2–3 min)

---

## If Sonar Is Active

This guide teaches you how to think with it — not just what commands to run, but when and why.

## The Core Idea

You are working in a codebase that has structure, conventions, business rules, and invisible connections between modules. Without Sonar, you discover these by reading files — slowly, incompletely, often missing things. With Sonar, you consult a pre-built understanding graph that knows the system's shape, rules, and flows.

**Sonar doesn't replace reading code. It tells you WHICH code to read and WHAT to look for.**

## How to Think With Sonar

### Before you start any task: orient first, code second

When you receive a task, your instinct is to grep for relevant files and start reading. Stop. Ask Sonar first:

```
@sonar sonar <your task description>
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
@sonar sonar-explore <feature description>
```

This spawns parallel agents that simulate 3-4 different implementation strategies against the real codebase graph. Each strategy is evaluated for: what it reuses, what it breaks, what conventions it follows or violates, what risks it carries. You get a comparative report with detailed tradeoffs.

**Use this when:** adding a new capability, integrating with a new service, refactoring a subsystem, or any task where there's more than one plausible approach.

**Don't use this for:** bug fixes, simple additions, or tasks where the approach is obvious.

### Before committing to a risky approach: simulate the impact

Once you've chosen an approach but before you write code:

```
@sonar sonar-impact <what you plan to change>
```

This shows you the cascade — 1st order (direct breakage), 2nd order (testing needed), 3rd order (awareness). It also checks if your approach violates any conventions in the affected modules.

**The question to ask yourself:** "Does the impact analysis show anything I hadn't considered?" If yes, reconsider. If no, proceed with confidence.

### While coding: respect the conventions

When a module card lists a convention — treat it as a constraint. These conventions exist because the team established them. Breaking a convention without justification creates inconsistency.

**If a convention conflicts with your task:** that's important information. Mention it in your PR, explain why the convention doesn't apply or needs to change. Don't silently ignore it.

### After changes: verify before you push

```
@sonar sonar-verify
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
    ├─ @sonar sonar <task>              ← orient: what do I need to know?
    │
    ├─ Is this complex?
    │   YES → @sonar sonar-explore       ← simulate strategies, compare tradeoffs
    │   NO  → proceed
    │
    ├─ Is the approach risky?
    │   YES → @sonar sonar-impact        ← what breaks, what cascades?
    │   NO  → proceed
    │
    ├─ Deleting a feature?
    │   YES → @sonar sonar-delete        ← precise deletion plan: delete, edit, keep
    │   NO  → proceed
    │
    ├─ Implement the changes
    │
    ├─ @sonar sonar-verify               ← did I follow the rules?
    │
    └─ Before review?
        YES → @sonar sonar-review-context
```

Not every task needs every step. A typo fix doesn't need `@sonar sonar-explore`. But any task that touches business logic, crosses module boundaries, or modifies a load-bearing module should go through the full cycle.

## Commands

| Command | When | What it does |
|---------|------|-------------|
| `@sonar sonar <task or question>` | Starting any work | Briefing, question, or path trace. Works without a map. |
| `@sonar sonar-explore <feature>` | Planning new features | Simulates 3-4 strategies in parallel, comparative analysis |
| `@sonar sonar-impact <change>` | Before risky changes | 1st/2nd/3rd order cascading effects |
| `@sonar sonar-verify` | After making changes | Automated convention checks + dependency verification |
| `@sonar sonar-review-context` | Before code review | Blast radius + convention checks + flow invariants for the diff |
| `@sonar sonar-blast <module>` | Deep-diving a module | Full reverse dependency tree |
| `@sonar sonar-workspace` | Visualizing / browsing | Interactive dependency graph and knowledge workspace |
| `@sonar sonar-crawl` | Building the map | Full 4-phase parallel analysis (one-time) |
| `@sonar sonar-update` | Refreshing the map | Incremental, only changed modules |
| `@sonar sonar-status` | Checking map health | Freshness, coverage, stale areas |
| `@sonar sonar-upgrade` | Checking for updates | Compares installed version against public GitHub |
| `@sonar sonar-install-agents` | Installing agent templates | Copies sonar_mapper, sonar_reviewer, sonar_worker to `.codex/agents/` |
| `@sonar sonar-reset` | Starting over | Deletes `.sonar/` completely |
| `@sonar sonar-version` | Checking plugin version | Installed version and whether an update is available |

## Hooks

Codex hook support is partial compared to Claude Code. `SessionStart` and `UserPromptSubmit` are configurable; `PreToolUse`/`PostToolUse` only intercept Bash, so edit-aware warnings and post-edit convention checks do not fire automatically. Use `@sonar sonar-verify` explicitly after making changes to compensate.

## Map State

```bash
ls .sonar/meta.json 2>/dev/null && echo "Full map" || (ls .sonar/skeleton.json 2>/dev/null && echo "Partial" || echo "No map")
```

- **Full map** → everything works
- **Partial** → `@sonar sonar` uses what exists, fills gaps on-the-fly
- **No map** → `@sonar sonar` runs a targeted scan (~2-3 min), caches results. Run `@sonar sonar-crawl` for complete coverage.

## What the Map Contains

- **Module cards** (`.sonar/modules/*.json`) — purpose, business rules with source locations, conventions with check commands, public API, function cards
- **Flow narratives** (`.sonar/flows/*.json`) — entry→exit data flow with invariants and failure modes
- **System understanding** (`.sonar/system.json`) — domain model, domain overlaps, patterns, conventions, architecture layers, load-bearing modules, tensions

The map can be stale. If it's >3 days old, verify critical claims against actual code. Run `@sonar sonar-update` to refresh.

Git-track: `modules/`, `flows/`, `system.json`, `skeleton.json`, `meta.json`. Gitignore: `graph.db`, `summaries.json`, `file-modules.json`.
