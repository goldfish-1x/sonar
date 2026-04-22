#!/usr/bin/env node

import { readdirSync } from "fs";
import { execFileSync } from "child_process";
import { extname, join, resolve } from "path";
import { performance } from "perf_hooks";
import { fileURLToPath } from "url";

export const SOURCE_EXTENSIONS = [".py", ".ts", ".tsx", ".js", ".jsx", ".mjs"];
export const DERIVED_SONAR_FILES = [
  "graph.db",
  "summaries.json",
  "file-modules.json",
  "symbol-imports.json",
  "state.json",
  "previous-skeleton.json"
];
export const IGNORED_PATH_SEGMENTS = new Set([
  "node_modules",
  ".venv",
  "dist",
  "build",
  ".git",
  ".sonar",
  "__pycache__",
  ".next",
  ".claude",
  ".e2b",
  "site-packages",
  "_generated",
  "vendor",
  ".cache"
]);

export function hasSupportedSourceExtension(filePath) {
  return SOURCE_EXTENSIONS.includes(extname(filePath));
}

export function languageFromPath(filePath) {
  const ext = extname(filePath);
  if (ext === ".py") return "python";
  if (ext === ".ts" || ext === ".tsx") return "typescript";
  if (ext === ".js" || ext === ".jsx" || ext === ".mjs") return "javascript";
  return "unknown";
}

export function shouldIgnorePath(pathValue) {
  return pathValue.split(/[\\/]/).some(part => IGNORED_PATH_SEGMENTS.has(part));
}

export function sourceExtensionRegex() {
  const pattern = SOURCE_EXTENSIONS.map(ext => ext.slice(1).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  return `\\.(${pattern})$`;
}

export function listSourceFiles(projectRoot) {
  const root = resolve(projectRoot);
  const files = [];

  function walk(currentPath) {
    for (const entry of readdirSync(currentPath, { withFileTypes: true })) {
      if (IGNORED_PATH_SEGMENTS.has(entry.name)) continue;
      const fullPath = join(currentPath, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!hasSupportedSourceExtension(fullPath)) continue;
      files.push(fullPath);
    }
  }

  walk(root);
  files.sort();
  return files;
}

function listGitSourceFiles(projectRoot) {
  const root = resolve(projectRoot);
  try {
    const output = execFileSync(
      "git",
      ["-C", root, "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
    );

    return output
      .split("\0")
      .filter(Boolean)
      .filter(pathValue => !shouldIgnorePath(pathValue))
      .filter(pathValue => hasSupportedSourceExtension(pathValue))
      .map(pathValue => join(root, pathValue))
      .sort();
  } catch {
    return null;
  }
}

export function listSourceFilesWithMetadata(projectRoot) {
  const startedAt = performance.now();
  const gitFiles = listGitSourceFiles(projectRoot);

  if (gitFiles) {
    return {
      files: gitFiles,
      discovery: {
        strategy: "git-ls-files",
        duration_ms: Number((performance.now() - startedAt).toFixed(3)),
        file_count: gitFiles.length
      }
    };
  }

  const files = listSourceFiles(projectRoot);
  return {
    files,
    discovery: {
      strategy: "filesystem-walk",
      duration_ms: Number((performance.now() - startedAt).toFixed(3)),
      file_count: files.length
    }
  };
}

function main() {
  const command = process.argv[2];
  if (command === "list") {
    const projectRoot = process.argv[3] || ".";
    for (const file of listSourceFilesWithMetadata(projectRoot).files) {
      console.log(file);
    }
    return;
  }
  if (command === "manifest") {
    const projectRoot = process.argv[3] || ".";
    process.stdout.write(JSON.stringify(listSourceFilesWithMetadata(projectRoot), null, 2));
    return;
  }
  if (command === "regex") {
    console.log(sourceExtensionRegex());
    return;
  }
  if (command === "extensions") {
    console.log(JSON.stringify(SOURCE_EXTENSIONS));
    return;
  }
  console.error("Usage: node source-config.mjs <list|manifest|regex|extensions> [project-root]");
  process.exit(1);
}

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === thisFile) {
  main();
}
