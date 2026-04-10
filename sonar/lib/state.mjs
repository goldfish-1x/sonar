#!/usr/bin/env node

import { existsSync, readFileSync, renameSync, writeFileSync } from "fs";
import { join } from "path";

export const SONAR_STATE_VERSION = 1;

export function loadSonarState(sonarDir) {
  const statePath = join(sonarDir, "state.json");
  if (!existsSync(statePath)) return null;
  try {
    return JSON.parse(readFileSync(statePath, "utf8"));
  } catch {
    return null;
  }
}

export function writeStateJson(sonarDir, state) {
  const statePath = join(sonarDir, "state.json");
  const tempPath = `${statePath}.tmp`;
  writeFileSync(tempPath, JSON.stringify(state, null, 2));
  renameSync(tempPath, statePath);
}

export function getModuleState(state, moduleKey) {
  return state?.modules?.[moduleKey] || null;
}

export function getFileState(state, filePath) {
  return state?.files?.[filePath] || null;
}

export function getFlowState(state, flowName) {
  return state?.flows?.[flowName] || null;
}

export function getSystemState(state) {
  return state?.system || null;
}

export function moduleFreshnessStatus(moduleState) {
  if (!moduleState) return "unknown";
  if (moduleState.semantic_status && moduleState.semantic_status !== "fresh") return moduleState.semantic_status;
  if (moduleState.behavioral_status && moduleState.behavioral_status !== "fresh") return moduleState.behavioral_status;
  return moduleState.structural_status || "unknown";
}

export function flowFreshnessStatus(flowState) {
  return flowState?.status || "unknown";
}

export function systemFreshnessStatus(systemState) {
  return systemState?.status || "unknown";
}

export function freshnessRowsFromState(state) {
  const generatedAt = state?.generated_at || new Date().toISOString();
  const rows = {
    module: new Map(),
    flow: new Map(),
    system: new Map()
  };

  for (const [moduleKey, moduleState] of Object.entries(state?.modules || {})) {
    rows.module.set(moduleKey, {
      artifact_type: "module",
      artifact_key: moduleKey,
      status: moduleFreshnessStatus(moduleState),
      reason: (moduleState.reasons || []).join(", ") || "No freshness reasons recorded.",
      updated_at: moduleState.last_changed_at || generatedAt
    });
  }

  for (const [flowName, flowState] of Object.entries(state?.flows || {})) {
    rows.flow.set(flowName, {
      artifact_type: "flow",
      artifact_key: flowName,
      status: flowFreshnessStatus(flowState),
      reason: (flowState.reasons || []).join(", ") || "No freshness reasons recorded.",
      updated_at: flowState.last_changed_at || generatedAt
    });
  }

  if (state?.system) {
    rows.system.set("system", {
      artifact_type: "system",
      artifact_key: "system",
      status: systemFreshnessStatus(state.system),
      reason: (state.system.reasons || []).join(", ") || "No freshness reasons recorded.",
      updated_at: state.last_semantic_refresh_at || generatedAt
    });
  }

  return rows;
}
