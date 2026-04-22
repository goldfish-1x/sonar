---
name: sonar-install-agents
description: Use when the user wants Sonar's Codex custom-agent templates installed into the current project, or asks for Sonar-specific Codex subagents/models.
user-invocable: true
---

# Install Sonar Codex Agents

Codex plugins can bundle agent templates, but Codex loads custom agents only from `.codex/agents/` or `~/.codex/agents/`. This skill installs Sonar's bundled project-scoped custom agents into the current repository.

## Workflow

1. Resolve `SONAR_PLUGIN_ROOT` from the absolute path of this `SKILL.md` file.
2. Run the installer from the target project root:

```bash
node "$SONAR_PLUGIN_ROOT/scripts/install-codex-agents.mjs" --project-root "$PWD"
```

3. If the installer reports existing files, do not overwrite them unless the user explicitly asks. To overwrite, rerun with `--force`.
4. Tell the user to restart Codex after installation so the new custom agents are loaded.
5. If they want persistent repository guidance, route them to `@sonar sonar-codex-setup` for the recommended `AGENTS.md` snippet.

## Installed Agents

- `sonar_mapper`: read-only mapping on `gpt-5.4-mini`
- `sonar_reviewer`: read-only review on `gpt-5.4` with high reasoning
- `sonar_worker`: write-capable implementation on `gpt-5.4`

## Notes

- These are Codex custom-agent TOML files, not Claude Code agent markdown files.
- The templates are installed into `.codex/agents/` so they remain project-local and reviewable.
- Use `--dry-run` to show what would be installed without writing files.
