#!/usr/bin/env node

/**
 * Sonar — File importance ranker
 *
 * Computes graph-based importance scores for every file in skeleton.json.
 * Builds a full reverse-import map (intra + cross module) and scores each file:
 *
 *   score = crossModuleDirect * 10   — strongest signal: imported by other modules
 *         + uniqueImporterDirs * 5   — cross-directory reach
 *         + transitiveFanIn   * 3    — blast radius (BFS, depth-capped)
 *         + directFanIn       * 2    — direct importers
 *         + exportCount       * 1    — public surface area
 *         + lineCount / 300          — size as tiebreaker
 *
 * Adds `importance_score` and `score_breakdown` to each file entry, then
 * writes the updated skeleton.json back in place.
 *
 * Usage: node rank-files.mjs <path-to-skeleton.json>
 */

import { readFileSync, writeFileSync } from "fs";
import { performance } from "perf_hooks";
import { EXTENSION_PATTERN, buildPathIndex, resolveImportPath } from "./retrieval-utils.mjs";

const skeletonPath = process.argv[2];
if (!skeletonPath) {
  console.error("Usage: node rank-files.mjs <path-to-skeleton.json>");
  process.exit(1);
}

const startedAt = performance.now();
const skeleton = JSON.parse(readFileSync(skeletonPath, "utf8"));
const { files } = skeleton;

if (!files || Object.keys(files).length === 0) {
  console.log("rank-files: no files in skeleton — skipping.");
  process.exit(0);
}

// ─── Build full reverse edge map (intra + cross module) ──────────────────────

const pathIndex = buildPathIndex(files);

// reverseEdges[target] = Set of source file paths that import target
const reverseEdges = {};

for (const [filePath, info] of Object.entries(files)) {
  for (const imp of info.imports || []) {
    if (imp.kind !== "internal") continue;
    const target = resolveImportPath(imp.source, filePath, pathIndex);
    if (!target || target === filePath) continue;
    if (!reverseEdges[target]) reverseEdges[target] = new Set();
    reverseEdges[target].add(filePath);
  }
}

// ─── Module size index (for BFS depth cap) ───────────────────────────────────

const moduleSizes = {};
for (const info of Object.values(files)) {
  const key = info.module_key;
  if (key) moduleSizes[key] = (moduleSizes[key] || 0) + 1;
}

function bfsDepthCap(moduleKey) {
  const size = moduleSizes[moduleKey] || 0;
  if (size < 100) return Infinity;
  if (size < 500) return 10;
  if (size < 2000) return 7;
  return 4;
}

// ─── Transitive fan-in (BFS through reverse edges) ───────────────────────────

function transitiveFanIn(filePath, depthCap) {
  const visited = new Set();
  // [file, depth]
  const queue = [[filePath, 0]];
  while (queue.length > 0) {
    const [f, d] = queue.shift();
    if (visited.has(f)) continue;
    visited.add(f);
    if (d >= depthCap) continue;
    for (const importer of reverseEdges[f] || []) {
      if (!visited.has(importer)) queue.push([importer, d + 1]);
    }
  }
  visited.delete(filePath); // exclude self
  return visited.size;
}

// ─── Barrel file heuristic ───────────────────────────────────────────────────

function isBarrel(filePath, info) {
  const base = filePath.split("/").pop().replace(EXTENSION_PATTERN, "");
  const internalImports = (info.imports || []).filter(i => i.kind === "internal").length;
  return (
    base === "index" &&
    (info.exports || []).length > 3 &&
    (info.lines || 0) < 50 &&
    internalImports > 2
  );
}

// ─── Score every file ────────────────────────────────────────────────────────

let scored = 0;
for (const [filePath, info] of Object.entries(files)) {
  const moduleKey = info.module_key || "";
  const importers = reverseEdges[filePath] || new Set();

  const directFanIn = importers.size;

  const crossModuleDirect = [...importers].filter(imp => {
    const m = files[imp]?.module_key;
    return m && m !== moduleKey;
  }).length;

  const importerDirs = new Set(
    [...importers].map(imp => {
      const parts = imp.split("/");
      return parts.slice(0, -1).join("/");
    })
  );
  const uniqueImporterDirs = importerDirs.size;

  const depthCap = bfsDepthCap(moduleKey);
  const transFanIn = transitiveFanIn(filePath, depthCap);

  const exportCount = (info.exports || []).length;
  const lineCount = info.lines || 0;
  const barrel = isBarrel(filePath, info);

  const score =
    crossModuleDirect * 10 +
    uniqueImporterDirs * 5 +
    transFanIn * 3 +
    directFanIn * 2 +
    exportCount * 1 +
    lineCount / 300;

  info.importance_score = Math.round(score * 10) / 10;
  info.score_breakdown = {
    crossModuleDirect,
    uniqueImporterDirs,
    transitiveFanIn: transFanIn,
    directFanIn,
    exportCount,
    lineCount,
    isBarrel: barrel
  };

  if (score > 0) scored++;
}

// ─── Write back ──────────────────────────────────────────────────────────────

writeFileSync(skeletonPath, JSON.stringify(skeleton, null, 2));

const elapsed = Math.round(performance.now() - startedAt);
const total = Object.keys(files).length;
console.log(
  `rank-files: scored ${scored}/${total} files (${elapsed}ms)`
);
