#!/usr/bin/env node

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "fs";
import { basename, dirname, join, relative, resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(__dirname, "..");
const TEMPLATE_DIR = join(PLUGIN_ROOT, "codex-agents");

let projectRoot = process.cwd();
let force = false;
let dryRun = false;

function usage() {
  console.log(`Usage: node scripts/install-codex-agents.mjs [--project-root <path>] [--force] [--dry-run]

Copies bundled Sonar Codex custom-agent templates into <project-root>/.codex/agents.

Options:
  --project-root <path>  Project that should receive .codex/agents templates. Defaults to cwd.
  --force                Overwrite existing agent files when contents differ.
  --dry-run              Print planned changes without writing files.
  --help                 Show this help text.
`);
}

function parseArgs(argv) {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--project-root") {
      const value = argv[index + 1];
      if (!value) throw new Error("--project-root requires a path");
      projectRoot = resolve(value);
      index += 1;
    } else if (arg === "--force") {
      force = true;
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
}

function validateTemplate(pathValue) {
  const text = readFileSync(pathValue, "utf8");
  for (const field of ["name", "description", "developer_instructions"]) {
    const pattern = new RegExp(`^${field}\\s*=`, "m");
    if (!pattern.test(text)) {
      throw new Error(`${relative(PLUGIN_ROOT, pathValue)} is missing required field ${field}`);
    }
  }
}

function collectTemplates() {
  if (!existsSync(TEMPLATE_DIR)) {
    throw new Error(`Missing Codex agent template directory: ${TEMPLATE_DIR}`);
  }

  return readdirSync(TEMPLATE_DIR)
    .filter(entry => entry.endsWith(".toml"))
    .map(entry => join(TEMPLATE_DIR, entry))
    .filter(pathValue => statSync(pathValue).isFile())
    .sort();
}

function main() {
  parseArgs(process.argv.slice(2));

  const templates = collectTemplates();
  if (templates.length === 0) {
    throw new Error(`No .toml templates found in ${TEMPLATE_DIR}`);
  }

  for (const template of templates) {
    validateTemplate(template);
  }

  const destinationDir = join(projectRoot, ".codex", "agents");
  const conflicts = [];

  if (!dryRun) {
    mkdirSync(destinationDir, { recursive: true });
  }

  for (const template of templates) {
    const destination = join(destinationDir, basename(template));
    const templateContent = readFileSync(template);
    const action = existsSync(destination) ? "updated" : "installed";

    if (existsSync(destination)) {
      const existingContent = readFileSync(destination);
      if (existingContent.equals(templateContent)) {
        console.log(`unchanged ${relative(projectRoot, destination)}`);
        continue;
      }
      if (!force) {
        conflicts.push(destination);
        console.warn(`skip ${relative(projectRoot, destination)} (exists; rerun with --force to overwrite)`);
        continue;
      }
    }

    if (dryRun) {
      console.log(`would install ${relative(projectRoot, destination)}`);
    } else {
      copyFileSync(template, destination);
      console.log(`${action} ${relative(projectRoot, destination)}`);
    }
  }

  if (conflicts.length > 0) {
    console.error(`Refused to overwrite ${conflicts.length} existing Codex agent file(s).`);
    process.exit(2);
  }
}

try {
  main();
} catch (err) {
  console.error(`install-codex-agents: ${err.message}`);
  process.exit(1);
}
