# Sonar on Codex

This document records what ports cleanly from the Claude Code plugin and what does not, based on the current Codex plugin and hook model.

## What Ports Cleanly

- The Sonar core:
  - `sonar/scripts/*.mjs`
  - `sonar/lib/*.mjs`
  - `.sonar/` artifacts and schemas
  - the local workspace UI built by `build-wiki.mjs` and `serve-wiki.mjs`
- The command layer as Codex skills:
  - `sonar`
  - `sonar-crawl`
  - `sonar-explore`
  - `sonar-impact`
  - `sonar-verify`
  - `sonar-review-context`
  - `sonar-status`
  - `sonar-update`
  - `sonar-upgrade`
  - `sonar-workspace`
  - `sonar-version`
  - `sonar-reset`
  - `sonar-codex-setup`
  - `sonar-install-agents`
- Local installation through a Codex marketplace:
  - repo marketplace: `.agents/plugins/marketplace.json`
  - generated plugin bundle: `plugins/sonar`
  - source plugin manifest: `sonar/.codex-plugin/plugin.json`
- Codex custom-agent templates:
  - source templates: `sonar/codex-agents/*.toml`
  - bundled templates: `plugins/sonar/codex-agents/*.toml`
  - installer skill: `sonar-install-agents`

## What Changes in Codex

- Codex plugins expose bundled skills, apps, and MCP servers.
- Codex does not currently provide custom slash commands through plugins.
- Codex plugins do not currently register custom agents from plugin metadata. Sonar can bundle Codex agent templates as files, but they become active only after installation into `.codex/agents/` or `~/.codex/agents/`.
- Codex CLI plugin installation is build-dependent. In `codex-cli 0.114.0`, `codex --enable plugins` enables the feature flag but `/plugins` is still not recognized, so the Codex app plugin panel is the reliable install path today.
- The right Codex surface for Sonar is therefore:
  - install plugin
  - invoke `@sonar`
  - invoke `@sonar sonar-codex-setup` to configure repo usage and AGENTS.md guidance
  - invoke bundled skills explicitly when needed, for example `@sonar sonar-impact`
  - invoke `@sonar sonar-upgrade` to compare the installed plugin version with the public GitHub manifest
  - optionally invoke `@sonar sonar-install-agents` to install project-scoped custom agents

## Claude Code Contrast

Claude Code can add a GitHub plugin marketplace directly:

```text
/plugin marketplace add goldfish-1x/sonar
/plugin install sonar@sonar
/reload-plugins
```

That activates the Claude plugin surface from `plugins/sonar`: `.claude-plugin/plugin.json`, `commands/`, `agents/`, `hooks/`, and `skills/`. Codex uses `.agents/plugins/marketplace.json` and `.codex-plugin/plugin.json` instead, so the two clients share a repo and version but activate different manifests.

## Repository Instructions

Codex reads project guidance from `AGENTS.md`. Sonar should not silently edit that file, but it should provide a copy-paste section through `@sonar sonar-codex-setup` and the README.

Recommended behavior for repos that opt in:

- add a `## Sonar Usage` section to the nearest relevant `AGENTS.md`
- tell future Codex sessions to use `@sonar sonar-impact` before risky implementation work
- tell future Codex sessions to use `@sonar sonar-verify` before finalizing changes
- tell future Codex sessions to use `@sonar sonar-upgrade` when the user asks whether the plugin is current
- remind agents to treat stale Sonar maps as guidance that must be checked against source

## Versioning and Upgrades

Sonar versions are kept in sync across the Claude manifest, Codex manifest, package files, and generated Codex bundle by `scripts/bump-sonar-version.sh`.

Codex users can check for updates with:

```text
@sonar sonar-upgrade
```

The skill runs `scripts/check-codex-update.mjs`, which compares the installed plugin manifest with:

```text
https://raw.githubusercontent.com/goldfish-1x/sonar/main/plugins/sonar/.codex-plugin/plugin.json
```

If a newer remote version exists, users should update the git checkout that provides the local marketplace, restart Codex, and verify with `@sonar sonar-version`. If the plugin was copied outside a git checkout, users should fetch the latest GitHub repo and reinstall from the `FishStack Local` marketplace.

## Codex Custom Agents

Codex custom agents are TOML files loaded from project or personal configuration, not from a plugin manifest. Sonar therefore ships templates rather than claiming native plugin-scoped agent registration.

Bundled templates:

- `sonar_mapper`: read-only mapping on `gpt-5.4-mini`
- `sonar_reviewer`: read-only review on `gpt-5.4` with high reasoning
- `sonar_worker`: write-capable implementation on `gpt-5.4`

Installation path:

```text
@sonar sonar-install-agents
```

The installer copies templates into `.codex/agents/` and refuses to overwrite existing project files unless run with `--force`.

## Hook Compatibility

Codex hooks are configured separately in `.codex/hooks.json`. They are not bundled in the plugin manifest today.

### Feasible with manual Codex hook setup

- `SessionStart`
- `UserPromptSubmit`

These can inject context or status messages and are close enough to Sonar's current behavior to be worth revisiting if automatic hook wiring becomes desirable.

### Feasible, but needs a Codex-specific wrapper

- `Stop`

Codex `Stop` hooks require JSON on stdout and use a different continuation model than Claude. Sonar's current `on-ripple-stop.mjs` would need a Codex output adapter before reuse.

### Not portable today

- `PreToolUse` for `Edit|Write`
- `PostToolUse` for `Edit|Write`
- Ripple Guard's edit-aware progress tracking
- Post-edit convention checks

Current Codex `PreToolUse` and `PostToolUse` only emit `Bash`. They do not currently intercept `Write`, `Edit`, MCP tools, web search, or other non-shell tool calls. That means Sonar cannot reproduce Claude's automatic edit warnings and post-edit convention enforcement in Codex yet.

## Recommended Product Position

Ship Sonar for Codex now as:

- a plugin bundle
- a skill-based workflow surface
- optional Codex custom-agent templates installed by skill into `.codex/agents/`
- no automatic hooks by default

Treat hooks as a follow-up track gated on Codex runtime support for either:

- plugin-scoped hook packaging, or
- `Write`/`Edit` interception in `PreToolUse` and `PostToolUse`

Until then, the skill bundle covers the core value without promising automation Codex cannot currently deliver.
