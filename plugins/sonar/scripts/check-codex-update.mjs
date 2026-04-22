#!/usr/bin/env node

import { existsSync, readFileSync, statSync } from "fs";
import { dirname, join, relative, resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(__dirname, "..");
const DEFAULT_LOCAL_MANIFEST = join(PLUGIN_ROOT, ".codex-plugin", "plugin.json");
const DEFAULT_REMOTE_MANIFEST_URL =
  "https://raw.githubusercontent.com/goldfish-1x/sonar/main/plugins/sonar/.codex-plugin/plugin.json";

let localManifestPath = DEFAULT_LOCAL_MANIFEST;
let remoteManifestUrl = process.env.SONAR_UPDATE_MANIFEST_URL || DEFAULT_REMOTE_MANIFEST_URL;
let jsonOutput = false;
let failIfUpdate = false;

function usage() {
  console.log(`Usage: node scripts/check-codex-update.mjs [options]

Compares the installed Sonar Codex plugin version with the public GitHub manifest.

Options:
  --local-manifest <path>       Local .codex-plugin/plugin.json path.
  --remote-manifest-url <url>   Remote manifest URL. Defaults to the public Sonar repo.
  --json                        Print machine-readable JSON.
  --fail-if-update              Exit 10 when a newer remote version is available.
  --help                        Show this help text.
`);
}

function parseArgs(argv) {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--local-manifest") {
      const value = argv[index + 1];
      if (!value) throw new Error("--local-manifest requires a path");
      localManifestPath = resolve(value);
      index += 1;
    } else if (arg === "--remote-manifest-url") {
      const value = argv[index + 1];
      if (!value) throw new Error("--remote-manifest-url requires a URL or path");
      remoteManifestUrl = value;
      index += 1;
    } else if (arg === "--json") {
      jsonOutput = true;
    } else if (arg === "--fail-if-update") {
      failIfUpdate = true;
    } else if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
}

function readJson(pathValue) {
  return JSON.parse(readFileSync(pathValue, "utf8"));
}

function normalizeVersion(version) {
  if (typeof version !== "string") return "";
  return version.trim().replace(/^v/i, "");
}

function parseVersion(version) {
  const normalized = normalizeVersion(version);
  const [core, prerelease = ""] = normalized.split("-", 2);
  const parts = core.split(".").map(part => {
    const parsed = Number.parseInt(part, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  });
  while (parts.length < 3) parts.push(0);
  return { parts: parts.slice(0, 3), prerelease };
}

function comparePrereleaseIdentifiers(left, right) {
  const leftIsNumeric = /^[0-9]+$/.test(left);
  const rightIsNumeric = /^[0-9]+$/.test(right);

  if (leftIsNumeric && rightIsNumeric) {
    const leftNumber = Number.parseInt(left, 10);
    const rightNumber = Number.parseInt(right, 10);
    if (leftNumber > rightNumber) return 1;
    if (leftNumber < rightNumber) return -1;
    return 0;
  }

  if (leftIsNumeric) return -1;
  if (rightIsNumeric) return 1;
  return left.localeCompare(right);
}

function comparePrerelease(left, right) {
  if (left === right) return 0;
  if (!left) return 1;
  if (!right) return -1;

  const leftParts = left.split(".");
  const rightParts = right.split(".");
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    if (leftParts[index] === undefined) return -1;
    if (rightParts[index] === undefined) return 1;
    const comparison = comparePrereleaseIdentifiers(leftParts[index], rightParts[index]);
    if (comparison !== 0) return comparison;
  }
  return 0;
}

function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (let index = 0; index < 3; index += 1) {
    if (a.parts[index] > b.parts[index]) return 1;
    if (a.parts[index] < b.parts[index]) return -1;
  }
  return comparePrerelease(a.prerelease, b.prerelease);
}

function findGitRoot(startPath) {
  let current = startPath;
  while (current && current !== dirname(current)) {
    if (existsSync(join(current, ".git"))) return current;
    current = dirname(current);
  }
  return null;
}

async function readRemoteManifest(source) {
  if (source.startsWith("file://")) {
    return readJson(fileURLToPath(source));
  }

  const possiblePath = resolve(source);
  if (existsSync(possiblePath) && statSync(possiblePath).isFile()) {
    return readJson(possiblePath);
  }

  const response = await fetch(source, {
    headers: {
      "Accept": "application/json"
    }
  });
  if (!response.ok) {
    throw new Error(`remote manifest returned HTTP ${response.status}`);
  }
  return response.json();
}

function buildResult(localManifest, remoteManifest) {
  const localVersion = normalizeVersion(localManifest.version);
  const remoteVersion = normalizeVersion(remoteManifest.version);
  if (!localVersion) throw new Error(`${localManifestPath} does not contain a version`);
  if (!remoteVersion) throw new Error(`${remoteManifestUrl} does not contain a version`);

  const comparison = compareVersions(localVersion, remoteVersion);
  const gitRoot = findGitRoot(PLUGIN_ROOT);
  return {
    plugin: localManifest.name || "sonar",
    localVersion,
    latestVersion: remoteVersion,
    updateAvailable: comparison < 0,
    localIsNewer: comparison > 0,
    remoteManifestUrl,
    pluginRoot: PLUGIN_ROOT,
    gitRoot,
    upgradeInstructions: gitRoot
      ? [
          `cd ${gitRoot}`,
          "git pull --ff-only",
          "Restart Codex so plugin changes are reloaded.",
          "Open a new Codex thread and run @sonar sonar-version."
        ]
      : [
          "Fetch the latest https://github.com/goldfish-1x/sonar repo.",
          "Open that repo in Codex and reinstall Sonar from the FishStack Local marketplace.",
          "Restart Codex so plugin changes are reloaded.",
          "Open a new Codex thread and run @sonar sonar-version."
        ]
  };
}

function printHuman(result) {
  console.log(`Sonar plugin: ${result.plugin}`);
  console.log(`Installed version: ${result.localVersion}`);
  console.log(`Latest version: ${result.latestVersion}`);
  console.log(`Remote manifest: ${result.remoteManifestUrl}`);

  if (result.updateAvailable) {
    console.log("");
    console.log("Update available.");
    console.log("Upgrade steps:");
    result.upgradeInstructions.forEach((step, index) => {
      console.log(`${index + 1}. ${step}`);
    });
  } else if (result.localIsNewer) {
    console.log("");
    console.log("Installed version is newer than the remote manifest.");
  } else {
    console.log("");
    console.log("Sonar is up to date.");
  }
}

async function main() {
  parseArgs(process.argv.slice(2));
  const localManifest = readJson(localManifestPath);
  const remoteManifest = await readRemoteManifest(remoteManifestUrl);
  const result = buildResult(localManifest, remoteManifest);

  if (jsonOutput) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printHuman(result);
  }

  if (failIfUpdate && result.updateAvailable) {
    process.exit(10);
  }
}

main().catch(err => {
  const payload = {
    error: err.message,
    localManifestPath,
    remoteManifestUrl
  };
  if (jsonOutput) {
    console.error(JSON.stringify(payload, null, 2));
  } else {
    console.error(`check-codex-update: ${err.message}`);
  }
  process.exit(2);
});
