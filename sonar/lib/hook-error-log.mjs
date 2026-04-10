/**
 * Sonar — hook error logger
 * Appends errors to .sonar/hook-errors.log for diagnosing new installs.
 * Never throws — logging must not disrupt the hook.
 */

import { appendFileSync, existsSync } from "fs";
import { join } from "path";

/**
 * @param {string} sonarDir   absolute path to .sonar/
 * @param {string} hookName   e.g. "on-edit", "on-session-start"
 * @param {unknown} err
 */
export function logHookError(sonarDir, hookName, err) {
  if (!sonarDir || !existsSync(sonarDir)) return;
  try {
    const msg = err instanceof Error
      ? `${err.message}${err.stack ? "\n" + err.stack.split("\n").slice(1, 3).join("\n") : ""}`
      : String(err);
    const line = `[${new Date().toISOString()}] [${hookName}] ${msg}\n`;
    appendFileSync(join(sonarDir, "hook-errors.log"), line);
  } catch { /* must never throw */ }
}
