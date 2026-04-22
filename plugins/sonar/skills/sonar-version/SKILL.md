---
name: sonar-version
description: Use when the user wants the installed Sonar plugin version or manifest metadata in Codex.
user-invocable: true
---

# Sonar Version

Report the installed Sonar version from the bundled plugin manifest.

## Workflow

1. Resolve `SONAR_PLUGIN_ROOT` from this skill path.
2. Read `"$SONAR_PLUGIN_ROOT/.codex-plugin/plugin.json"`.
3. Report the plugin name, version, description, and repository metadata.
4. If the user asks whether an update is available, route to `@sonar sonar-upgrade`.
5. If the user is working from source, you may also compare against the current git checkout.

## Rules

- Report what is locally installed first.
- If remote comparison is unavailable, say so instead of guessing.
- Use `@sonar sonar-upgrade` for remote latest-version checks and upgrade instructions.
