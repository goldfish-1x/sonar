---
name: sonar-codex-setup
description: Use when setting up Sonar for Codex in a repository, including plugin usage, optional custom agents, and AGENTS.md instructions.
user-invocable: true
---

# Sonar Codex Setup

Use this skill after Sonar is installed as a Codex plugin and the user wants the current repository configured to use it consistently.

## Setup Checklist

1. Confirm Sonar is installed by checking that `@sonar` skills are available in the current thread.
2. Check for `.sonar/meta.json`.
3. If `.sonar/` is missing, recommend `@sonar sonar-crawl` before relying on Sonar for codebase understanding.
4. If `.sonar/state.json` or `.sonar/meta.json` indicates stale coverage, recommend `@sonar sonar-update`.
5. Recommend `@sonar sonar-upgrade` when the user asks whether the installed plugin is current.
6. Ask whether the user wants project-scoped custom agents. If yes, route to `@sonar sonar-install-agents`.
7. Add or update the nearest relevant `AGENTS.md` only when the user asks for persistent repo instructions.

## Recommended AGENTS.md Snippet

Append this section to the repository root `AGENTS.md`, or to a nested `AGENTS.md` if Sonar should apply only to part of the repo:

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

## Day-to-Day Usage

- `@sonar`: task briefing and codebase Q&A
- `@sonar sonar-crawl`: build the initial `.sonar/` map
- `@sonar sonar-update`: refresh the map after code changes
- `@sonar sonar-impact "<task>"`: plan a change against the map
- `@sonar sonar-review-context`: collect review context
- `@sonar sonar-verify`: validate a branch against mapped conventions
- `@sonar sonar-workspace`: open the local Sonar workspace/wiki
- `@sonar sonar-upgrade`: check for plugin updates and get upgrade instructions
- `@sonar sonar-install-agents`: install optional Codex custom-agent templates

## Editing Rules

- Preserve existing `AGENTS.md` content. Append a new `## Sonar Usage` section only if one is not already present.
- If a Sonar section already exists, update it in place instead of adding a duplicate.
- Keep the instructions tool-neutral enough that they do not break Claude Code usage, but use Codex invocation syntax for Codex-specific workflows.
