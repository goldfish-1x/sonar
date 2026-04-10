#!/usr/bin/env node

/**
 * Sonar Ripple Guard — PreToolUse hook for Edit|Write
 *
 * Detects breaking changes to exported symbols, tracks which files import
 * those symbols, and monitors the agent's progress resolving them.
 *
 * Outputs:
 *   - FIRST DETECTION: when a breaking change is detected with importers
 *   - PROGRESS: X/Y resolved, remaining files listed
 *   - ALL CLEAR: all targets resolved
 *   - PENDING IN FILE: reminder when editing a target file
 *   - Silent exit(0) for non-breaking or unrelated edits
 */

import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, relative } from "path";
import { tmpdir } from "os";
import { createHash } from "crypto";
import { languageFromPath } from "../scripts/source-config.mjs";
import { logUsage } from "../lib/usage-log.mjs";

const PENDING = "pending";
const RESOLVED = "resolved";

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
  let oldString = toolInput.old_string || "";
  let newString = toolInput.new_string || toolInput.content || "";
  const cwd = input.cwd || process.cwd();
  const sessionId = input.session_id || "unknown";

  if (!filePath) process.exit(0);

  const sonarDir = join(cwd, ".sonar");
  const symbolImportsPath = join(sonarDir, "symbol-imports.json");
  const relPath = relative(cwd, filePath);
  const sessionHash = createHash("sha256").update(sessionId).digest("hex").slice(0, 16);
  const sessionDir = join(tmpdir(), "sonar-sessions");
  const ripplePath = join(sessionDir, `${sessionHash}-ripple.json`);

  // Load ripple session (or create empty)
  let session = { changes: [], detectedChanges: [] };
  try {
    session = JSON.parse(readFileSync(ripplePath, "utf8"));
  } catch { /* start fresh — file missing or malformed */ }

  // Load symbol-imports index — only the entry for the edited file
  let symbolImports = null;
  try {
    const allImports = JSON.parse(readFileSync(symbolImportsPath, "utf8"));
    if (allImports[relPath]) {
      symbolImports = { [relPath]: allImports[relPath] };
    }
  } catch { /* null = unavailable */ }

  // If no index for this file AND no existing session, nothing to do
  if (!symbolImports && session.changes.length === 0) {
    process.exit(0);
  }

  // Write tool has no old_string — read the current file only when needed for detection
  if (!oldString && newString && filePath && symbolImports) {
    try {
      oldString = readFileSync(filePath, "utf8");
    } catch { /* non-fatal, detection will just skip */ }
  }

  const outputParts = [];
  let newDetections = [];
  let resolutionEvents = [];

  // ── STEP 1: TARGET RESOLUTION ──
  // If we're editing a file that is a pending target, mark it resolved
  // (only if the edit content mentions the target symbol as a whole word)
  // Best-effort only: PreToolUse sees the edited snippet, not the whole file, so
  // a single matching edit may not cover every call site. We still treat it as
  // resolved for progress tracking because the agent was directed to this file
  // and touched the symbol here; /sonar verify is the real correctness check.
  for (const change of session.changes) {
    const targetStatus = change.targets[relPath];
    if (targetStatus === PENDING) {
      const sym = change.symbol;
      const symRe = new RegExp("\\b" + sym.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b");
      if (symRe.test(oldString) || symRe.test(newString)) {
        change.targets[relPath] = RESOLVED;
        resolutionEvents.push({ symbol: sym, file: relPath });
      }
    }
  }

  // ── STEP 2: BREAKING CHANGE DETECTION ──
  // Only if we have the index and this file has exported symbols with importers
  if (symbolImports && symbolImports[relPath] && oldString && newString) {
    const exportedSymbols = Object.keys(symbolImports[relPath]);
    const lang = detectLanguage(relPath);
    const breaking = detectBreakingChanges(oldString, newString, exportedSymbols, lang);

    for (const change of breaking) {
      const changeKey = `${change.symbol}@${relPath}`;
      if (session.detectedChanges.includes(changeKey)) continue;

      // Build targets from symbol-imports index
      const importers = symbolImports[relPath][change.symbol] || [];
      if (importers.length === 0) continue;

      const targets = {};
      for (const imp of importers) {
        targets[imp.file] = PENDING;
      }

      session.changes.push({
        sourceFile: relPath,
        symbol: change.symbol,
        type: change.type,
        detail: change.detail,
        targets
      });
      session.detectedChanges.push(changeKey);
      newDetections.push({
        symbol: change.symbol,
        type: change.type,
        detail: change.detail,
        importers
      });
    }
  }

  // ── STEP 3: COMPUTE TOTALS ──
  let totalTargets = 0;
  let totalResolved = 0;
  let totalPending = 0;

  for (const change of session.changes) {
    for (const status of Object.values(change.targets)) {
      totalTargets++;
      if (status === RESOLVED) totalResolved++;
      else totalPending++;
    }
  }

  // ── STEP 4: BUILD OUTPUT ──

  if (newDetections.length > 0) {
    // FIRST DETECTION format
    if (newDetections.length === 1) {
      const d = newDetections[0];
      const lines = [
        `## Ripple Guard: Breaking Change\n`,
        `\`${d.symbol}\` ${formatChangeType(d.type)} in \`${relPath}\``,
        d.detail ? d.detail : "",
        "",
        `**${d.importers.length} file${d.importers.length === 1 ? "" : "s"} import${d.importers.length === 1 ? "s" : ""} this and need${d.importers.length === 1 ? "s" : ""} updating:**\n`
      ];
      for (const imp of d.importers.slice(0, 10)) {
        lines.push(`  ${imp.file} :${imp.line} (${imp.module})`);
      }
      if (d.importers.length > 10) {
        lines.push(`  ... and ${d.importers.length - 10} more`);
      }
      outputParts.push(lines.filter(Boolean).join("\n"));
    } else {
      // Multiple breaking changes
      const lines = [`## Ripple Guard: ${newDetections.length} Breaking Changes\n`];
      for (let i = 0; i < newDetections.length; i++) {
        const d = newDetections[i];
        lines.push(`**${i + 1}. \`${d.symbol}\` ${formatChangeType(d.type)}** in \`${relPath}\``);
        if (d.detail) lines.push(d.detail);
        lines.push("");
        lines.push(`${d.importers.length} file${d.importers.length === 1 ? "" : "s"} need${d.importers.length === 1 ? "s" : ""} updating:`);
        for (const imp of d.importers.slice(0, 5)) {
          lines.push(`  ${imp.file} :${imp.line} (${imp.module})`);
        }
        if (d.importers.length > 5) {
          lines.push(`  ... and ${d.importers.length - 5} more`);
        }
        lines.push("");
      }
      outputParts.push(lines.join("\n"));
    }
  } else if (resolutionEvents.length > 0 && totalPending > 0) {
    // PROGRESS format
    const remaining = collectRemainingByFile(session.changes);
    const lines = [
      `## Ripple Guard: ${totalResolved}/${totalTargets}\n`,
      "Remaining:"
    ];
    for (const [file, symbols] of remaining.slice(0, 10)) {
      lines.push(`  ${file} — ${symbols.join(", ")}`);
    }
    if (remaining.length > 10) {
      lines.push(`  ... and ${remaining.length - 10} more files`);
    }
    outputParts.push(lines.join("\n"));
  } else if (resolutionEvents.length > 0 && totalPending === 0 && totalTargets > 0) {
    // ALL CLEAR format
    outputParts.push(`## Ripple Guard: All Clear (${totalTargets}/${totalTargets})`);
  } else if (totalPending > 0 && newDetections.length === 0 && resolutionEvents.length === 0) {
    // PENDING IN FILE format — check if this file has pending targets we didn't resolve
    const pendingForFile = [];
    for (const change of session.changes) {
      if (change.targets[relPath] === PENDING) {
        pendingForFile.push({
          symbol: change.symbol,
          type: change.type,
          sourceFile: change.sourceFile
        });
      }
    }
    if (pendingForFile.length > 0) {
      const lines = [
        `## Ripple Guard: ${pendingForFile.length} pending in this file\n`
      ];
      for (const p of pendingForFile) {
        lines.push(`  ${p.symbol} — ${formatChangeType(p.type)} (from ${p.sourceFile})`);
      }
      outputParts.push(lines.join("\n"));
    }
  }

  // ── STEP 5: SAVE SESSION ──
  try {
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(ripplePath, JSON.stringify(session));
  } catch { /* non-fatal */ }

  // ── STEP 6: OUTPUT ──
  if (outputParts.length === 0) {
    process.exit(0);
  }

  logUsage(join(cwd, ".sonar"), {
    event: "hook.ripple",
    breaking_changes: session.changes?.length ?? 0,
    total_targets: totalTargets,
    resolved: totalResolved,
    pending: totalPending,
    latency_ms: Date.now() - t0,
  });

  const output = {
    hookSpecificOutput: {
      additionalContext: outputParts.join("\n\n") + "\n"
    }
  };
  process.stdout.write(JSON.stringify(output));
}

// --- Detection helpers ---

function detectLanguage(filePath) {
  return languageFromPath(filePath);
}

function extractExportedSignatures(text, exportedSymbols, lang) {
  const sigs = {};

  if (lang === "typescript" || lang === "javascript") {
    const TS_EXPORT_FN = /export\s+(?:default\s+)?(?:async\s+)?function\s+(\w+)\s*(?:<[^>]*>)?\s*\(([^)]*)\)/g;
    const TS_EXPORT_CONST_FN = /export\s+const\s+(\w+)\s*(?:<[^>]*>)?\s*=\s*(?:async\s+)?\(?([^)=]*)\)?\s*(?:=>|:)/g;
    const TS_EXPORT_CLASS = /export\s+(?:default\s+)?class\s+(\w+)/g;
    const TS_EXPORT_TYPE = /export\s+(?:type|interface)\s+(\w+)/g;
    const TS_EXPORT_CONST = /export\s+const\s+(\w+)\s*[=:]/g;

    // Exported functions
    for (const match of text.matchAll(TS_EXPORT_FN)) {
      if (exportedSymbols.includes(match[1])) {
        sigs[match[1]] = { kind: "function", params: parseParams(match[2], lang) };
      }
    }
    // Exported arrow functions
    for (const match of text.matchAll(TS_EXPORT_CONST_FN)) {
      if (exportedSymbols.includes(match[1]) && !sigs[match[1]]) {
        sigs[match[1]] = { kind: "function", params: parseParams(match[2], lang) };
      }
    }
    // Exported classes
    for (const match of text.matchAll(TS_EXPORT_CLASS)) {
      if (exportedSymbols.includes(match[1])) {
        sigs[match[1]] = { kind: "class", params: [] };
      }
    }
    // Exported types/interfaces
    for (const match of text.matchAll(TS_EXPORT_TYPE)) {
      if (exportedSymbols.includes(match[1])) {
        sigs[match[1]] = { kind: "type", params: [] };
      }
    }
    // Exported const (non-function)
    for (const match of text.matchAll(TS_EXPORT_CONST)) {
      if (exportedSymbols.includes(match[1]) && !sigs[match[1]]) {
        sigs[match[1]] = { kind: "const", params: [] };
      }
    }
  } else if (lang === "python") {
    const PY_DEF = /^(async\s+)?def\s+(\w+)\s*\(([^)]*)\)/gm;
    const PY_CLASS = /^class\s+(\w+)/gm;

    // Top-level function defs (implicitly exported)
    for (const match of text.matchAll(PY_DEF)) {
      if (exportedSymbols.includes(match[2])) {
        sigs[match[2]] = { kind: "function", params: parseParams(match[3], lang) };
      }
    }
    // Classes
    for (const match of text.matchAll(PY_CLASS)) {
      if (exportedSymbols.includes(match[1])) {
        sigs[match[1]] = { kind: "class", params: [] };
      }
    }
  }

  return sigs;
}

function parseParams(paramString, lang) {
  if (!paramString || !paramString.trim()) return [];
  return paramString.split(",").map(p => {
    const trimmed = p.trim();
    if (!trimmed) return null;

    // Extract name (strip type annotations, defaults)
    let name, hasDefault;
    if (lang === "python") {
      // Python: name: Type = default OR name = default OR name: Type OR name
      // Also skip *args, **kwargs, self, cls
      if (trimmed.startsWith("*") || trimmed === "self" || trimmed === "cls") return null;
      name = trimmed.split(/[=:]/)[0].trim();
      hasDefault = trimmed.includes("=");
    } else {
      // TS/JS: name?: Type OR name: Type = default OR name = default
      name = trimmed.split(/[?=:]/)[0].trim();
      hasDefault = trimmed.includes("?") || trimmed.includes("=");
      // Handle destructured params
      if (name.startsWith("{") || name.startsWith("[")) {
        name = trimmed.split(/[=:]/)[0].trim();
        hasDefault = trimmed.includes("=");
      }
    }

    return name ? { name, optional: hasDefault } : null;
  }).filter(Boolean);
}

function detectBreakingChanges(oldText, newText, exportedSymbols, lang) {
  const oldSigs = extractExportedSignatures(oldText, exportedSymbols, lang);
  const newSigs = extractExportedSignatures(newText, exportedSymbols, lang);
  const changes = [];

  for (const sym of exportedSymbols) {
    const oldSig = oldSigs[sym];
    const newSig = newSigs[sym];

    // Symbol was in old text but not in new → removed or renamed
    if (oldSig && !newSig) {
      // Only report "renamed" when exactly 1 removal + 1 addition of the same kind
      // Otherwise it's ambiguous and we report "removed"
      const oldNames = Object.keys(oldSigs);
      const newNames = Object.keys(newSigs);
      const removedOfKind = oldNames.filter(n => !newNames.includes(n) && oldSigs[n]?.kind === oldSig.kind);
      const addedOfKind = newNames.filter(n => !oldNames.includes(n) && newSigs[n]?.kind === oldSig.kind);

      if (removedOfKind.length === 1 && addedOfKind.length === 1) {
        changes.push({
          symbol: sym,
          type: "renamed",
          detail: `Renamed to \`${addedOfKind[0]}\``
        });
      } else {
        changes.push({
          symbol: sym,
          type: "removed",
          detail: `${oldSig.kind} export removed`
        });
      }
      continue;
    }

    // Both exist — check for signature changes (functions only)
    if (oldSig && newSig && oldSig.kind === "function" && newSig.kind === "function") {
      const oldParams = oldSig.params;
      const newParams = newSig.params;

      // Check for removed params
      const oldNames = oldParams.map(p => p.name);
      const newNames = newParams.map(p => p.name);
      const removed = oldNames.filter(n => !newNames.includes(n));
      const added = newParams.filter(p => !oldNames.includes(p.name));
      const addedRequired = added.filter(p => !p.optional);

      if (removed.length > 0) {
        changes.push({
          symbol: sym,
          type: "signature_changed",
          detail: `Removed param${removed.length > 1 ? "s" : ""} \`${removed.join("`, `")}\``
        });
      } else if (addedRequired.length > 0) {
        changes.push({
          symbol: sym,
          type: "signature_changed",
          detail: `Added required param${addedRequired.length > 1 ? "s" : ""} \`${addedRequired.map(p => p.name).join("`, `")}\``
        });
      }
    }
  }

  return changes;
}

function formatChangeType(type) {
  switch (type) {
    case "signature_changed": return "signature changed";
    case "removed": return "removed";
    case "renamed": return "renamed";
    default: return "changed";
  }
}

function collectRemainingByFile(changes) {
  const byFile = {};
  for (const change of changes) {
    for (const [file, status] of Object.entries(change.targets)) {
      if (status !== PENDING) continue;
      if (!byFile[file]) byFile[file] = [];
      byFile[file].push(change.symbol);
    }
  }
  return Object.entries(byFile).sort((a, b) => a[0].localeCompare(b[0]));
}

main();
