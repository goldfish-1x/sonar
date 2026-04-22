#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";

export function computeFreshnessManifest(sonarDir) {
  const skeletonPath = join(sonarDir, "skeleton.json");
  const previousSkeletonPath = join(sonarDir, "previous-skeleton.json");
  const modulesDir = join(sonarDir, "modules");
  const systemPath = join(sonarDir, "system.json");

  if (!existsSync(skeletonPath)) {
    return {
      generated_at: new Date().toISOString(),
      new_modules: [],
      code_changed: {},
      dependency_only: {},
      deleted_modules: [],
      synthesis_needed: false,
      synthesis_reason: "",
      total_stale: 0,
      total_modules: 0
    };
  }

  const skeleton = JSON.parse(readFileSync(skeletonPath, "utf8"));
  const skModules = skeleton.modules || {};
  const skFiles = skeleton.files || {};
  const previousSkeleton = existsSync(previousSkeletonPath)
    ? JSON.parse(readFileSync(previousSkeletonPath, "utf8"))
    : { files: {}, modules: {} };
  const prevFiles = previousSkeleton.files || {};

  const existingCards = {};
  if (existsSync(modulesDir)) {
    for (const file of readdirSync(modulesDir).filter(entry => entry.endsWith(".json"))) {
      try {
        const card = JSON.parse(readFileSync(join(modulesDir, file), "utf8"));
        existingCards[card.key] = card;
      } catch {
        // Ignore malformed cards during freshness derivation.
      }
    }
  }

  let loadBearing = [];
  if (existsSync(systemPath)) {
    try {
      const system = JSON.parse(readFileSync(systemPath, "utf8"));
      loadBearing = system.load_bearing || [];
    } catch {
      loadBearing = [];
    }
  }

  const newModules = [];
  const codeChanged = {};
  const dependencyOnly = {};
  const deletedModules = [];

  for (const [moduleKey, moduleInfo] of Object.entries(skModules)) {
    if (moduleKey.startsWith("_test_")) continue;

    const card = existingCards[moduleKey];
    if (!card) {
      newModules.push(moduleKey);
      continue;
    }

    const skFileSet = new Set(moduleInfo.files || []);
    const cardFileSet = new Set(card.files || []);

    const addedFiles = [...skFileSet].filter(file => !cardFileSet.has(file));
    const removedFiles = [...cardFileSet].filter(file => !skFileSet.has(file));
    const modifiedFiles = [...skFileSet]
      .filter(file => cardFileSet.has(file))
      .filter(file => skFiles[file]?.content_hash && prevFiles[file]?.content_hash && skFiles[file].content_hash !== prevFiles[file].content_hash);

    if (addedFiles.length > 0 || removedFiles.length > 0 || modifiedFiles.length > 0) {
      codeChanged[moduleKey] = {
        added_files: addedFiles,
        removed_files: removedFiles,
        modified_files: modifiedFiles,
        is_load_bearing: loadBearing.includes(moduleKey)
      };
    }
  }

  for (const cardKey of Object.keys(existingCards)) {
    if (!skModules[cardKey] && !cardKey.startsWith("_test_")) {
      deletedModules.push(cardKey);
    }
  }

  const changedSet = new Set([...newModules, ...Object.keys(codeChanged)]);
  for (const edge of skeleton.edges || []) {
    if (changedSet.has(edge.target) && !changedSet.has(edge.source)) {
      if (!edge.source.startsWith("_test_") && existingCards[edge.source]) {
        if (!dependencyOnly[edge.source]) {
          dependencyOnly[edge.source] = { upstream_changed: [] };
        }
        if (!dependencyOnly[edge.source].upstream_changed.includes(edge.target)) {
          dependencyOnly[edge.source].upstream_changed.push(edge.target);
        }
      }
    }
  }

  let synthesisNeeded = false;
  let synthesisReason = "";

  for (const [moduleKey, info] of Object.entries(codeChanged)) {
    if (info.is_load_bearing) {
      synthesisNeeded = true;
      synthesisReason = `load-bearing module '${moduleKey}' has code changes`;
      break;
    }
  }

  if (!synthesisNeeded && newModules.length > 0) {
    synthesisNeeded = true;
    synthesisReason = `${newModules.length} new module(s) added`;
  }

  if (!synthesisNeeded && deletedModules.length > 0) {
    synthesisNeeded = true;
    synthesisReason = `${deletedModules.length} module(s) deleted`;
  }

  return {
    generated_at: new Date().toISOString(),
    new_modules: newModules,
    code_changed: codeChanged,
    dependency_only: dependencyOnly,
    deleted_modules: deletedModules,
    synthesis_needed: synthesisNeeded,
    synthesis_reason: synthesisReason,
    total_stale: newModules.length + Object.keys(codeChanged).length,
    total_modules: Object.keys(skModules).filter(key => !key.startsWith("_test_")).length
  };
}
