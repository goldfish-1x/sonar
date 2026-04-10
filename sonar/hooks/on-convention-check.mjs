#!/usr/bin/env node

/**
 * Sonar — PostToolUse hook for Edit|Write
 * Runs convention check commands after a file edit and warns if any fail.
 * Only checks conventions that have a `check` field (executable grep/diff cmd).
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync } from "fs";
import { join, relative } from "path";
import { tmpdir } from "os";
import { createHash } from "crypto";
import { execSync } from "child_process";
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

  if (!filePath) process.exit(0);

  const sonarDir = join(cwd, ".sonar");
  const fileModulesPath = join(sonarDir, "file-modules.json");
  if (!existsSync(fileModulesPath)) process.exit(0);

  const relPath = relative(cwd, filePath);

  // Load file→module mapping
  let fileModules;
  try {
    fileModules = JSON.parse(readFileSync(fileModulesPath, "utf8"));
  } catch {
    process.exit(0);
  }

  const moduleKey = fileModules[relPath]?.module;
  if (!moduleKey) process.exit(0);

  // Load the module brief
  const briefPath = join(sonarDir, "partials", "agent-briefs", `${moduleKey}.json`);
  if (!existsSync(briefPath)) process.exit(0);

  let brief;
  try {
    brief = JSON.parse(readFileSync(briefPath, "utf8"));
  } catch {
    process.exit(0);
  }

  // Only check conventions that have a check command
  const checkableConventions = (brief.conventions || []).filter(
    c => typeof c === "object" && c.check
  );
  if (checkableConventions.length === 0) process.exit(0);

  // Session dedup — skip conventions already warned for this file
  const sessionDir = join(tmpdir(), "sonar-sessions");
  const sessionHash = createHash("sha256").update(sessionId).digest("hex").slice(0, 16);
  const convWarnedFile = join(sessionDir, `${sessionHash}-conv-warned.txt`);

  const alreadyWarned = new Set();
  if (existsSync(convWarnedFile)) {
    readFileSync(convWarnedFile, "utf8")
      .split("\n")
      .filter(Boolean)
      .forEach(line => alreadyWarned.add(line.trim()));
  }

  const violations = [];

  for (const convention of checkableConventions) {
    const dedupKey = `${relPath}|${convention.rule}`;
    if (alreadyWarned.has(dedupKey)) continue;

    let checkOutput = "";
    try {
      checkOutput = execSync(convention.check, {
        cwd,
        timeout: 3000,
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"]
      });
    } catch (err) {
      // Non-zero exit (grep found nothing = exit 1, or cmd failed)
      checkOutput = err.stdout || "";
      if (!checkOutput) {
        // If stderr has content it's a real failure (bad cmd, missing tool), log it
        if (err.stderr?.trim()) logHookError(join(cwd, ".sonar"), "on-convention-check", err);
        continue;
      }
    }

    if (!checkOutput.trim()) continue; // no output = no violation

    // Filter output lines to those mentioning the edited file
    const outputLines = checkOutput.trim().split("\n");
    const relevantLines = outputLines.filter(line => line.includes(relPath));
    if (relevantLines.length === 0) continue; // violation exists but not in this file

    violations.push({
      rule: convention.rule,
      check: convention.check,
      found: relevantLines.slice(0, 3).join("\n    ")
    });

    // Mark as warned so we don't repeat on every subsequent edit
    try {
      mkdirSync(sessionDir, { recursive: true });
      writeFileSync(convWarnedFile, dedupKey + "\n", { flag: "a" });
    } catch { /* non-fatal */ }
  }

  if (violations.length === 0) process.exit(0);

  const lines = [
    `## Sonar: Convention Check Failed\n`,
    `Editing \`${relPath}\` (module: **${moduleKey}**)\n`,
    `**${violations.length} convention violation${violations.length > 1 ? "s" : ""} detected:**\n`
  ];

  for (const v of violations) {
    lines.push(`- ❌ ${v.rule}`);
    lines.push(`  Check: \`${v.check}\``);
    lines.push(`  Found:\n    ${v.found}\n`);
  }

  lines.push("Fix before pushing. Run `/sonar verify` for a full convention audit.\n");

  logUsage(join(cwd, ".sonar"), {
    event: "hook.convention_check",
    module: moduleKey,
    conventions_checked: checkableConventions.length,
    violations: violations.length,
    latency_ms: Date.now() - t0,
  });

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      additionalContext: lines.join("\n")
    }
  }));
}

main();
