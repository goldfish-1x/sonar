#!/usr/bin/env node

/**
 * Sonar Ripple Guard — Stop hook (final safety net)
 *
 * When the agent is about to stop, check for any unresolved ripple targets
 * and warn if breaking changes haven't been fully propagated.
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createHash } from "crypto";
import { loadSonarState } from "../lib/state.mjs";

function main() {
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

  const cwd = input.cwd || process.cwd();
  const sessionId = input.session_id || "unknown";
  const state = loadSonarState(join(cwd, ".sonar"));

  const sessionHash = createHash("sha256").update(sessionId).digest("hex").slice(0, 16);
  const ripplePath = join(tmpdir(), "sonar-sessions", `${sessionHash}-ripple.json`);

  if (!existsSync(ripplePath)) {
    process.exit(0);
  }

  let session;
  try {
    session = JSON.parse(readFileSync(ripplePath, "utf8"));
  } catch {
    process.exit(0);
  }

  if (!session.changes || session.changes.length === 0) {
    process.exit(0);
  }

  // Collect all pending targets grouped by change
  const unresolvedChanges = [];
  for (const change of session.changes) {
    const pending = [];
    for (const [file, status] of Object.entries(change.targets)) {
      if (status === "pending") pending.push(file);
    }
    if (pending.length > 0) {
      unresolvedChanges.push({ ...change, pendingFiles: pending });
    }
  }

  if (unresolvedChanges.length === 0) {
    process.exit(0);
  }

  // Build output
  const totalPending = unresolvedChanges.reduce((sum, c) => sum + c.pendingFiles.length, 0);
  const lines = [`## Ripple Guard: ${totalPending} Unresolved\n`];

  for (const change of unresolvedChanges) {
    lines.push(`**\`${change.symbol}\` ${formatChangeType(change.type)}** (${change.sourceFile}) — ${change.pendingFiles.length} remaining:`);
    for (const file of change.pendingFiles.slice(0, 10)) {
      lines.push(`  ${file}`);
    }
    if (change.pendingFiles.length > 10) {
      lines.push(`  ... and ${change.pendingFiles.length - 10} more`);
    }
    lines.push("");
  }

  if (state?.refresh?.semantic?.status && !["fresh", "unknown"].includes(state.refresh.semantic.status)) {
    lines.push(`> Semantic freshness: ${state.refresh.semantic.status}. ${state.refresh.semantic.reason}`);
  } else {
    const metaPath = join(cwd, ".sonar", "meta.json");
    if (existsSync(metaPath)) {
      try {
        const meta = JSON.parse(readFileSync(metaPath, "utf8"));
        const age = Date.now() - new Date(meta.updated_at).getTime();
        const days = Math.floor(age / (1000 * 60 * 60 * 24));
        if (days > 3) {
          lines.push(`> Note: .sonar/ map is ${days} days old. Some import relationships may have changed.`);
        }
      } catch { /* non-fatal */ }
    }
  }

  const output = {
    hookSpecificOutput: {
      additionalContext: lines.join("\n") + "\n"
    }
  };
  process.stdout.write(JSON.stringify(output));
}

function formatChangeType(type) {
  switch (type) {
    case "signature_changed": return "signature changed";
    case "removed": return "removed";
    case "renamed": return "renamed";
    default: return "changed";
  }
}

main();
