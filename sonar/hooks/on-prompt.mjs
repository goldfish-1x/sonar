#!/usr/bin/env node

/**
 * Sonar — UserPromptSubmit hook
 * Injects codebase context briefing when .sonar/ map exists.
 * Prefers agent briefs generated from graph.db, then falls back to summaries.json.
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync, readdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createHash } from "crypto";
import { loadSonarConfig } from "../lib/config.mjs";
import { loadSonarState } from "../lib/state.mjs";
import { enhancedRetrieve } from "../scripts/retrieve-context.mjs";
import { logUsage } from "../lib/usage-log.mjs";

// --- Config ---
const MIN_PROMPT_LENGTH = 15;
const STOPWORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "shall", "can", "to", "of", "in", "for",
  "on", "with", "at", "by", "from", "as", "into", "through", "during",
  "before", "after", "above", "below", "between", "under", "again",
  "further", "then", "once", "here", "there", "when", "where", "why",
  "how", "all", "each", "every", "both", "few", "more", "most", "other",
  "some", "such", "no", "not", "only", "own", "same", "so", "than",
  "too", "very", "just", "because", "but", "and", "or", "if", "while",
  "about", "up", "out", "off", "over", "this", "that", "these", "those",
  "i", "me", "my", "we", "our", "you", "your", "it", "its", "they", "them",
  "what", "which", "who", "whom", "please", "want", "need", "make", "let"
]);

function trackSession(sessionId, moduleKeys) {
  const sessionDir = join(tmpdir(), "sonar-sessions");
  try {
    mkdirSync(sessionDir, { recursive: true });
    const sessionFile = join(sessionDir, `${createHash("sha256").update(sessionId).digest("hex").slice(0, 16)}.txt`);
    writeFileSync(sessionFile, moduleKeys.join(",") + "\n", { flag: "a" });
  } catch { /* non-fatal */ }
}

function formatEnhancedContext(result, limits, state = null) {
  const lines = ["## Sonar Context\n"];

  if (result.briefs.length > 0) {
    lines.push("### Relevant Modules");
    for (const brief of result.briefs.slice(0, limits.maxModules)) {
      lines.push(`- **${brief.module.key}** — ${brief.module.purpose || brief.module.name || "No purpose recorded."}`);

      const conventionItems = (brief.conventions || []).slice(0, 2).map(item => {
        const rule = typeof item === "string" ? item : item?.rule || item?.text || "";
        const check = typeof item === "object" && item?.check ? ` [verify: \`${item.check}\`]` : "";
        return rule ? `${rule}${check}` : null;
      }).filter(Boolean);
      const ruleItems = (brief.business_rules || []).slice(0, 2).map(item => {
        const rule = typeof item === "string" ? item : item?.rule || item?.text || "";
        const source = typeof item === "object" && item?.source ? ` [${item.source}]` : "";
        return rule ? `${rule}${source}` : null;
      }).filter(Boolean);
      if (conventionItems.length > 0) lines.push(`  - Conventions: ${conventionItems.join("; ")}`);
      if (ruleItems.length > 0) lines.push(`  - Rules: ${ruleItems.join("; ")}`);
      if (brief.side_effects && brief.side_effects.length > 0) {
        lines.push(`  - Side effects: ${brief.side_effects.slice(0, 3).join("; ")}`);
      }
      if (brief.notes) {
        const note = brief.notes.length > 200 ? brief.notes.slice(0, 200) + "..." : brief.notes;
        lines.push(`  - Note: ${note}`);
      }
      // Test files
      if (brief.test_files && brief.test_files.length > 0) {
        lines.push(`  - Test files: ${brief.test_files.slice(0, 3).map(f => f.split("/").slice(-2).join("/")).join(", ")}`);
      }
      // Key invariants
      if (brief.key_invariants && brief.key_invariants.length > 0) {
        lines.push(`  - Invariants: ${brief.key_invariants.slice(0, 2).join("; ")}`);
      }
      // Verification commands
      if (brief.verification_commands && brief.verification_commands.length > 0) {
        lines.push(`  - Verify: \`${brief.verification_commands[0]}\``);
      }
      if (brief.freshness && !["fresh", "unknown"].includes(brief.freshness.status)) {
        lines.push(`  - Freshness: ${brief.freshness.status} — ${brief.freshness.reason}`);
      }
    }
    lines.push("");
  }

  if (result.flows.length > 0) {
    lines.push("### Related Flows");
    for (const flow of result.flows.slice(0, limits.maxFlows)) {
      const details = [];
      if (typeof flow.confidence === "number") details.push(`confidence ${flow.confidence.toFixed(2)}`);
      if (flow.freshness && !["fresh", "unknown"].includes(flow.freshness)) details.push(flow.freshness);
      const suffix = details.length > 0 ? ` (${details.join(", ")})` : "";
      lines.push(`- **${flow.name}** — ${flow.title}${suffix}`);
      if (flow.invariants && flow.invariants.length > 0) {
        lines.push(`  Invariants: ${flow.invariants.slice(0, 3).join("; ")}`);
      }
    }
    lines.push("");
  }

  if (result.system_facts.length > 0) {
    lines.push("### System Facts");
    for (const fact of result.system_facts.slice(0, limits.maxFacts)) {
      const factDetail = fact.detail || fact.scope || "";
      lines.push(`- **${fact.title}** (${fact.kind})${factDetail ? ` — ${factDetail}` : ""}`);
    }
    lines.push("");
  }

  const alerts = result.system_facts.filter(f => f.kind === "overlap" || f.kind === "tension");
  if (alerts.length > 0) {
    lines.push("### Architectural Alerts");
    for (const alert of alerts) {
      lines.push(`- [${alert.kind}] ${alert.title}`);
    }
    lines.push("");
  }

  if (state?.refresh?.semantic?.status && !["fresh", "unknown"].includes(state.refresh.semantic.status)) {
    lines.push(`> Semantic freshness: ${state.refresh.semantic.status} — ${state.refresh.semantic.reason}`);
    lines.push("");
  }

  lines.push("Use `/sonar <task>` for a deeper briefing, `/sonar impact` to simulate changes.\n");
  return lines;
}

function main() {
  const t0 = Date.now();
  let raw = "";
  try {
    raw = readFileSync(0, "utf8");
  } catch {
    process.exit(0);
  }

  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    process.exit(0);
  }

  const prompt = input.prompt || input.message || "";
  const cwd = input.cwd || process.cwd();
  const sessionId = input.session_id || "unknown";
  const config = loadSonarConfig(cwd);
  const limits = {
    maxModules: config.retrieval?.max_modules || 3,
    maxFlows: config.retrieval?.max_flows || 2,
    maxFacts: config.retrieval?.max_facts || 3
  };

  if (prompt.length < MIN_PROMPT_LENGTH) {
    process.exit(0);
  }

  // Check if .sonar/ exists with pre-computed data
  const sonarDir = join(cwd, ".sonar");
  const briefIndexPath = join(sonarDir, "partials", "agent-briefs", "index.json");
  const summariesPath = join(sonarDir, "summaries.json");
  const metaPath = join(sonarDir, "meta.json");
  const state = loadSonarState(sonarDir);

  if (existsSync(briefIndexPath)) {
    try {
      const result = enhancedRetrieve(sonarDir, prompt);
      if (result.modules.length > 0 || result.flows.length > 0 || result.system_facts.length > 0) {
        trackSession(sessionId, result.modules.map(module => module.key));
        logUsage(sonarDir, {
          event: "hook.prompt",
          path: "enhanced",
          injected: true,
          modules: result.modules.map(m => m.key),
          flows: result.flows.map(f => f.name),
          latency_ms: Date.now() - t0,
        });
        process.stdout.write(JSON.stringify({
          hookSpecificOutput: {
            additionalContext: formatEnhancedContext(result, limits, state).join("\n")
          }
        }));
        return;
      }
    } catch { /* fall back to legacy summaries */ }
  }

  if (!existsSync(summariesPath)) {
    process.exit(0);
  }

  // Load pre-computed summaries (single file read, ~10ms)
  let summaries;
  try {
    summaries = JSON.parse(readFileSync(summariesPath, "utf8"));
  } catch {
    process.exit(0);
  }

  // Extract keywords from prompt
  const keywords = prompt
    .toLowerCase()
    .replace(/[^a-z0-9\s_-]/g, " ")
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOPWORDS.has(w));

  if (keywords.length === 0) {
    process.exit(0);
  }

  // Match keywords against module summaries (in-memory, <1ms)
  const scored = [];
  for (const [key, summary] of Object.entries(summaries)) {
    let score = 0;
    const searchText = `${key} ${summary.purpose} ${(summary.conventions || []).join(" ")} ${(summary.business_rules || []).join(" ")}`.toLowerCase();
    for (const kw of keywords) {
      if (searchText.includes(kw)) score++;
    }
    if (score > 0) {
      scored.push({ key, ...summary, score });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  const moduleMatches = scored.slice(0, limits.maxModules);

  // Match keywords against flow titles (read flow files only if matched)
  const flowMatches = [];
  const flowsDir = join(sonarDir, "flows");
  if (existsSync(flowsDir)) {
    try {
      const flowFiles = readdirSync(flowsDir).filter(f => f.endsWith(".json"));
      for (const flowFile of flowFiles) {
        try {
          const flow = JSON.parse(readFileSync(join(flowsDir, flowFile), "utf8"));
          const searchText = `${flow.name} ${flow.title}`.toLowerCase();
          let score = 0;
          for (const kw of keywords) {
            if (searchText.includes(kw)) score++;
          }
          if (score > 0) {
            flowMatches.push({ name: flow.name, title: flow.title, score });
          }
        } catch { /* skip */ }
      }
      flowMatches.sort((a, b) => b.score - a.score);
      flowMatches.splice(limits.maxFlows);
    } catch { /* non-fatal */ }
  }

  // If no matches, exit silently
  if (moduleMatches.length === 0 && flowMatches.length === 0) {
    process.exit(0);
  }

  // Build briefing
  const lines = ["## Sonar Context\n"];

  if (moduleMatches.length > 0) {
    lines.push("### Relevant Modules");
    for (const mod of moduleMatches) {
      lines.push(`- **${mod.key}** — ${mod.purpose}`);
      if (mod.conventions && mod.conventions.length > 0) {
        lines.push(`  - Conventions: ${mod.conventions.join("; ")}`);
      }
      if (mod.business_rules && mod.business_rules.length > 0) {
        lines.push(`  - Rules: ${mod.business_rules.join("; ")}`);
      }
    }
    lines.push("");
  }

  if (flowMatches.length > 0) {
    lines.push("### Related Flows");
    for (const flow of flowMatches) {
      lines.push(`- **${flow.name}** — ${flow.title}`);
    }
    lines.push("");
  }

  let hasStaleWarnings = false;
  if (state?.modules) {
    for (const key of moduleMatches.map(match => match.key)) {
      const moduleState = state.modules[key];
      if (!moduleState || ["fresh", "unknown"].includes(moduleState.semantic_status)) continue;
      lines.push(`> **${key}** is ${moduleState.semantic_status} (${(moduleState.reasons || []).join(", ") || "semantic refresh pending"}).`);
      hasStaleWarnings = true;
    }
  }

  if (!hasStaleWarnings && state?.refresh?.semantic?.status && !["fresh", "unknown"].includes(state.refresh.semantic.status)) {
    lines.push(`> Semantic freshness: ${state.refresh.semantic.status} — ${state.refresh.semantic.reason}`);
    hasStaleWarnings = true;
  }

  // Fallback: crude day-count check if no state/staleness info
  if (!hasStaleWarnings && existsSync(metaPath)) {
    try {
      const meta = JSON.parse(readFileSync(metaPath, "utf8"));
      const age = Date.now() - new Date(meta.updated_at).getTime();
      const days = Math.floor(age / (1000 * 60 * 60 * 24));
      if (days > 3) {
        lines.push(`> Map is ${days} days old. Run \`/sonar update\` to refresh.`);
      }
    } catch { /* non-fatal */ }
  }

  lines.push("Use `/sonar <task>` for a deeper briefing, `/sonar impact` to simulate changes.\n");

  trackSession(sessionId, moduleMatches.map(m => m.key));

  logUsage(sonarDir, {
    event: "hook.prompt",
    path: "legacy",
    injected: true,
    modules: moduleMatches.map(m => m.key),
    flows: flowMatches.map(f => f.name),
    latency_ms: Date.now() - t0,
  });

  // Output
  const output = {
    hookSpecificOutput: {
      additionalContext: lines.join("\n")
    }
  };

  process.stdout.write(JSON.stringify(output));
}

main();
