#!/usr/bin/env node

/**
 * Sonar — PreToolUse hook for Edit|Write
 * Warns about unreviewed dependents using pre-computed file-modules.json.
 * No SQLite subprocess — pure JSON file reads (~10ms total).
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync } from "fs";
import { join, relative } from "path";
import { tmpdir } from "os";
import { createHash } from "crypto";
import { getFileState, getModuleState, loadSonarState } from "../lib/state.mjs";
import { logHookError } from "../lib/hook-error-log.mjs";
import { logUsage } from "../lib/usage-log.mjs";

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

  const toolInput = input.tool_input || {};
  const filePath = toolInput.file_path || "";
  const cwd = input.cwd || process.cwd();
  const sessionId = input.session_id || "unknown";

  if (!filePath) {
    process.exit(0);
  }

  // Check if pre-computed lookup exists
  const sonarDir = join(cwd, ".sonar");
  const fileModulesPath = join(sonarDir, "file-modules.json");
  const summariesPath = join(sonarDir, "summaries.json");
  const state = loadSonarState(sonarDir);

  if (!state && !existsSync(fileModulesPath)) {
    process.exit(0);
  }

  // Get relative path
  const relPath = relative(cwd, filePath);

  // Check if we already warned about this file
  const sessionDir = join(tmpdir(), "sonar-sessions");
  const sessionHash = createHash("sha256").update(sessionId).digest("hex").slice(0, 16);
  const warnedFile = join(sessionDir, `${sessionHash}-warned.txt`);

  if (existsSync(warnedFile)) {
    const warned = readFileSync(warnedFile, "utf8");
    if (warned.includes(relPath)) {
      process.exit(0);
    }
  }

  // Load pre-computed file→module mapping (single file read, ~10ms)
  let fileModules = null;
  if (existsSync(fileModulesPath)) {
    try {
      fileModules = JSON.parse(readFileSync(fileModulesPath, "utf8"));
    } catch {
      fileModules = null;
    }
  }

  // Look up this file
  const fileInfo = getFileState(state, relPath) || fileModules?.[relPath];
  if (!fileInfo || !fileInfo.module) {
    process.exit(0);
  }

  const moduleKey = fileInfo.module;
  const dependents = fileModules?.[relPath]?.dependents || [];
  const fanIn = fileModules?.[relPath]?.fan_in || dependents.length;

  // Load brief index for additional signals (load-bearing, domain overlaps)
  const briefIndexPath = join(sonarDir, "partials", "agent-briefs", "index.json");
  let isLoadBearing = false;
  let overlapFacts = [];

  if (existsSync(briefIndexPath)) {
    try {
      const briefIndex = JSON.parse(readFileSync(briefIndexPath, "utf8"));
      const entry = (briefIndex.modules || []).find(m => m.key === moduleKey);
      if (entry) {
        isLoadBearing = entry.load_bearing || false;
        if (entry.system_fact_ids?.length > 0) {
          const briefPath = join(sonarDir, "partials", "agent-briefs", `${moduleKey}.json`);
          if (existsSync(briefPath)) {
            const brief = JSON.parse(readFileSync(briefPath, "utf8"));
            overlapFacts = (brief.system_facts || []).filter(f => f.kind === "overlap");
          }
        }
      }
    } catch (err) { logHookError(sonarDir, "on-edit:brief-index", err); }
  }

  // Exit if nothing to warn about
  if (!isLoadBearing && overlapFacts.length === 0 && dependents.length < 1) {
    process.exit(0);
  }

  // Check which modules the agent has been briefed on
  const sessionFile = join(sessionDir, `${sessionHash}.txt`);
  const briefedModules = new Set();
  if (existsSync(sessionFile)) {
    const content = readFileSync(sessionFile, "utf8");
    content.split(/[,\n]/).filter(Boolean).forEach(m => briefedModules.add(m.trim()));
  }

  // Filter to unreviewed dependents
  const unreviewed = dependents.filter(d => !briefedModules.has(d));

  if (!isLoadBearing && overlapFacts.length === 0 && unreviewed.length < 1) {
    process.exit(0);
  }

  // Load summaries for purpose lookup
  let summaries = {};
  if (existsSync(summariesPath)) {
    try {
      summaries = JSON.parse(readFileSync(summariesPath, "utf8"));
    } catch { /* non-fatal */ }
  }

  // Build warning
  const lines = [
    `## Sonar: Edit Warning\n`,
    `Editing \`${relPath}\` (module: **${moduleKey}**, fan-in: ${fanIn}).\n`
  ];

  if (isLoadBearing) {
    lines.push(`⚠ **Load-bearing module** — high fan-in. Consider running \`/sonar impact ${moduleKey}\` before editing.\n`);
  }

  for (const fact of overlapFacts) {
    lines.push(`⚠ **Domain overlap** — ${fact.title}. Check before adding new logic here.\n`);
  }

  const moduleState = getModuleState(state, moduleKey);
  if (moduleState && !["fresh", "unknown"].includes(moduleState.semantic_status)) {
    lines.push(`Module freshness: **${moduleState.semantic_status}** (${(moduleState.reasons || []).join(", ") || "semantic refresh pending"}).\n`);
  }

  if (unreviewed.length > 0) {
    lines.push(`**${unreviewed.length} dependent module${unreviewed.length > 1 ? "s" : ""} haven't been reviewed:**`);
    for (const dep of unreviewed.slice(0, 5)) {
      const purpose = summaries[dep]?.purpose ? ` — ${summaries[dep].purpose}` : "";
      lines.push(`- **${dep}**${purpose}`);
    }
    if (unreviewed.length > 5) {
      lines.push(`- ... and ${unreviewed.length - 5} more`);
    }
    lines.push("");
  }

  lines.push(`Run \`/sonar blast ${moduleKey}\` for full impact analysis.\n`);

  // Track that we warned about this file
  try {
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(warnedFile, relPath + "\n", { flag: "a" });
  } catch { /* non-fatal */ }

  logUsage(sonarDir, {
    event: "hook.edit",
    module: moduleKey,
    warned: true,
    load_bearing: isLoadBearing,
    overlap_facts: overlapFacts.length,
    unreviewed_dependents: unreviewed.length,
    latency_ms: Date.now() - t0,
  });

  const output = {
    hookSpecificOutput: {
      additionalContext: lines.join("\n")
    }
  };

  process.stdout.write(JSON.stringify(output));
}

main();
