---
name: sonar
description: Use when the user asks to use Sonar, when a repo has `.sonar/` artifacts and you need a task briefing, codebase Q&A, or a path trace, or before substantial edits in a Sonar-mapped codebase.
user-invocable: true
---

# Sonar Briefing

Sonar is the entry point for understanding a mapped codebase before editing it.

## Use this skill to

- orient on a task before reading code by hand
- answer architecture or dependency questions from `.sonar/`
- trace a path between modules or concepts
- route repository setup requests to `@sonar sonar-codex-setup`
- route plugin update/version freshness requests to `@sonar sonar-upgrade`
- route Codex custom-agent setup requests to `@sonar sonar-install-agents`

## Workflow

1. Check whether `.sonar/meta.json` exists.
2. If the map is missing, say so plainly. If the user wants Sonar coverage, route them to `@sonar sonar-crawl` to build it first.
3. Read `.sonar/state.json` when present and treat freshness as part of the answer.
4. Prefer the bundled retrieval script for natural-language lookup. Resolve `SONAR_PLUGIN_ROOT` from the absolute path of this `SKILL.md` file, then run:

```bash
node "$SONAR_PLUGIN_ROOT/scripts/retrieve-context.mjs" .sonar enhanced "<query>"
```

5. Backstop the retrieval result with the source artifacts that matter:
- `.sonar/modules/*.json`
- `.sonar/flows/*.json`
- `.sonar/system.json`
- `.sonar/graph.db`

## Output

Answer with:

- relevant modules and what they do
- related flows and invariants
- freshness or staleness warnings
- direct blast radius or dependency notes
- the next Sonar action when useful, usually `@sonar sonar-impact` or `@sonar sonar-verify`

## Notes

- If the user asks for a path from A to B, trace it from `edges` in `.sonar/graph.db`.
- If the user asks how to install or configure Sonar for Codex, route them to `@sonar sonar-codex-setup`.
- If the user asks whether Sonar itself is up to date or how to upgrade the plugin, route them to `@sonar sonar-upgrade`.
- If the query is change-oriented, explicitly suggest `@sonar sonar-impact`.
- If the user asks for Sonar-specific Codex agents, models, or subagents, route them to `@sonar sonar-install-agents`.
- Do not pretend the map is fresh if `state.json` or `meta.json` says otherwise.
