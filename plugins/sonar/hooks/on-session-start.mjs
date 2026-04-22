#!/usr/bin/env node

/**
 * Sonar — SessionStart hook
 * 1. Auto-migrates .sonar/ to the latest format when the plugin updates.
 * 2. Auto-rebuilds skeleton + derived files when git HEAD moves (living map).
 */

import { readFileSync, writeFileSync, existsSync, unlinkSync } from "fs";
import { join, dirname } from "path";
import { execSync } from "child_process";
import { fileURLToPath } from "url";
import { logHookError } from "../lib/hook-error-log.mjs";
import { logUsage } from "../lib/usage-log.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(__dirname, "..");

// --- Current expected version ---
const CURRENT_MAP_VERSION = 5;

// --- Expected .gitignore content ---
const EXPECTED_GITIGNORE = `graph.db
summaries.json
file-modules.json
symbol-imports.json
state.json
partials/
hook-errors.log
usage.jsonl
`;

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

  const cwd = input.cwd || process.cwd();
  const sonarDir = join(cwd, ".sonar");
  const metaPath = join(sonarDir, "meta.json");

  // No map — nothing to do
  if (!existsSync(metaPath)) {
    process.exit(0);
  }

  let meta;
  try {
    meta = JSON.parse(readFileSync(metaPath, "utf8"));
  } catch {
    process.exit(0);
  }

  const mapVersion = meta.version || 1;
  const messages = [];
  let derivedFilesDeleted = false;

  // ══════════════════════════════════════
  // PART 1: VERSION MIGRATIONS
  // ══════════════════════════════════════

  if (mapVersion < CURRENT_MAP_VERSION) {
    const migrations = [];

    // --- Migration: v1 → v2 ---
    if (mapVersion < 2) {
      const gitignorePath = join(sonarDir, ".gitignore");
      try {
        const current = existsSync(gitignorePath) ? readFileSync(gitignorePath, "utf8") : "";
        if (!current.includes("summaries.json") || !current.includes("file-modules.json")) {
          writeFileSync(gitignorePath, EXPECTED_GITIGNORE);
          migrations.push("Updated .gitignore");
        }
      } catch { /* non-fatal */ }

      const dbPath = join(sonarDir, "graph.db");
      if (existsSync(dbPath)) {
        try { unlinkSync(dbPath); } catch { /* non-fatal */ }
      }
    }

    // --- Migration: v2 → v3 (Ripple Guard) ---
    if (mapVersion < 3) {
      const gitignorePath = join(sonarDir, ".gitignore");
      try {
        const current = existsSync(gitignorePath) ? readFileSync(gitignorePath, "utf8") : "";
        if (!current.includes("symbol-imports.json")) {
          writeFileSync(gitignorePath, EXPECTED_GITIGNORE);
          migrations.push("Added symbol-imports.json to .gitignore");
        }
      } catch { /* non-fatal */ }
    }

    // --- Migration: v3 → v4 (Living Map) ---
    if (mapVersion < 4) {
      const gitignorePath = join(sonarDir, ".gitignore");
      try {
        const current = existsSync(gitignorePath) ? readFileSync(gitignorePath, "utf8") : "";
        if (!current.includes("state.json")) {
          writeFileSync(gitignorePath, EXPECTED_GITIGNORE);
          migrations.push("Updated .gitignore for state-based freshness");
        }
      } catch { /* non-fatal */ }

      // Delete derived files so they rebuild with the new living-map system
      for (const f of ["graph.db", "summaries.json", "file-modules.json", "symbol-imports.json"]) {
        const p = join(sonarDir, f);
        if (existsSync(p)) {
          try {
            unlinkSync(p);
            derivedFilesDeleted = true;
          } catch {}
        }
      }
      migrations.push("Cleared derived files (will rebuild)");
    }

    // --- Migration: v4 → v5 (remove stale manifest artifact) ---
    if (mapVersion < 5) {
      const stalePath = join(sonarDir, "stale-modules.json");
      if (existsSync(stalePath)) {
        try {
          unlinkSync(stalePath);
          migrations.push("Removed stale-modules.json artifact");
        } catch { /* non-fatal */ }
      }
    }

    meta.version = CURRENT_MAP_VERSION;
    if (derivedFilesDeleted) {
      meta.git_sha = "";
    }
    try { writeFileSync(metaPath, JSON.stringify(meta, null, 2)); } catch {}

    if (migrations.length > 0) {
      messages.push(`Migrated .sonar/ v${mapVersion} → v${CURRENT_MAP_VERSION}: ${migrations.join("; ")}`);
    }
  }

  const gitignorePath = join(sonarDir, ".gitignore");
  try {
    const current = existsSync(gitignorePath) ? readFileSync(gitignorePath, "utf8") : "";
    if (current !== EXPECTED_GITIGNORE) {
      writeFileSync(gitignorePath, EXPECTED_GITIGNORE);
    }
  } catch { /* non-fatal */ }

  // ══════════════════════════════════════
  // PART 2: SKELETON AUTO-REFRESH
  // ══════════════════════════════════════

  let currentSha = "";
  try {
    currentSha = execSync("git rev-parse HEAD 2>/dev/null", { cwd, encoding: "utf8" }).trim();
  } catch {
    // Not a git repo or git not available — skip refresh
  }

  const mapSha = meta.git_sha || "";

  if (currentSha && currentSha !== mapSha) {
    try {
      // Rebuild skeleton (1-2s)
      execSync(`bash "${PLUGIN_ROOT}/scripts/build-skeleton.sh" . .sonar`, {
        cwd, encoding: "utf8", timeout: 3000, stdio: "pipe"
      });

      // Build state.json (<0.5s)
      execSync(`node "${PLUGIN_ROOT}/scripts/build-state.mjs" .sonar`, {
        cwd, encoding: "utf8", timeout: 2000, stdio: "pipe"
      });

      // Rebuild derived files (1-2s) — needs better-sqlite3
      execSync(`node "${PLUGIN_ROOT}/scripts/build-db.mjs" .sonar`, {
        cwd, encoding: "utf8", timeout: 3000, stdio: "pipe",
        env: { ...process.env, NODE_PATH: join(PLUGIN_ROOT, "node_modules") }
      });

      // Update meta.json with new SHA
      meta.git_sha = currentSha;
      meta.skeleton_updated_at = new Date().toISOString();
      try { writeFileSync(metaPath, JSON.stringify(meta, null, 2)); } catch {}

      // Read staleness summary
      let staleCount = 0;
      const statePath = join(sonarDir, "state.json");
      if (existsSync(statePath)) {
        try {
          const state = JSON.parse(readFileSync(statePath, "utf8"));
          staleCount = (state.queue?.modules || []).length + (state.queue?.flows || []).length + (state.queue?.system ? 1 : 0);
        } catch {}
      }

      if (staleCount > 0) {
        messages.push(`Skeleton refreshed, ${staleCount} queued refresh item(s)`);
      }
    } catch (err) {
      // Skeleton rebuild failed — non-fatal, hooks use whatever data exists
      // Don't update git_sha so we retry next session
      logHookError(sonarDir, "on-session-start", err);
    }
  }

  // ══════════════════════════════════════
  // OUTPUT
  // ══════════════════════════════════════

  logUsage(sonarDir, {
    event: "hook.session_start",
    skeleton_rebuilt: currentSha !== "" && currentSha !== mapSha,
    migrated: mapVersion < CURRENT_MAP_VERSION,
    messages: messages.length,
    latency_ms: Date.now() - t0,
  });

  if (messages.length > 0) {
    const output = {
      hookSpecificOutput: {
        additionalContext: `**Sonar:** ${messages.join(". ")}.\n`
      }
    };
    process.stdout.write(JSON.stringify(output));
  }
}

main();
