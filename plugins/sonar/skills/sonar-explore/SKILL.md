---
name: sonar-explore
description: Use when the user wants multiple implementation strategies evaluated against the current Sonar map before coding.
user-invocable: true
---

# Sonar Explore

Use Sonar to compare distinct implementation strategies before coding.

## Workflow

1. Confirm `.sonar/graph.db` exists. If not, direct the user to `@sonar sonar-crawl` or a narrower Sonar briefing first.
2. Gather system context from:
- `.sonar/system.json`
- `.sonar/modules/*.json` for the most relevant modules
- `.sonar/flows/*.json` for affected flows
- `.sonar/graph.db` for dependency shape

3. Identify 3-4 genuinely distinct strategies, not cosmetic variations.
4. If subagents are available and permitted, evaluate those strategies in parallel. Otherwise do the comparison yourself.
5. For each strategy, cover:
- what it reuses
- what it adds
- which modules or flows it touches
- convention fit
- operational and architectural risks

## Output

Produce:

- a short restatement of the feature in current system terms
- one section per strategy
- a direct tradeoff matrix
- a recommendation tied to this codebase, not generic advice

## Rules

- Name the actual modules, files, and patterns involved.
- Call out load-bearing modules and freshness issues explicitly.
- If the map is stale in the touched area, lower confidence instead of overselling certainty.
