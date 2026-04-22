#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(__dirname, "..");

const failures = [];

function fail(message) {
  failures.push(message);
}

function readJson(pathValue) {
  if (!existsSync(pathValue)) {
    fail(`Missing ${pathValue}`);
    return null;
  }

  try {
    return JSON.parse(readFileSync(pathValue, "utf8"));
  } catch (err) {
    fail(`Invalid JSON in ${pathValue}: ${err.message}`);
    return null;
  }
}

function assertString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    fail(`Missing non-empty ${label}`);
  }
}

function parseFrontmatter(text, pathValue) {
  if (!text.startsWith("---\n")) {
    fail(`${pathValue} must start with YAML frontmatter`);
    return {};
  }

  const end = text.indexOf("\n---", 4);
  if (end === -1) {
    fail(`${pathValue} must close YAML frontmatter`);
    return {};
  }

  const fields = {};
  for (const line of text.slice(4, end).trim().split("\n")) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) continue;
    const field = match[1];
    const value = match[2].trim();
    const quoted = /^(['"]).*\1$/.test(value);
    if (!quoted && value.includes(": ")) {
      fail(`${pathValue} frontmatter ${field} contains an unquoted colon; quote the value for Codex YAML parsing`);
    }
    fields[field] = quoted ? value.slice(1, -1) : value;
  }
  return fields;
}

function readTomlStringField(text, field, pathValue) {
  const inlineMatch = text.match(new RegExp(`^${field}\\s*=\\s*"([^"\\n]*)"`, "m"));
  if (inlineMatch) return inlineMatch[1];

  const multilineMatch = text.match(new RegExp(`^${field}\\s*=\\s*"""([\\s\\S]*?)"""`, "m"));
  if (multilineMatch) return multilineMatch[1].trim();

  fail(`${pathValue} must define ${field}`);
  return null;
}

function validateManifest() {
  const manifestPath = join(PLUGIN_ROOT, ".codex-plugin", "plugin.json");
  const manifest = readJson(manifestPath);
  if (!manifest) return null;

  if (manifest.name !== "sonar") {
    fail(`${manifestPath} name must be sonar`);
  }
  assertString(manifest.version, "manifest.version");
  assertString(manifest.skills, "manifest.skills");

  const skillsRoot = resolve(PLUGIN_ROOT, manifest.skills);
  if (!existsSync(skillsRoot)) {
    fail(`Manifest skills path does not exist: ${manifest.skills}`);
  }
  return manifest;
}

function validateSkills(manifest) {
  if (!manifest?.skills) return;

  const skillsRoot = resolve(PLUGIN_ROOT, manifest.skills);
  if (!existsSync(skillsRoot)) return;

  const skillDirs = readdirSync(skillsRoot)
    .filter(name => statSync(join(skillsRoot, name)).isDirectory())
    .sort();

  if (skillDirs.length === 0) {
    fail(`${skillsRoot} must include at least one skill directory`);
    return;
  }

  for (const skillName of skillDirs) {
    const skillPath = join(skillsRoot, skillName, "SKILL.md");
    if (!existsSync(skillPath)) {
      fail(`${join(skillsRoot, skillName)} must contain SKILL.md`);
      continue;
    }

    const fields = parseFrontmatter(readFileSync(skillPath, "utf8"), skillPath);
    if (!fields.name) fail(`${skillPath} frontmatter must include name`);
    if (!fields.description) fail(`${skillPath} frontmatter must include description`);
  }
}

function validateCodexAgentTemplates() {
  const templatesRoot = join(PLUGIN_ROOT, "codex-agents");
  if (!existsSync(templatesRoot)) {
    fail(`Missing ${templatesRoot}`);
    return;
  }

  const templates = readdirSync(templatesRoot)
    .filter(name => name.endsWith(".toml"))
    .sort();

  if (templates.length === 0) {
    fail(`${templatesRoot} must include at least one .toml template`);
    return;
  }

  for (const templateName of templates) {
    const templatePath = join(templatesRoot, templateName);
    const text = readFileSync(templatePath, "utf8");
    readTomlStringField(text, "name", templatePath);
    readTomlStringField(text, "description", templatePath);
    readTomlStringField(text, "developer_instructions", templatePath);
  }
}

function validateRuntimeScripts() {
  for (const scriptPath of [
    join(PLUGIN_ROOT, "scripts", "check-codex-update.mjs"),
    join(PLUGIN_ROOT, "scripts", "install-codex-agents.mjs"),
    join(PLUGIN_ROOT, "scripts", "retrieve-context.mjs")
  ]) {
    if (!existsSync(scriptPath)) {
      fail(`Missing runtime script ${scriptPath}`);
    }
  }
}

function main() {
  const manifest = validateManifest();
  validateSkills(manifest);
  validateCodexAgentTemplates();
  validateRuntimeScripts();

  if (failures.length > 0) {
    for (const message of failures) {
      console.error(`FAIL ${message}`);
    }
    process.exit(1);
  }

  console.log("Published Sonar Codex plugin package verification passed.");
}

main();
