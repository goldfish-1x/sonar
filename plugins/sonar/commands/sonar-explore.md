---
description: Explore how a new feature could be implemented — spawns parallel subagents to simulate multiple strategies and produces a comparative analysis with tradeoffs.
argument-hint: <feature description>
allowed-tools: Read, Bash, Glob, Grep, Agent
---

# /sonar explore

Multi-strategy architectural exploration. Identifies 3-4 plausible implementation strategies, simulates each against the codebase graph in parallel, and produces a comparative report with detailed tradeoffs.

## Phase 1: Gather System Context

1. **Check map exists.** If no `.sonar/graph.db`, suggest `/sonar crawl` or do a targeted scan (same as `/sonar` no-map path).

2. **Read the full system context:**
```bash
cat .sonar/system.json
sqlite3 .sonar/graph.db "SELECT key, purpose FROM modules ORDER BY key"
sqlite3 .sonar/graph.db "SELECT source_module, target_module, kind, weight FROM edges ORDER BY weight DESC"
```

3. **Search for related modules and flows:**
```bash
sqlite3 .sonar/graph.db "SELECT key, purpose FROM modules_fts WHERE modules_fts MATCH '<terms>' ORDER BY rank LIMIT 10"
sqlite3 .sonar/graph.db "SELECT name, title FROM flows_fts WHERE flows_fts MATCH '<terms>' ORDER BY rank LIMIT 5"
```

4. **Read the top 5-8 related module cards** in full — these are the modules any strategy would touch.

5. **Read related flow narratives** — these show how data currently moves through the areas the feature would affect.

## Phase 2: Identify Strategies

From the system context + feature description, identify **3-4 distinct implementation strategies.** Each strategy should be a genuinely different architectural approach, not a minor variation.

Good strategy differentiation:
- Strategy A extends an existing module vs Strategy B creates a new module
- Strategy A uses existing infrastructure (cron, queues) vs Strategy B builds custom
- Strategy A modifies a load-bearing module vs Strategy B adds a parallel path
- Strategy A follows existing patterns exactly vs Strategy B introduces a new pattern

For each strategy, write a 2-3 sentence hypothesis: what's the core idea, where does the code live, what's the key tradeoff.

## Phase 3: Simulate Strategies (parallel subagents)

**Spawn one strategy-explorer subagent per strategy — ALL simultaneously.**

Each subagent receives this prompt (fill in the specifics):

```
You are a strategy explorer for Sonar. You are evaluating ONE specific approach
to implementing a feature. Simulate this strategy against the codebase graph
and produce a detailed analysis.

## Feature
<feature description from user>

## Strategy
<strategy hypothesis — the specific approach this agent is evaluating>

## System Context
<paste system.json summary, module list, edge list>

## Related Module Cards
<paste the 5-8 related module cards>

## Related Flows
<paste the related flow narratives>

## Produce This Analysis

### Strategy Summary
2-3 paragraphs explaining the approach in detail. What gets built, where it lives,
how it connects. Be specific — name files, functions, patterns.

### What You Reuse
For each existing module/function/pattern this strategy builds on:
- What it is and where it lives (file:line)
- How this strategy uses it
- Whether it needs modification or can be used as-is

### What You Build New
For each new piece:
- What it is and where it would go
- Why it can't reuse something existing
- How it follows existing conventions (or why it can't)

### Integration Points
Every place existing code needs to change:
- File, function, what changes, why
- Schema changes if any
- New dependency edges introduced

### Conventions Analysis
For each relevant convention from the module cards and system.json:
- Does this strategy follow it naturally?
- Does it require bending or breaking it?
- If breaking: what's the justification?

### Flow Impact
- Which existing flows gain new steps or branches?
- What new flows does this strategy create?
- Any invariants that become harder to maintain?

### Domain Model Impact
- New concepts introduced
- Relationships to existing concepts
- Overlap with existing module domains?

### Risks and Downsides
Be honest about what's hard or dangerous about this approach:
- Load-bearing modules touched
- Complexity introduced
- Performance implications
- What could go wrong during implementation
- What could go wrong in production
- Architectural tensions created or worsened

### What Makes This Strategy Good
The genuine strengths — not marketing, but real architectural advantages:
- Simplicity, reuse, isolation, performance, maintainability
- How it aligns with existing patterns
- Future flexibility it provides or preserves
```

Use `run_in_background: true`. Send ALL spawn calls in a single message.

## Phase 4: Comparative Analysis

After all strategy-explorer subagents complete, read their outputs and produce a unified report.

### Output Format

```markdown
## Sonar Exploration: <feature name>

### The Feature
<1-2 paragraph restatement of what was asked for, grounded in the codebase context.
What domain concepts does this touch? What existing capabilities does it extend?>

---

### Strategy A: <name>

<strategy summary — 2-3 paragraphs from the subagent, edited for clarity>

**Builds on:** <key modules/patterns reused, with file:line>
**Builds new:** <key new pieces>
**Touches:** <N modules, M files, K flows affected>
**Convention fit:** <follows N/M conventions naturally, breaks K with justification>
**Risk profile:** <1-2 sentence summary of main risks>

---

### Strategy B: <name>

<same structure>

---

### Strategy C: <name>

<same structure>

---

### Comparative Analysis

#### Tradeoff Matrix

| Dimension | Strategy A | Strategy B | Strategy C |
|-----------|-----------|-----------|-----------|
| **Reuse** | <what and how much> | <what and how much> | <what and how much> |
| **New code** | <scope> | <scope> | <scope> |
| **Modules touched** | <count + names> | <count + names> | <count + names> |
| **Load-bearing risk** | <which, if any> | <which, if any> | <which, if any> |
| **Convention alignment** | <natural/forced/breaking> | <...> | <...> |
| **New patterns introduced** | <count + what> | <...> | <...> |
| **Flow complexity** | <simpler/same/more complex> | <...> | <...> |

#### Detailed Tradeoff Discussion

For each significant tradeoff, explain BOTH sides:

**Reuse vs Clean Separation**
Strategy A reuses the dispatch system heavily — this means less new code but makes
dispatch.ts even more load-bearing (currently fan-in: 8, would become 9). Strategy B
creates a standalone module — more new code but zero risk to existing dispatch paths.
The question is: is dispatch.ts already complex enough that adding another gateway type
is risky, or is it designed to absorb new types?

**Convention Conformance vs Feature Needs**
Strategy C needs to break the "all state changes flow through Convex mutations" convention
because scheduled execution needs a persistent queue that Convex crons can't provide
(1-minute granularity). This is a legitimate architectural constraint, not a shortcut.
But it means maintaining a second state management pattern alongside Convex.

**Implementation Effort vs Future Flexibility**
Strategy A is the fastest to implement (extends existing patterns) but locks the scheduling
model to what dispatch.ts can express. Strategy B takes longer but creates a module that
could later support complex scheduling (recurring, conditional, priority queues) without
touching dispatch.ts at all.

[Continue for each significant tradeoff dimension...]

#### What None of These Strategies Address
Things the user should think about that no strategy solves:
- <edge case or concern that all strategies share>
- <question that needs user input to resolve>

#### Recommendation

<2-3 paragraphs. Not just "Strategy A is best" — explain WHY for this specific codebase,
this specific team, this specific moment. Reference specific codebase characteristics
that tip the balance.>

<If no clear winner: explain what information would tip the decision one way or another.
"If you expect scheduling to remain simple (time-based only), Strategy A. If you anticipate
complex scheduling rules, Strategy B is worth the upfront cost.">
```

## Key Principles

- **Strategies must be genuinely different.** Not "same approach with minor tweaks." Each should represent a fundamentally different architectural choice.
- **Be honest about downsides.** Every strategy has weaknesses. A strategy with no listed risks is a strategy that hasn't been thought through.
- **Explain tradeoffs in terms a senior engineer cares about.** Not "more files" — instead "the dispatch module's fan-in increases from 8 to 9, making it the single highest-risk module in the system."
- **Ground everything in the actual codebase.** Reference specific modules, files, functions, patterns, conventions. Abstract advice is worthless.
- **The recommendation should be defensible.** Someone reading it should be able to disagree intelligently — which means the reasoning must be visible, not just the conclusion.
- **Surface what you don't know.** If the decision depends on information not in the graph (team preferences, timeline, future roadmap), say so explicitly rather than guessing.
