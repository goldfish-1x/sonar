# Changelog

## 0.5.7 — 2026-04-10

- Test files, key invariants, and verification commands now injected into agent context automatically
- Agents see which tests to run and what invariants to uphold when working in a module
- Derived from skeleton file lists — no recrawl required
- Fixed field name mismatch that caused empty briefs (`responsibilities`/`patterns`/`exports` → `business_rules`/`conventions`/`public_api`)
- Fixed empty module purpose falling back to `card.description`
- Cross-platform stdin fix (fd 0 instead of `/dev/stdin`)
- Local telemetry: `usage.jsonl` and `hook-errors.log` written to `.sonar/`
- README rewrite with install, platform support, requirements, and usage patterns

## 0.5.6 — 2026-04-09

- `/sonar version` command — shows installed version, commit SHA, update check
- Graph workspace redesign with canonical knowledge snapshot
- Graph-based file ranking, parent cards, semantic submodule cards
- Large-module crawl fixes — splitting, ranking, file-graph
- Interactive dependency graph at `/graph`
- Wiki DX improvements — severity badges, cross-links, Mermaid
