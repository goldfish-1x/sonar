---
name: sonar-upgrade
description: Use when the user asks whether Sonar is up to date, wants to check for a newer Sonar Codex plugin version, or wants upgrade instructions.
user-invocable: true
---

# Sonar Upgrade

Use this skill to compare the installed Sonar Codex plugin version against the public GitHub plugin manifest and explain the upgrade path.

## Workflow

1. Resolve `SONAR_PLUGIN_ROOT` from the absolute path of this `SKILL.md` file.
2. Run:

```bash
node "$SONAR_PLUGIN_ROOT/scripts/check-codex-update.mjs"
```

3. Report the installed version, latest version, and whether an update is available.
4. If an update is available and the plugin is inside a git checkout, instruct the user to run:

```bash
git pull --ff-only
```

from the repo root reported by the script.

5. Tell the user to restart Codex after upgrading so plugin files, skills, prompts, and agent templates are reloaded.
6. In a new thread, verify with:

```text
@sonar sonar-version
```

## Rules

- Do not say an update exists unless `check-codex-update.mjs` found a newer remote manifest version.
- If the remote check fails, report that the update status is unknown and include the error.
- Do not run `git pull` unless the user explicitly asked to upgrade, not merely check.
- If the plugin is not inside a git checkout, instruct the user to fetch the latest `https://github.com/goldfish-1x/sonar` repo and reinstall from the `FishStack Local` marketplace.
