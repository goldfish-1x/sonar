#!/usr/bin/env node

import { existsSync, readFileSync } from "fs";
import { dirname, isAbsolute, join, resolve } from "path";

export const DEFAULT_SONAR_CONFIG = {
  version: 1,
  sources: {
    include: ["src/**", "packages/**", "apps/**", "scripts/**"],
    exclude: ["**/node_modules/**", "**/dist/**", "**/.git/**", "**/.sonar/**"],
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".py"]
  },
  modules: {
    aliases: {},
    roots: ["packages/*", "apps/*"],
    manual_boundaries: [],
    grouping: {
      prefer_package_boundaries: true,
      prefer_src_feature_roots: true
    }
  },
  freshness: {
    structural: {
      auto_refresh: true,
      debounce_ms: 30000,
      refresh_before_queries: true
    },
    semantic: {
      auto_queue: true,
      auto_on_idle: true,
      idle_ms: 120000
    }
  },
  triggers: {
    max_changed_files: 12,
    max_changed_modules: 4,
    semantic_threshold: 10,
    weights: {
      new_module: 6,
      deleted_module: 7,
      export_change: 5,
      load_bearing: 8,
      critical_flow: 6,
      flow_step_change: 4
    }
  },
  critical: {
    modules: [],
    flows: []
  },
  retrieval: {
    max_modules: 3,
    max_flows: 2,
    max_facts: 3
  }
};

function isPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function mergeConfig(base, override) {
  if (Array.isArray(base) || Array.isArray(override)) {
    return Array.isArray(override) ? [...override] : [...(base || [])];
  }

  if (!isPlainObject(base) || !isPlainObject(override)) {
    return override ?? base;
  }

  const merged = { ...base };
  for (const [key, value] of Object.entries(override)) {
    merged[key] = key in base ? mergeConfig(base[key], value) : value;
  }
  return merged;
}

export function resolveProjectRootFromSonarDir(sonarDir, cwd = process.cwd()) {
  if (!sonarDir || sonarDir === ".sonar") return cwd;
  const absolute = isAbsolute(sonarDir) ? sonarDir : resolve(cwd, sonarDir);
  return dirname(absolute);
}

export function loadSonarConfig(projectRoot = process.cwd()) {
  const configPath = join(projectRoot, "sonar.config.json");
  if (!existsSync(configPath)) {
    return { ...DEFAULT_SONAR_CONFIG, _path: null };
  }

  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf8"));
    return {
      ...mergeConfig(DEFAULT_SONAR_CONFIG, parsed),
      _path: configPath
    };
  } catch {
    return { ...DEFAULT_SONAR_CONFIG, _path: configPath, _invalid: true };
  }
}
