/**
 * Sonar — local usage telemetry
 * Appends one JSON line per event to .sonar/usage.jsonl.
 * Gitignored. Never throws. Never transmits data anywhere.
 *
 * Usage:
 *   import { logUsage } from "../lib/usage-log.mjs";
 *   const t = Date.now();
 *   // ... do work ...
 *   logUsage(sonarDir, { event: "hook.edit", module: "auth", warned: true, latency_ms: Date.now() - t });
 */

import { appendFileSync, existsSync } from "fs";
import { join } from "path";

/**
 * @param {string} sonarDir   absolute path to .sonar/
 * @param {Record<string, unknown>} fields  event fields (must include `event`)
 */
export function logUsage(sonarDir, fields) {
  if (!sonarDir || !existsSync(sonarDir)) return;
  try {
    const entry = JSON.stringify({ ts: new Date().toISOString(), ...fields });
    appendFileSync(join(sonarDir, "usage.jsonl"), entry + "\n");
  } catch { /* must never throw */ }
}
