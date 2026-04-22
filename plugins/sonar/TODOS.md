# Sonar TODOs

Deferred work captured from CEO plan reviews. Sequenced by trigger condition, not calendar.

---

## [P2] Public map registry (sonar.dev hosted maps)

**What:** Registry hosting community-maintained Sonar maps for popular OSS (React, Rails, Django, Linux, Rust stdlib, etc.). Users run `sonar-pull facebook/react` and download a pre-built map in ~10s instead of crawling for 20min. Open submission via PR to a registry repo, signed provenance, versioned against upstream commits.

**Why:** biggest onboarding cliff today is the 20-minute first crawl. Registry collapses it to seconds for popular repos. Network effect: more popular repos = more users = more contributors = more maps.

**Pros:**
- Massive growth lever — turns "install and wait 20 min" into "install and go"
- Network effect compounds
- Makes Sonar feel like real infrastructure

**Cons:**
- Real ops cost (hosting, storage, moderation, freshness-against-upstream)
- Not a product feature — a growth channel. Competes for attention with core product work

**Context:** framed by user as "growth strategy / ad spend" rather than core product. Deferred in 2026-04-17 CEO plan; the plan's cathedral-mode vision already relies on MCP + schema spec for distribution, which is sufficient without a hosted registry to prove the thesis.

**Prereqs:** P3b (schema spec v1) frozen. Registry needs a signed, versioned manifest format that pins to the spec version.

**Trigger to pull in:** qualitative — when ≥5 users in GitHub issues ask "where do I get a pre-built map for X?" OR a partner (Cursor / Codex team / agent ecosystem) requests it as a blocker for adoption.

**Effort:** S (human: M, ~6-8 weeks → CC+gstack: ~1.5-2 weeks).

**Priority:** P2.

**Depends on:** P3b (schema spec v1 published and stable for 30+ days).

---

## [P2] Behavioral signal layer (coverage, churn, owners, traces)

**What:** Extend the knowledge graph with runtime-derived behavioral data — test coverage heatmap (from lcov / coverage.json / jest output), commit churn + recency (from git log), owner graph (from git blame), optional execution traces (from OpenTelemetry when present), test-to-module mapping. Becomes new fields on module cards and new edge types in graph.db.

**Why:** Sonar today describes the static shape of the codebase. Behavioral data tells agents where the system actually *lives* — which files change constantly, which haven't been touched in 2 years, which paths are well-tested, which are landmines. Makes recommendations materially smarter: "you're changing a load-bearing module with 8% coverage and 40 commits/month" is dramatically more useful than "you're changing a load-bearing module."

**Pros:**
- Deepens the moat — embedding-based competitors can't do this without the graph
- Makes Sonar feel alive, not static
- Unlocks weighted convention checks (flag violations harder when coverage is low)

**Cons:**
- Adds schema complexity — affects P3b's stability guarantees. Must ship AFTER P3b freezes, not during
- Behavioral data goes stale faster than structural data, which stresses P4 (freshness)
- Value is not proven without user signal

**Context:** deferred in 2026-04-17 CEO plan because it doesn't unlock distribution. The cathedral-mode thesis is cross-agent distribution + eval-validated quality, not deeper maps. Behavioral layer is a moat-deepener for Phase 2.

**Prereqs:** P3b v1 schema frozen AND stable for 30+ days (no breaking changes in that window).

**Trigger to pull in:** after Wave 3 of the current cycle ships and either (a) user feedback identifies behavioral context as the top missing capability, or (b) a competitor ships static-graph-only code intelligence with better polish, at which point behavioral depth becomes the differentiator.

**Effort:** S (human: L, ~4-5 weeks → CC+gstack: ~1-1.5 weeks).

**Priority:** P2.

**Depends on:** P3b frozen and stable. Ideally also depends on P0 (eval harness) being live so we can measure whether behavioral signals actually improve agent task outcomes.

---

## [P2] Antigravity + Factory integration playbooks

**What:** Named-agent integration playbooks for Antigravity and Factory, same format as Cursor/Codex playbooks shipping in the current cycle (README + install script + verify script + fixture repo, weekly CI).

**Why:** extends cross-agent distribution to the remaining two named target agents. Makes "runs on every major coding agent" credible.

**Context:** reviewer flagged 4 agent playbooks in the current cycle as unrealistic. Scoped to Cursor + Codex first. Antigravity + Factory deferred to next cycle.

**Prereqs:** Cursor + Codex playbooks shipped AND each validated by at least one real user task-to-PR flow.

**Trigger:** Cursor + Codex playbooks green on weekly CI for 30+ days.

**Effort:** S (human: M, ~2-3 weeks → CC+gstack: ~5-7 days).

**Priority:** P2.

---

## [P3] Invariant-eval-in-CI (P7b expansion)

**What:** Extend PR graph-diff GitHub Action from structural-only to running Sonar's convention check commands + flow invariant checks inside CI against both the base and head refs. Comment surfaces actual invariant violations introduced by the PR, not just structural changes.

**Why:** structural diff is useful; invariant-eval is game-changing. A PR that silently breaks an invariant gets caught in CI instead of production.

**Context:** current cycle's P7b is scoped structural-only per reviewer feedback (invariant evaluation in CI is expensive and requires check-command runtime inside the Action container). Deferred to phase where we have CI-runtime budget.

**Prereqs:** P7b (structural diff) shipped. Check-command allowlist (3-sec) hardened.

**Effort:** M (human: L, ~4-6 weeks → CC+gstack: ~1-1.5 weeks).

**Priority:** P3.

---

## [P3] Business rule contract test generation

**What:** Auto-generate property-based tests from the `business_rules` field on module cards. Each business_rule with a `source_file:line` gets a generated test that asserts the rule still holds against the module's public API.

**Why:** turns Sonar's documented knowledge into enforcement. Break a business rule, break the build. Converts Sonar from "descriptive" to "load-bearing."

**Context:** delight item #5 from CEO plan's 10 delight opportunities list. Deferred in this cycle to keep scope tight.

**Prereqs:** P3b schema stable. Business rules field quality audit (many existing cards have vague business_rules).

**Effort:** M (human: L, ~4-6 weeks → CC+gstack: ~1-1.5 weeks).

**Priority:** P3.

---

## [P3] Map-as-CLAUDE.md generator

**What:** `/sonar:sonar-claude-md` command that generates a skeleton CLAUDE.md from `system.json` synthesis + top module cards. New repos get a useful CLAUDE.md for free.

**Why:** leverage work Sonar already does into something every agent sees (CLAUDE.md is always loaded). Discoverability win.

**Context:** delight item #10 from CEO plan. Deferred for scope.

**Effort:** S (human: S, ~1 week → CC+gstack: ~2-3 days).

**Priority:** P3.

---

## [P3] Freshness Tier 2 — idle-time semantic refresh queue

**What:** Second tier of FRESHNESS_DESIGN.md — automatic semantic (module card) refresh queued to idle time, so users never manually run `/sonar:sonar-update` even for semantic staleness.

**Why:** completes the "invisible freshness" promise. Tier 1 (shipping in cycle) covers structural; Tier 2 covers semantic.

**Context:** descoped from the current cycle per reviewer feedback that Tier 1 alone is subtle enough and Tier 2 adds material risk.

**Prereqs:** P4 Tier 1 shipped and stable for 30+ days. Freshness SLO measured and meeting >95% target on structural.

**Effort:** S (human: M, ~2-3 weeks → CC+gstack: ~5-7 days).

**Priority:** P3.

---
