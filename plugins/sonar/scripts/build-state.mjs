#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";
import { loadSonarConfig, resolveProjectRootFromSonarDir } from "../lib/config.mjs";
import { computeFreshnessManifest } from "../lib/freshness.mjs";
import { loadSonarState, SONAR_STATE_VERSION, writeStateJson } from "../lib/state.mjs";
import { buildSystemFacts, loadJsonIfExists, normalizeFlow } from "./retrieval-utils.mjs";

function stableTimestamp(previousValue, isChanged, generatedAt) {
  if (isChanged || !previousValue) return generatedAt;
  return previousValue;
}

function collectFlowRecords(flowsDir) {
  if (!existsSync(flowsDir)) return [];
  return readdirSync(flowsDir)
    .filter(file => file.endsWith(".json"))
    .map(file => {
      try {
        return normalizeFlow(JSON.parse(readFileSync(join(flowsDir, file), "utf8")));
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

export function buildStateForSonarDir(sonarDir, options = {}) {
  const projectRoot = options.projectRoot || resolveProjectRootFromSonarDir(sonarDir, process.cwd());
  const config = loadSonarConfig(projectRoot);
  const previousState = loadSonarState(sonarDir) || {};
  const meta = loadJsonIfExists(join(sonarDir, "meta.json"), {});
  const skeleton = loadJsonIfExists(join(sonarDir, "skeleton.json"), { files: {}, modules: {}, edges: [] });
  const staleManifest = options.freshnessManifest || computeFreshnessManifest(sonarDir);
  const system = loadJsonIfExists(join(sonarDir, "system.json"), {});
  const systemFacts = buildSystemFacts(system);
  const flows = collectFlowRecords(join(sonarDir, "flows"));

  const generatedAt = staleManifest.generated_at || new Date().toISOString();
  const weights = config.triggers?.weights || {};
  const loadBearing = new Set([...(system.load_bearing || []), ...(config.critical?.modules || [])]);
  const criticalFlows = new Set(config.critical?.flows || []);
  const changedModules = new Set(Object.keys(staleManifest.code_changed || {}));
  const newModules = new Set(staleManifest.new_modules || []);
  const dependencyOnly = new Set(Object.keys(staleManifest.dependency_only || {}));
  const deletedModules = new Set(staleManifest.deleted_modules || []);

  const modules = {};
  const files = {};
  const flowsState = {};
  const modulePending = new Set();
  const flowPending = new Set();

  for (const [filePath, fileInfo] of Object.entries(skeleton.files || {})) {
    const moduleKey = fileInfo.module_key;
    if (!moduleKey || moduleKey.startsWith("_test_")) continue;

    const reasons = [];
    const modulePrevious = previousState.modules?.[moduleKey];
    const isChanged = changedModules.has(moduleKey) || newModules.has(moduleKey) || dependencyOnly.has(moduleKey);

    let semanticStatus = "fresh";
    let behavioralStatus = "fresh";
    let impactScore = 0;

    if (newModules.has(moduleKey)) {
      semanticStatus = "queued";
      behavioralStatus = "stale";
      impactScore += weights.new_module || 0;
      reasons.push("new_module");
      modulePending.add(moduleKey);
    }

    if (changedModules.has(moduleKey)) {
      semanticStatus = "stale";
      behavioralStatus = "stale";
      impactScore += 1;
      reasons.push("code_changed");
      modulePending.add(moduleKey);
    }

    if (dependencyOnly.has(moduleKey)) {
      semanticStatus = semanticStatus === "fresh" ? "stale" : semanticStatus;
      reasons.push("dependency_only");
    }

    if (loadBearing.has(moduleKey) && (changedModules.has(moduleKey) || newModules.has(moduleKey))) {
      impactScore += weights.load_bearing || 0;
      reasons.push("load_bearing");
    }

    modules[moduleKey] = modules[moduleKey] || {
      structural_status: deletedModules.has(moduleKey) ? "stale" : "fresh",
      behavioral_status: behavioralStatus,
      semantic_status: semanticStatus,
      impact_score: impactScore,
      last_changed_at: stableTimestamp(modulePrevious?.last_changed_at, isChanged, generatedAt),
      reasons,
      pending_actions: []
    };

    files[filePath] = {
      module: moduleKey,
      structural_status: "fresh",
      semantic_status: modules[moduleKey].semantic_status,
      last_changed_at: stableTimestamp(previousState.files?.[filePath]?.last_changed_at, isChanged, generatedAt),
      reasons
    };
  }

  for (const moduleKey of deletedModules) {
    const modulePrevious = previousState.modules?.[moduleKey];
    modules[moduleKey] = {
      structural_status: "stale",
      behavioral_status: "stale",
      semantic_status: "queued",
      impact_score: weights.deleted_module || 0,
      last_changed_at: stableTimestamp(modulePrevious?.last_changed_at, true, generatedAt),
      reasons: ["deleted_module"],
      pending_actions: ["remove_module_card", "rerun_synthesis"]
    };
    modulePending.add(moduleKey);
  }

  for (const flow of flows) {
    const relatedModules = [...new Set(flow.steps.map(step => step.module).filter(Boolean))];
    const relatedChangedModules = relatedModules.filter(moduleKey => {
      const moduleState = modules[moduleKey];
      return moduleState && !["fresh", "unknown"].includes(moduleState.semantic_status);
    });
    const isCriticalFlow = criticalFlows.has(flow.name);
    const previousFlow = previousState.flows?.[flow.name];
    const reasons = relatedChangedModules.map(moduleKey => `step_module_changed:${moduleKey}`);
    let impactScore = relatedChangedModules.length * (weights.flow_step_change || 0);

    if (isCriticalFlow) {
      impactScore += weights.critical_flow || 0;
      reasons.push("critical_flow");
    }

    const status = relatedChangedModules.length > 0 || isCriticalFlow ? "stale" : "fresh";
    if (status !== "fresh") flowPending.add(flow.name);

    flowsState[flow.name] = {
      status,
      impact_score: impactScore,
      reasons,
      pending_actions: status === "fresh" ? [] : ["retrace_flow"],
      last_changed_at: stableTimestamp(previousFlow?.last_changed_at, status !== "fresh", generatedAt)
    };

    for (const moduleKey of relatedChangedModules) {
      modules[moduleKey].behavioral_status = "stale";
      modules[moduleKey].impact_score += weights.flow_step_change || 0;
      if (!modules[moduleKey].reasons.includes("flow_step_changed")) {
        modules[moduleKey].reasons.push("flow_step_changed");
      }
      if (!modules[moduleKey].pending_actions.includes("retrace_flows")) {
        modules[moduleKey].pending_actions.push("retrace_flows");
      }
    }
  }

  for (const [moduleKey, state] of Object.entries(modules)) {
    if (modulePending.has(moduleKey) && !state.pending_actions.includes("reanalyze_module")) {
      state.pending_actions.push("reanalyze_module");
    }

    if (staleManifest.synthesis_needed && (state.reasons.includes("load_bearing") || state.reasons.includes("new_module") || state.reasons.includes("deleted_module"))) {
      if (!state.pending_actions.includes("rerun_synthesis")) {
        state.pending_actions.push("rerun_synthesis");
      }
    }
  }

  const dirty = Object.values(modules).some(item => item.semantic_status !== "fresh")
    || Object.values(flowsState).some(item => item.status !== "fresh")
    || !!staleManifest.synthesis_needed;

  const state = {
    version: SONAR_STATE_VERSION,
    generated_at: generatedAt,
    config_version: config.version || 1,
    structural_generation: meta.structural_generation || previousState.structural_generation || 0,
    semantic_generation: meta.semantic_generation || previousState.semantic_generation || 0,
    last_structural_refresh_at: meta.skeleton_updated_at || generatedAt,
    last_semantic_refresh_at: meta.updated_at || previousState.last_semantic_refresh_at || null,
    dirty,
    refresh: {
      structural: {
        status: existsSync(join(sonarDir, "skeleton.json")) ? "fresh" : "unknown",
        reason: existsSync(join(sonarDir, "skeleton.json"))
          ? "Structural artifacts are present."
          : "No structural artifacts available."
      },
      semantic: {
        status: staleManifest.synthesis_needed ? "queued" : dirty ? "stale" : "fresh",
        reason: staleManifest.synthesis_reason || (dirty ? "Some modules or flows need semantic refresh." : "Semantic artifacts are aligned with current structural data.")
      }
    },
    files,
    modules,
    flows: flowsState,
    system: {
      status: staleManifest.synthesis_needed ? "queued" : "fresh",
      reasons: staleManifest.synthesis_needed ? [staleManifest.synthesis_reason || "semantic_refresh_needed"] : [],
      pending_actions: staleManifest.synthesis_needed ? ["rerun_synthesis"] : [],
      fact_count: systemFacts.length
    },
    queue: {
      modules: [...modulePending].sort(),
      flows: [...flowPending].sort(),
      system: !!staleManifest.synthesis_needed
    }
  };

  writeStateJson(sonarDir, state);
  return state;
}

function main() {
  const sonarDir = process.argv[2] || ".sonar";
  buildStateForSonarDir(sonarDir);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
