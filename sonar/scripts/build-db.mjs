#!/usr/bin/env node

/**
 * Sonar — Rebuild graph.db from .sonar/ JSON files
 * Also generates pre-computed lookup files for fast hook queries:
 *   - file-modules.json (file → module + dependents)
 *   - summaries.json (module key → purpose + conventions + rules)
 *   - symbol-imports.json (reverse import lookup)
 *   - partials/agent-briefs/*.json (bounded module briefs for agents)
 */

import { existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { performance } from "perf_hooks";
import { fileURLToPath } from "url";
import Database from "better-sqlite3";
import { buildStateForSonarDir } from "./build-state.mjs";
import { freshnessRowsFromState, loadSonarState } from "../lib/state.mjs";
import { buildAgentBriefArtifacts } from "./agent-briefs.mjs";
import { snapshotMemoryMb, toFixedNumber, writePerfSection } from "./perf-utils.mjs";
import {
  buildSystemFacts,
  extractRuleTexts,
  loadJsonIfExists,
  normalizeFlow
} from "./retrieval-utils.mjs";

const EXTENSION_PATTERN = /\.(ts|tsx|js|jsx|mjs|py)$/;

const __dirname = dirname(fileURLToPath(import.meta.url));
const sonarDir = process.argv[2] || ".sonar";
const dbPath = join(sonarDir, "graph.db");
const schemaPath = join(__dirname, "init-db.sql");

if (!existsSync(sonarDir)) {
  console.error(`Error: ${sonarDir} directory not found`);
  process.exit(1);
}

const overallStartedAt = performance.now();
const phaseDurations = {};

if (existsSync(dbPath)) unlinkSync(dbPath);

const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.exec(readFileSync(schemaPath, "utf8"));

const stats = { files: 0, modules: 0, submodules: 0, symbols: 0, edges: 0, file_edges: 0, flows: 0, flow_steps: 0, system_facts: 0 };

const fileIdByPath = new Map();
const seenSymbols = new Set();
const trackedEdges = new Map();
const incomingByTarget = new Map();
const outgoingBySource = new Map();
const moduleRows = new Map();
const moduleCardsByKey = new Map();
const symbolsByModule = new Map();
const flowRecords = [];

const insertFile = db.prepare("INSERT OR REPLACE INTO files (path, language, lines, module_key, content_hash) VALUES (?, ?, ?, ?, ?)");
const insertEdge = db.prepare("INSERT OR REPLACE INTO edges (source_module, target_module, kind, weight) VALUES (?, ?, ?, ?)");
const insertModule = db.prepare("INSERT OR REPLACE INTO modules (key, name, path, purpose, complexity, card_kind, child_module_keys, analyzed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
const insertModuleFts = db.prepare("INSERT INTO modules_fts (key, name, purpose, conventions, business_rules, public_api, side_effects) VALUES (?, ?, ?, ?, ?, ?, ?)");
const insertSymbol = db.prepare("INSERT INTO symbols (file_id, name, kind, line, signature, purpose, is_exported, module_key) VALUES (?, ?, ?, ?, ?, ?, 1, ?)");
const insertFlow = db.prepare("INSERT OR REPLACE INTO flows (name, title, summary, entry_file, entry_function, step_count, confidence, analyzed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
const insertFlowFts = db.prepare("INSERT INTO flows_fts (name, title, summary, steps_text, invariants, failure_modes, module_keys) VALUES (?, ?, ?, ?, ?, ?, ?)");
const insertStep = db.prepare("INSERT OR REPLACE INTO flow_steps (flow_name, step_order, module_key, function_name, file_path, description, data, confidence, evidence_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
const insertSystemFact = db.prepare("INSERT OR REPLACE INTO system_facts (id, kind, title, detail, scope, confidence, check_cmd, evidence_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
const insertSystemFactModule = db.prepare("INSERT OR REPLACE INTO system_fact_modules (fact_id, module_key) VALUES (?, ?)");
const insertSystemFactFts = db.prepare("INSERT INTO system_facts_fts (id, kind, title, detail, scope, module_keys) VALUES (?, ?, ?, ?, ?, ?)");
const insertArtifactFreshness = db.prepare("INSERT OR REPLACE INTO artifact_freshness (artifact_type, artifact_key, status, reason, updated_at) VALUES (?, ?, ?, ?, ?)");
const insertSubmodule = db.prepare("INSERT OR REPLACE INTO submodules (key, parent_module_key, cluster_name, cluster_slug, purpose, analyzed_at) VALUES (?, ?, ?, ?, ?, ?)");
const insertSubmoduleFts = db.prepare("INSERT INTO submodules_fts (key, cluster_name, purpose, business_rules, conventions, public_api) VALUES (?, ?, ?, ?, ?, ?)");
const insertFileEdge = db.prepare("INSERT OR REPLACE INTO file_edges (source_file, target_file, kind, weight) VALUES (?, ?, ?, ?)");

function normalizeModuleRefs(value) {
  if (!value) return [];

  if (Array.isArray(value)) {
    return value
      .map(entry => {
        if (typeof entry === "string") return entry;
        if (entry && typeof entry === "object") {
          return entry.key || entry.module || entry.name || null;
        }
        return null;
      })
      .filter(Boolean);
  }

  if (typeof value === "object") {
    return Object.entries(value).flatMap(([group, entries]) => {
      if (group === "external") return [];
      return normalizeModuleRefs(entries);
    });
  }

  return [];
}

function inferModulePath(moduleKey, files = []) {
  if (files.length === 0) return moduleKey;
  const sample = files[0];
  const parts = sample.split("/");
  parts.pop();
  return parts.join("/") || moduleKey;
}

function edgeKey(source, target, kind) {
  return `${source}|${target}|${kind}`;
}

function recordEdge(source, target, kind = "imports", weight = 1) {
  if (!source || !target) return;

  const key = edgeKey(source, target, kind);
  const existing = trackedEdges.get(key);
  if (existing) {
    if (weight > existing.weight) {
      existing.weight = weight;
      insertEdge.run(source, target, kind, weight);
    }
    return;
  }

  trackedEdges.set(key, { source, target, kind, weight });
  insertEdge.run(source, target, kind, weight);

  if (!incomingByTarget.has(target)) incomingByTarget.set(target, new Set());
  if (!outgoingBySource.has(source)) outgoingBySource.set(source, new Set());
  incomingByTarget.get(target).add(source);
  outgoingBySource.get(source).add(target);
  stats.edges = trackedEdges.size;
}

function registerModuleSymbol(moduleKey, symbol) {
  if (!symbolsByModule.has(moduleKey)) symbolsByModule.set(moduleKey, []);
  const symbols = symbolsByModule.get(moduleKey);
  if (symbols.some(item => item.name === symbol.name)) return;
  symbols.push({
    name: symbol.name,
    kind: symbol.kind,
    file: symbol.file || null,
    line: symbol.line ?? null
  });
}

const exportKindIndex = new Map();
const defaultExportNameByFile = new Map();

function resolveSymbolKind(symbol, filePath, symbolName, fallbackKind = "function") {
  return symbol?.kind || exportKindIndex.get(`${filePath}|${symbolName}`) || fallbackKind;
}

function registerSymbol(moduleKey, symbol, fallbackKind = "function") {
  const symbolKey = `${moduleKey}|${symbol.name}`;
  if (!symbol.name || seenSymbols.has(symbolKey)) return;

  seenSymbols.add(symbolKey);
  const resolvedKind = resolveSymbolKind(symbol, symbol.file, symbol.name, fallbackKind);
  insertSymbol.run(
    symbol.file ? fileIdByPath.get(symbol.file) || null : null,
    symbol.name,
    resolvedKind,
    symbol.line,
    symbol.signature || "",
    symbol.purpose || "",
    moduleKey
  );
  registerModuleSymbol(moduleKey, { ...symbol, kind: resolvedKind });
  stats.symbols++;
}

function buildPathIndex(files) {
  const pathIndex = {};

  for (const filePath of Object.keys(files)) {
    if (!pathIndex[filePath]) pathIndex[filePath] = [];
    pathIndex[filePath].push(filePath);

    const withoutExt = filePath.replace(EXTENSION_PATTERN, "");
    if (!pathIndex[withoutExt]) pathIndex[withoutExt] = [];
    pathIndex[withoutExt].push(filePath);

    if (withoutExt.endsWith("/index")) {
      const dirPath = withoutExt.replace(/\/index$/, "");
      if (!pathIndex[dirPath]) pathIndex[dirPath] = [];
      pathIndex[dirPath].push(filePath);
    }
  }

  return pathIndex;
}

function resolveImport(source, fromFile, pathIndex) {
  if (source.startsWith(".")) {
    const resolved = join(dirname(fromFile), source).replace(/\\/g, "/");
    const normalized = resolved.replace(EXTENSION_PATTERN, "");
    return pathIndex[resolved]?.[0] || pathIndex[normalized]?.[0] || null;
  }

  if (source.startsWith("@/")) {
    const target = "src/" + source.slice(2);
    const normalized = target.replace(EXTENSION_PATTERN, "");
    return pathIndex[target]?.[0] || pathIndex[normalized]?.[0] || null;
  }

  const pyPath = source.replace(/\./g, "/");
  return pathIndex[pyPath]?.[0] || pathIndex[`${pyPath}/__init__.py`]?.[0] || null;
}

const skeletonPath = join(sonarDir, "skeleton.json");
const systemPath = join(sonarDir, "system.json");

let skeleton = { files: {}, edges: [], modules: {} };
const state = loadSonarState(sonarDir) || buildStateForSonarDir(sonarDir);
const systemJson = loadJsonIfExists(systemPath, {});

const skeletonStartedAt = performance.now();
if (existsSync(skeletonPath)) {
  skeleton = JSON.parse(readFileSync(skeletonPath, "utf8"));

  for (const [filePath, info] of Object.entries(skeleton.files || {})) {
    if (info.default_export_name) {
      defaultExportNameByFile.set(filePath, info.default_export_name);
    }
    for (const exp of info.exports || []) {
      exportKindIndex.set(`${filePath}|${exp.name}`, exp.kind);
    }
  }

  const insertFiles = db.transaction(() => {
    for (const [path, info] of Object.entries(skeleton.files || {})) {
      const result = insertFile.run(path, info.language, info.lines, info.module_key, info.content_hash);
      fileIdByPath.set(path, Number(result.lastInsertRowid));
      stats.files++;
    }

    for (const edge of skeleton.edges || []) {
      recordEdge(edge.source, edge.target, edge.kind || "imports", edge.weight || 1);
    }

    for (const edge of skeleton.file_edges || []) {
      insertFileEdge.run(edge.source, edge.target, edge.kind || "imports", edge.weight || 1);
    }
    stats.file_edges = (skeleton.file_edges || []).length;
  });
  insertFiles();
}
phaseDurations.load_skeleton_ms = toFixedNumber(performance.now() - skeletonStartedAt);

const modulesDir = join(sonarDir, "modules");
const summaries = {};
const fileModules = {};
const knownModuleKeys = new Set(Object.keys(skeleton.modules || {}));

const modulesStartedAt = performance.now();
if (existsSync(modulesDir)) {
  const cardFiles = readdirSync(modulesDir).filter(file => file.endsWith(".json"));
  for (const cardFile of cardFiles) {
    knownModuleKeys.add(cardFile.replace(/\.json$/, ""));
  }

  const insertModules = db.transaction(() => {
    for (const cardFile of cardFiles) {
      const card = JSON.parse(readFileSync(join(modulesDir, cardFile), "utf8"));
      knownModuleKeys.add(card.key);
      moduleCardsByKey.set(card.key, card);

      const moduleRow = {
        key: card.key,
        name: card.name || card.key,
        path: card.path || inferModulePath(card.key, card.files || []),
        purpose: card.purpose || "",
        complexity: card.complexity || "",
        analyzed_at: card.analyzed_at || null
      };
      moduleRows.set(card.key, moduleRow);

      const cardKind = (card.is_parent || card.kind === "parent") ? "parent" : "module";
      const childKeys = cardKind === "parent" ? JSON.stringify(card.child_module_keys || []) : null;
      insertModule.run(moduleRow.key, moduleRow.name, moduleRow.path, moduleRow.purpose, moduleRow.complexity, cardKind, childKeys, moduleRow.analyzed_at);
      insertModuleFts.run(
        moduleRow.key,
        moduleRow.name,
        moduleRow.purpose,
        (card.conventions || []).map(item => typeof item === "string" ? item : item.rule || "").join(" "),
        (card.business_rules || []).map(item => typeof item === "string" ? item : item.rule || "").join(" "),
        (card.public_api || []).map(item => item.name || "").join(" "),
        (card.side_effects || []).join(" ")
      );
      stats.modules++;

      summaries[card.key] = {
        purpose: moduleRow.purpose,
        conventions: (card.conventions || []).slice(0, 3).map(item => typeof item === "string" ? item : item.rule || ""),
        business_rules: (card.business_rules || []).slice(0, 3).map(item => typeof item === "string" ? item : item.rule || ""),
        fan_in: 0
      };

      for (const file of card.files || []) {
        fileModules[file] = { module: card.key, dependents: [], fan_in: 0 };
      }

      for (const dep of normalizeModuleRefs(card.dependencies).filter(moduleKey => knownModuleKeys.has(moduleKey))) {
        recordEdge(card.key, dep, "imports", 1);
      }
      for (const dep of normalizeModuleRefs(card.dependents).filter(moduleKey => knownModuleKeys.has(moduleKey))) {
        recordEdge(dep, card.key, "imports", 1);
      }

      for (const func of card.function_cards || []) {
        registerSymbol(card.key, func, "function");
      }
      for (const api of card.public_api || []) {
        registerSymbol(card.key, api, "function");
      }
    }
  });
  insertModules();
}

const submodulesDir = join(sonarDir, "submodules");
if (existsSync(submodulesDir)) {
  const submoduleFiles = readdirSync(submodulesDir).filter(f => f.endsWith(".json"));
  const insertSubmodules = db.transaction(() => {
    for (const subFile of submoduleFiles) {
      let card;
      try {
        card = JSON.parse(readFileSync(join(submodulesDir, subFile), "utf8"));
      } catch (err) {
        console.error(`Skipping malformed submodule JSON ${subFile}: ${err.message}`);
        continue;
      }
      if (!card.key || !card.parent_module_key || !card.cluster_name || !card.cluster_slug) {
        console.error(`Skipping submodule ${subFile}: missing required fields (key, parent_module_key, cluster_name, cluster_slug)`);
        continue;
      }
      insertSubmodule.run(
        card.key,
        card.parent_module_key,
        card.cluster_name,
        card.cluster_slug,
        card.purpose || "",
        card.analyzed_at || null
      );
      insertSubmoduleFts.run(
        card.key,
        card.cluster_name,
        card.purpose || "",
        extractRuleTexts(card.business_rules).join(" "),
        extractRuleTexts(card.conventions).join(" "),
        (card.public_api || []).map(a => a.name || "").join(" ")
      );
      // Register symbols under the submodule's own key (not parent_module_key)
      // so deduplication works correctly across sibling submodules.
      for (const func of card.function_cards || []) {
        registerSymbol(card.key, func, "function");
      }
      for (const api of card.public_api || []) {
        registerSymbol(card.key, api, "function");
      }
      stats.submodules++;
    }
  });
  insertSubmodules();
}

for (const [moduleKey, moduleInfo] of Object.entries(skeleton.modules || {})) {
  if (moduleKey.startsWith("_test_") || moduleRows.has(moduleKey)) continue;
  moduleRows.set(moduleKey, {
    key: moduleKey,
    name: moduleKey,
    path: inferModulePath(moduleKey, moduleInfo.files || []),
    purpose: "",
    complexity: "",
    analyzed_at: null
  });
}
phaseDurations.load_modules_ms = toFixedNumber(performance.now() - modulesStartedAt);

const flowsDir = join(sonarDir, "flows");
const flowsStartedAt = performance.now();
if (existsSync(flowsDir)) {
  const flowFiles = readdirSync(flowsDir).filter(file => file.endsWith(".json"));

  const insertFlows = db.transaction(() => {
    for (const flowFile of flowFiles) {
      const rawFlow = JSON.parse(readFileSync(join(flowsDir, flowFile), "utf8"));
      const flow = normalizeFlow(rawFlow);
      flowRecords.push(flow);

      insertFlow.run(
        flow.name,
        flow.title,
        flow.summary,
        flow.entry.file || null,
        flow.entry.function || null,
        flow.steps.length,
        flow.confidence,
        rawFlow.analyzed_at || null
      );

      const stepsText = flow.steps.map(step => `${step.module} ${step.function} ${step.what} ${step.data}`).join(" ");
      const invariantsText = flow.invariants.map(item => item.text).join(" ");
      const failureModesText = flow.failure_modes.map(item => item.text).join(" ");
      const moduleKeys = [...new Set(flow.steps.map(step => step.module))];

      insertFlowFts.run(
        flow.name,
        flow.title,
        flow.summary,
        stepsText,
        invariantsText,
        failureModesText,
        moduleKeys.join(" ")
      );

      stats.flows++;

      for (const step of flow.steps) {
        insertStep.run(
          flow.name,
          step.order,
          step.module,
          step.function,
          step.file,
          step.what,
          step.data,
          step.confidence,
          JSON.stringify(step.evidence)
        );
        stats.flow_steps++;
      }
    }
  });
  insertFlows();
}
phaseDurations.load_flows_ms = toFixedNumber(performance.now() - flowsStartedAt);

const systemFactsStartedAt = performance.now();
const systemFacts = buildSystemFacts(systemJson);
const insertSystemFacts = db.transaction(() => {
  for (const fact of systemFacts) {
    insertSystemFact.run(
      fact.id,
      fact.kind,
      fact.title,
      fact.detail,
      fact.scope,
      fact.confidence,
      fact.check_cmd,
      fact.evidence_json
    );
    insertSystemFactFts.run(
      fact.id,
      fact.kind,
      fact.title,
      fact.detail,
      fact.scope,
      fact.module_keys.join(" ")
    );
    for (const moduleKey of fact.module_keys) {
      insertSystemFactModule.run(fact.id, moduleKey);
    }
    stats.system_facts++;
  }
});
insertSystemFacts();
phaseDurations.load_system_facts_ms = toFixedNumber(performance.now() - systemFactsStartedAt);

const freshnessStartedAt = performance.now();
const freshness = freshnessRowsFromState(state);

const insertFreshness = db.transaction(() => {
  for (const freshnessMap of [freshness.module, freshness.flow, freshness.system]) {
    for (const item of freshnessMap.values()) {
      insertArtifactFreshness.run(item.artifact_type, item.artifact_key, item.status, item.reason, item.updated_at);
    }
  }
});
insertFreshness();
phaseDurations.load_freshness_ms = toFixedNumber(performance.now() - freshnessStartedAt);

const ftsStartedAt = performance.now();
db.exec("INSERT INTO symbols_fts (name, purpose, signature, module_key) SELECT name, purpose, signature, module_key FROM symbols");
phaseDurations.populate_fts_ms = toFixedNumber(performance.now() - ftsStartedAt);

const lookupsStartedAt = performance.now();
const moduleDependents = new Map();
const moduleDependencies = new Map();

for (const moduleKey of moduleRows.keys()) {
  const dependents = Array.from(incomingByTarget.get(moduleKey) || []).sort();
  const dependencies = Array.from(outgoingBySource.get(moduleKey) || []).sort();
  moduleDependents.set(moduleKey, dependents);
  moduleDependencies.set(moduleKey, dependencies);

  if (summaries[moduleKey]) {
    summaries[moduleKey].fan_in = dependents.length;
  }
}

for (const info of Object.values(fileModules)) {
  info.dependents = moduleDependents.get(info.module) || [];
  info.fan_in = info.dependents.length;
}
phaseDurations.compute_lookup_maps_ms = toFixedNumber(performance.now() - lookupsStartedAt);

const reverseImportsStartedAt = performance.now();
const symbolImports = {};
let reverseImportMatches = 0;

if (existsSync(skeletonPath)) {
  const skFiles = skeleton.files || {};
  const pathIndex = buildPathIndex(skFiles);
  const exportNamesByFile = new Map(
    Object.entries(skFiles).map(([filePath, info]) => [filePath, new Set((info.exports || []).map(exp => exp.name))])
  );

  for (const [filePath, fileInfo] of Object.entries(skFiles)) {
    for (const imp of fileInfo.imports || []) {
      if (imp.kind !== "internal") continue;

      const targetFile = resolveImport(imp.source, filePath, pathIndex);
      if (!targetFile || targetFile === filePath) continue;

      const targetExports = exportNamesByFile.get(targetFile) || new Set();
      const defaultExportName = defaultExportNameByFile.get(targetFile) || null;

      for (const name of imp.names || []) {
        if (name === "*") continue;

        let targetName = name;
        if (targetExports.size === 0 && defaultExportName && (imp.names || []).length === 1) {
          targetName = defaultExportName;
        } else if (targetExports.size > 0 && !targetExports.has(name)) {
          if (defaultExportName && (imp.names || []).length === 1) {
            targetName = defaultExportName;
          } else {
            continue;
          }
        }

        if (!symbolImports[targetFile]) symbolImports[targetFile] = {};
        if (!symbolImports[targetFile][targetName]) symbolImports[targetFile][targetName] = [];
        symbolImports[targetFile][targetName].push({
          file: filePath,
          module: fileInfo.module_key,
          line: imp.line
        });
        reverseImportMatches++;
      }
    }
  }
}
phaseDurations.reverse_imports_ms = toFixedNumber(performance.now() - reverseImportsStartedAt);

const writeLookupsStartedAt = performance.now();
writeFileSync(join(sonarDir, "summaries.json"), JSON.stringify(summaries, null, 2));
writeFileSync(join(sonarDir, "file-modules.json"), JSON.stringify(fileModules, null, 2));
writeFileSync(join(sonarDir, "symbol-imports.json"), JSON.stringify(symbolImports, null, 2));

buildAgentBriefArtifacts({
  sonarDir,
  moduleRows,
  moduleCardsByKey,
  moduleDependencies,
  moduleDependents,
  symbolsByModule,
  flows: flowRecords,
  systemFacts,
  freshness,
  skeletonModules: skeleton.modules
});
phaseDurations.write_lookup_files_ms = toFixedNumber(performance.now() - writeLookupsStartedAt);

db.close();

writePerfSection(sonarDir, "db", {
  total_duration_ms: toFixedNumber(performance.now() - overallStartedAt),
  phases: phaseDurations,
  files: stats.files,
  modules: stats.modules,
  symbols: stats.symbols,
  edges: stats.edges,
  flows: stats.flows,
  flow_steps: stats.flow_steps,
  system_facts: stats.system_facts,
  reverse_import_matches: reverseImportMatches,
  rss_mb: snapshotMemoryMb()
});

const symbolImportCount = Object.values(symbolImports).reduce((sum, symbols) => sum + Object.keys(symbols).length, 0);
console.log(`Graph DB built: ${stats.files} files, ${stats.modules} modules, ${stats.submodules} submodules, ${stats.symbols} symbols, ${stats.edges} edges, ${stats.file_edges} file edges, ${stats.flows} flows, ${stats.flow_steps} flow steps`);
console.log(`Lookup files written: summaries.json (${Object.keys(summaries).length} modules), file-modules.json (${Object.keys(fileModules).length} files), symbol-imports.json (${symbolImportCount} symbols)`);
